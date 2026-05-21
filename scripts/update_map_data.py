#!/usr/bin/env python3
"""Fetch active LandMatch Parcels from Notion for LandHub Big Map."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import requests

NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2026-03-11"
NOTION_RETRYABLE_STATUS_CODES = {429, 502, 503, 504}
NOTION_MAX_ATTEMPTS = 5
NOTION_BASE_BACKOFF_SECONDS = 1.5
DECIMAL_COORD_RE = re.compile(r"(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)")
LANDMATCH_URL = (
    "https://www.notion.so/30649a17ea97804c8acac49da41511e5"
    "?v=30649a17ea9780058dd9000c82bc6059&source=copy_link"
)
LANDMATCH_META = {"symbol": "💛", "color": "#e0b21b"}


@dataclass(frozen=True)
class NotionSource:
    key: str
    label: str
    database_url: str
    filter_payload: dict[str, Any] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", required=True, help="Notion API token")
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parents[1] / "data" / "parcels.json"),
        help="Output JSON path",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = requests.Session()
    headers = {
        "Authorization": f"Bearer {args.token.strip()}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }

    source = NotionSource(
        key="landmatch",
        label="LandMatch",
        database_url=LANDMATCH_URL,
        filter_payload={"property": "Status", "select": {"equals": "active"}},
    )
    pages = fetch_database_pages(source, headers=headers, session=session)
    items = [
        item
        for page in pages
        if (item := normalize_page(source.key, page, session=session)) is not None
    ]
    items.sort(key=lambda item: (str(item.get("name") or "").lower(), str(item.get("id") or "")))

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "LandMatch Parcels",
        "filter": {"Status": "active"},
        "counts": {"landmatch": len(items)},
        "categories": {"landmatch": items},
    }

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(items)} LandMatch markers to {output_path}")
    return 0


def fetch_database_pages(
    source: NotionSource,
    *,
    headers: dict[str, str],
    session: requests.Session,
) -> list[dict[str, Any]]:
    database_id = extract_notion_database_id(source.database_url)
    response = notion_request(
        session,
        "GET",
        f"{NOTION_API_BASE}/databases/{database_id}",
        headers=headers,
        timeout=30,
    )
    database = response.json()
    data_source_id = database["data_sources"][0]["id"]

    results: list[dict[str, Any]] = []
    next_cursor: str | None = None
    while True:
        payload: dict[str, Any] = {"page_size": 100}
        if source.filter_payload is not None:
            payload["filter"] = source.filter_payload
        if next_cursor:
            payload["start_cursor"] = next_cursor

        page = notion_request(
            session,
            "POST",
            f"{NOTION_API_BASE}/data_sources/{data_source_id}/query",
            headers=headers,
            json=payload,
            timeout=60,
        ).json()
        results.extend(page.get("results", []))
        if not page.get("has_more"):
            break
        next_cursor = page.get("next_cursor")
    return results


def notion_request(
    session: requests.Session,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    timeout: int,
    json: dict[str, Any] | None = None,
) -> requests.Response:
    last_error: Exception | None = None
    response: requests.Response | None = None
    for attempt in range(1, NOTION_MAX_ATTEMPTS + 1):
        try:
            response = session.request(
                method,
                url,
                headers=headers,
                json=json,
                timeout=timeout,
            )
            if response.status_code not in NOTION_RETRYABLE_STATUS_CODES:
                response.raise_for_status()
                return response
            last_error = requests.HTTPError(
                f"Notion API returned retryable status {response.status_code} for {url}",
                response=response,
            )
        except requests.RequestException as exc:
            response = getattr(exc, "response", None)
            status_code = response.status_code if response is not None else None
            if status_code not in NOTION_RETRYABLE_STATUS_CODES and status_code is not None:
                raise
            if status_code is None and attempt == NOTION_MAX_ATTEMPTS:
                raise
            last_error = exc

        if attempt == NOTION_MAX_ATTEMPTS:
            break

        retry_after = _parse_retry_after_seconds(
            response.headers.get("Retry-After") if response is not None else None
        )
        delay_seconds = retry_after if retry_after is not None else NOTION_BASE_BACKOFF_SECONDS * attempt
        print(
            f"Notion request failed on attempt {attempt}/{NOTION_MAX_ATTEMPTS} "
            f"for {method} {url}; retrying in {delay_seconds:.1f}s",
            flush=True,
        )
        time.sleep(delay_seconds)

    if last_error is not None:
        raise last_error
    raise RuntimeError(f"Notion request failed without an error object for {method} {url}")


def _parse_retry_after_seconds(raw_value: str | None) -> float | None:
    if raw_value is None:
        return None
    try:
        value = float(raw_value.strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def normalize_page(
    source_key: str,
    page: dict[str, Any],
    *,
    session: requests.Session,
) -> dict[str, Any] | None:
    properties = page.get("properties") or {}
    map_url = extract_url(properties.get("Мапа"))
    if not map_url:
        return None

    resolved_map_url = resolve_maps_url(map_url, session=session)
    try:
        latitude, longitude = extract_coordinates_from_maps_url(resolved_map_url)
    except ValueError:
        return None

    marker = LANDMATCH_META
    return {
        "id": str(page.get("id") or ""),
        "source": source_key,
        "name": (extract_title(properties.get("Name")) or "Без назви").strip(),
        "cadastral": extract_rich_text(properties.get("Кадастровий номер")).strip(),
        "area": (extract_rich_text(properties.get("Площа")) or "—").strip(),
        "purpose": (extract_rich_text(properties.get("Цільове призначення")) or "—").strip(),
        "distance_to_kyiv": (extract_rich_text(properties.get("до Києва")) or "—").strip(),
        "photo_url": extract_file_url(properties.get("Photo")),
        "price": (extract_rich_text(properties.get("Наша ціна")) or "—").strip(),
        "google_maps_url": resolved_map_url,
        "notion_url": str(page.get("url") or "").strip(),
        "olx_url": extract_url(properties.get("Посилання на OLX")),
        "latitude": latitude,
        "longitude": longitude,
        "marker_symbol": marker["symbol"],
        "marker_color": marker["color"],
    }


def extract_notion_database_id(value: str) -> str:
    parsed = urlparse((value or "").strip())
    candidate = parsed.path.rsplit("/", 1)[-1] if parsed.scheme and parsed.netloc else value
    cleaned = re.sub(r"[^0-9a-fA-F]", "", candidate or "")
    if len(cleaned) != 32:
        raise RuntimeError(f"Invalid Notion database id: {value}")
    return (
        f"{cleaned[:8]}-{cleaned[8:12]}-{cleaned[12:16]}-"
        f"{cleaned[16:20]}-{cleaned[20:]}"
    ).lower()


def extract_title(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return "".join(item.get("plain_text", "") for item in property_value.get("title", []))


def extract_rich_text(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return "".join(item.get("plain_text", "") for item in property_value.get("rich_text", []))


def extract_url(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    return str(property_value.get("url") or "").strip()


def extract_file_url(property_value: dict[str, Any] | None) -> str:
    if not property_value:
        return ""
    files = property_value.get("files") or []
    for item in files:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "external":
            url = (item.get("external") or {}).get("url")
        elif item.get("type") == "file":
            url = (item.get("file") or {}).get("url")
        else:
            url = ""
        if url:
            return str(url).strip()
    return ""


def resolve_maps_url(url: str, *, session: requests.Session) -> str:
    normalized = url.strip()
    if not normalized:
        return ""
    if "://" not in normalized:
        normalized = f"https://{normalized.lstrip('/')}"
    parsed = urlparse(normalized)
    if parsed.netloc != "maps.app.goo.gl":
        return normalized

    try:
        response = session.get(normalized, timeout=30, allow_redirects=True)
        response.raise_for_status()
        return response.url or normalized
    except requests.RequestException:
        return normalized


def extract_coordinates_from_maps_url(url: str) -> tuple[float, float]:
    normalized = url.strip()
    if not normalized:
        raise ValueError("missing maps url")
    if "://" not in normalized:
        normalized = f"https://{normalized.lstrip('/')}"

    parsed = urlparse(normalized)
    query = parse_qs(parsed.query)
    for key in ("query", "ll", "q"):
        for candidate in query.get(key, []):
            match = DECIMAL_COORD_RE.search(unquote(candidate))
            if match:
                return float(match.group(1)), float(match.group(2))

    for candidate in (parsed.path, unquote(parsed.path), normalized):
        match = re.search(r"@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)", candidate)
        if match:
            return float(match.group(1)), float(match.group(2))

    match = DECIMAL_COORD_RE.search(unquote(normalized))
    if match:
        return float(match.group(1)), float(match.group(2))

    raise ValueError(f"cannot parse coordinates from {url}")


if __name__ == "__main__":
    raise SystemExit(main())
