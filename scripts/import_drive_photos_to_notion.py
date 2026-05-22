#!/usr/bin/env python3
"""One-off import of public Google Drive photos into LandMatch Notion rows."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import mimetypes
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import requests

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - server dependency can be absent.
    Image = None
    ImageOps = None

NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2026-03-11"
LANDMATCH_URL = (
    "https://www.notion.so/30649a17ea97804c8acac49da41511e5"
    "?v=30649a17ea9780058dd9000c82bc6059&source=copy_link"
)
EXTRA_PHOTOS_PROPERTY = "Фотографії"
DRIVE_LINK_PROPERTIES = ("посилання на фото", "Посилання на фото")
MAX_PHOTOS_PER_PAGE = 10
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
PHOTO_MAX_SIDE = 1600
PHOTO_JPEG_QUALITY = 82


@dataclass
class ImportStats:
    scanned: int = 0
    with_drive_link: int = 0
    skipped_existing_photos: int = 0
    skipped_closed_or_empty: int = 0
    updated_pages: int = 0
    uploaded_photos: int = 0
    failed_pages: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", default=os.getenv("NOTION_TOKEN", ""), help="Notion API token")
    parser.add_argument("--limit", type=int, default=0, help="Optional max pages to update")
    parser.add_argument("--dry-run", action="store_true", help="Do not upload or update Notion")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = args.token.strip()
    if not token:
        raise SystemExit("Notion token is required via --token or NOTION_TOKEN")

    session = requests.Session()
    headers = notion_headers(token)
    data_source_id = get_data_source_id(session, headers)
    pages = query_pages(session, headers, data_source_id)
    stats = ImportStats(scanned=len(pages))
    updated_names: list[str] = []

    with tempfile.TemporaryDirectory(prefix="landhub-drive-photos-") as tmp_dir:
        tmp_path = Path(tmp_dir)
        for page in pages:
            properties = page.get("properties") or {}
            drive_links = []
            for property_name in DRIVE_LINK_PROPERTIES:
                drive_links.extend(extract_links(properties.get(property_name)))
            drive_links = dedupe(drive_links)
            if not drive_links:
                continue
            stats.with_drive_link += 1

            if extract_file_refs(properties.get(EXTRA_PHOTOS_PROPERTY)):
                stats.skipped_existing_photos += 1
                continue

            name = extract_title(properties) or str(page.get("id") or "")
            try:
                files = collect_drive_images(session, drive_links, tmp_path, MAX_PHOTOS_PER_PAGE)
            except Exception as exc:  # noqa: BLE001
                print(f"SKIP {name}: cannot read Drive links: {exc}", flush=True)
                stats.failed_pages += 1
                continue

            if not files:
                stats.skipped_closed_or_empty += 1
                print(f"SKIP {name}: no downloadable images", flush=True)
                continue

            if args.dry_run:
                print(f"DRY {name}: would upload {len(files)} photos", flush=True)
            else:
                upload_ids = []
                uploaded_paths = []
                for file_path in files:
                    try:
                        upload_ids.append(upload_file(session, headers, file_path))
                        uploaded_paths.append(file_path)
                    except Exception as exc:  # noqa: BLE001
                        print(f"SKIP FILE {name}: {file_path.name}: {exc}", flush=True)
                if not upload_ids:
                    stats.skipped_closed_or_empty += 1
                    print(f"SKIP {name}: no files uploaded", flush=True)
                    continue
                update_page_files(session, headers, str(page["id"]), upload_ids, uploaded_paths)
                files = uploaded_paths
                print(f"UPDATED {name}: uploaded {len(files)} photos", flush=True)

            stats.updated_pages += 1
            stats.uploaded_photos += len(files)
            updated_names.append(name)
            if args.limit and stats.updated_pages >= args.limit:
                break

    print(json.dumps({"stats": stats.__dict__, "updated": updated_names}, ensure_ascii=False, indent=2))
    return 0


def notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def notion_request(
    session: requests.Session,
    method: str,
    url: str,
    headers: dict[str, str],
    **kwargs: Any,
) -> requests.Response:
    for attempt in range(1, 6):
        response = session.request(method, url, headers=headers, timeout=60, **kwargs)
        if response.status_code not in {429, 502, 503, 504}:
            response.raise_for_status()
            return response
        time.sleep(float(response.headers.get("Retry-After") or attempt * 1.5))
    response.raise_for_status()
    return response


def get_data_source_id(session: requests.Session, headers: dict[str, str]) -> str:
    database_id = extract_notion_database_id(LANDMATCH_URL)
    database = notion_request(
        session,
        "GET",
        f"{NOTION_API_BASE}/databases/{database_id}",
        headers,
    ).json()
    return str(database["data_sources"][0]["id"])


def query_pages(session: requests.Session, headers: dict[str, str], data_source_id: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    next_cursor: str | None = None
    while True:
        payload: dict[str, Any] = {
            "page_size": 100,
            "filter": {"property": "Status", "select": {"equals": "active"}},
        }
        if next_cursor:
            payload["start_cursor"] = next_cursor
        page = notion_request(
            session,
            "POST",
            f"{NOTION_API_BASE}/data_sources/{data_source_id}/query",
            headers,
            json=payload,
        ).json()
        results.extend(page.get("results", []))
        if not page.get("has_more"):
            break
        next_cursor = page.get("next_cursor")
    return results


def extract_links(property_value: dict[str, Any] | None) -> list[str]:
    if not property_value:
        return []
    links: list[str] = []
    if property_value.get("type") == "url":
        url = property_value.get("url")
        if url:
            links.append(str(url).strip())
    if property_value.get("type") == "rich_text":
        for part in property_value.get("rich_text") or []:
            href = part.get("href")
            text = part.get("plain_text")
            for value in (href, text):
                if value and "drive.google.com" in str(value):
                    links.append(str(value).strip())
    return dedupe(links)


def extract_file_refs(property_value: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not property_value or property_value.get("type") != "files":
        return []
    files = property_value.get("files")
    return [item for item in files if isinstance(item, dict)] if isinstance(files, list) else []


def extract_title(properties: dict[str, Any]) -> str:
    for value in properties.values():
        if isinstance(value, dict) and value.get("type") == "title":
            return "".join(part.get("plain_text", "") for part in value.get("title") or []).strip()
    return ""


def collect_drive_images(
    session: requests.Session,
    links: list[str],
    target_dir: Path,
    max_count: int,
) -> list[Path]:
    file_ids: list[str] = []
    for link in links:
        parsed = parse_drive_link(link)
        if parsed["kind"] == "file":
            file_ids.append(parsed["id"])
        elif parsed["kind"] == "folder":
            file_ids.extend(list_drive_folder_file_ids(session, parsed["id"]))
        if len(file_ids) >= max_count:
            break

    paths: list[Path] = []
    for file_id in dedupe(file_ids)[:max_count]:
        path = download_drive_file(session, file_id, target_dir)
        if path:
            paths.append(path)
    return paths


def parse_drive_link(url: str) -> dict[str, str]:
    parsed = urlparse(url.strip())
    query = parse_qs(parsed.query)
    if "/folders/" in parsed.path:
        return {"kind": "folder", "id": parsed.path.split("/folders/", 1)[1].split("/", 1)[0]}
    if "/file/d/" in parsed.path:
        return {"kind": "file", "id": parsed.path.split("/file/d/", 1)[1].split("/", 1)[0]}
    if query.get("id"):
        return {"kind": "file", "id": query["id"][0]}
    raise ValueError(f"unsupported Google Drive link: {url}")


def list_drive_folder_file_ids(session: requests.Session, folder_id: str) -> list[str]:
    embedded = session.get(
        f"https://drive.google.com/embeddedfolderview?id={folder_id}#grid",
        timeout=45,
    )
    if embedded.ok:
        embedded_ids = re.findall(r"/file/d/([a-zA-Z0-9_-]+)", embedded.text)
        if embedded_ids:
            return dedupe(embedded_ids)

    response = session.get(f"https://drive.google.com/drive/folders/{folder_id}", timeout=45)
    response.raise_for_status()
    html = response.text
    candidates = re.findall(r'\["([a-zA-Z0-9_-]{20,})","([^"]+?)"', html)
    file_ids: list[str] = []
    for file_id, encoded_name in candidates:
        name = unquote(encoded_name).lower()
        if Path(name).suffix in IMAGE_EXTENSIONS or re.search(r'\.(jpe?g|png|webp|heic|heif)(?:\\|$)', name):
            file_ids.append(file_id)
    if not file_ids:
        # Fallback: public folder pages still expose file ids; download later filters non-images.
        file_ids = re.findall(r'"([a-zA-Z0-9_-]{25,})"', html)
    return dedupe(file_ids)


def download_drive_file(session: requests.Session, file_id: str, target_dir: Path) -> Path | None:
    url = "https://drive.google.com/uc"
    response = session.get(url, params={"export": "download", "id": file_id}, timeout=60)
    response.raise_for_status()

    token = find_confirm_token(response)
    if token:
        response = session.get(
            url,
            params={"export": "download", "confirm": token, "id": file_id},
            timeout=60,
        )
        response.raise_for_status()

    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if not content_type.startswith("image/"):
        return None

    extension = mimetypes.guess_extension(content_type) or ".jpg"
    if extension == ".jpe":
        extension = ".jpg"
    target_dir.mkdir(parents=True, exist_ok=True)
    original_path = target_dir / f"drive-{file_id}{extension}"
    original_path.write_bytes(response.content)
    return optimize_drive_image(original_path, target_dir, file_id)


def optimize_drive_image(path: Path, target_dir: Path, file_id: str) -> Path:
    if Image is None or ImageOps is None:
        return path
    output_path = target_dir / f"drive-{file_id}.jpg"
    try:
        with Image.open(path) as image:
            base = ImageOps.exif_transpose(image).convert("RGB")
            base.thumbnail((PHOTO_MAX_SIDE, PHOTO_MAX_SIDE), Image.Resampling.LANCZOS)
            base.save(output_path, "JPEG", quality=PHOTO_JPEG_QUALITY, optimize=True)
    except Exception:
        return path
    return output_path


def find_confirm_token(response: requests.Response) -> str:
    for key, value in response.cookies.items():
        if key.startswith("download_warning"):
            return value
    match = re.search(r"confirm=([0-9A-Za-z_]+)", response.text)
    return match.group(1) if match else ""


def upload_file(session: requests.Session, headers: dict[str, str], path: Path) -> str:
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    upload = notion_request(
        session,
        "POST",
        f"{NOTION_API_BASE}/file_uploads",
        headers,
        json={"mode": "single_part", "filename": path.name, "content_type": content_type},
    ).json()
    send_headers = {key: value for key, value in headers.items() if key.lower() != "content-type"}
    with path.open("rb") as fh:
        response = session.post(
            f"{NOTION_API_BASE}/file_uploads/{upload['id']}/send",
            headers=send_headers,
            files={"file": (path.name, fh, content_type)},
            timeout=90,
        )
    response.raise_for_status()
    payload = response.json()
    if payload.get("status") != "uploaded":
        raise RuntimeError(f"Notion upload failed for {path}: {payload}")
    return str(payload["id"])


def update_page_files(
    session: requests.Session,
    headers: dict[str, str],
    page_id: str,
    upload_ids: list[str],
    file_paths: list[Path],
) -> None:
    files = [
        {
            "type": "file_upload",
            "name": path.name,
            "file_upload": {"id": upload_id},
        }
        for upload_id, path in zip(upload_ids, file_paths)
    ]
    notion_request(
        session,
        "PATCH",
        f"{NOTION_API_BASE}/pages/{page_id}",
        headers,
        json={"properties": {EXTRA_PHOTOS_PROPERTY: {"files": files}}},
    )


def extract_notion_database_id(value: str) -> str:
    parsed = urlparse(value.strip())
    compact = re.sub(r"[^0-9a-fA-F]", "", parsed.path)
    if len(compact) < 32:
        raise ValueError(f"Cannot extract Notion database id from {value}")
    return compact[-32:]


def dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value).strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
