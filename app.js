const TELEGRAM_URL = "https://t.me/landhub_daniil";

const map = L.map("map", {
  zoomControl: true,
  scrollWheelZoom: true,
}).setView([50.28, 30.44], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

const layoutNode = document.getElementById("map-layout");
const panelNode = document.getElementById("parcel-panel");
const panelContentNode = document.getElementById("panel-content");
const panelCloseNode = document.getElementById("panel-close");

let dataset = { categories: { landmatch: [] } };
let markerLayer = L.layerGroup().addTo(map);
let markerRefs = new Map();
let selectedId = "";

function normalizeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  return raw.includes("://") ? raw : `https://${raw.replace(/^\/+/, "")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markerIcon(item, isSelected = false) {
  const color = isSelected ? "#2aa84a" : escapeHtml(item.marker_color || "#e0b21b");
  const symbol = isSelected ? "💚" : escapeHtml(item.marker_symbol || "💛");
  return L.divIcon({
    className: "parcel-marker",
    html: `<div class="emoji-pin" style="--marker-accent:${color}">${symbol}</div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

function detailRow(label, value) {
  return `
    <div class="detail-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "—")}</strong>
    </div>
  `;
}

function actionButton({ href, icon, label, modifier }) {
  const normalizedHref = normalizeUrl(href);
  if (!normalizedHref) return "";
  return `
    <a
      class="action-link action-link--${modifier}"
      href="${escapeHtml(normalizedHref)}"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="${escapeHtml(label)}"
      title="${escapeHtml(label)}"
    >
      <img src="./assets/${escapeHtml(icon)}" alt="" />
      <span>${escapeHtml(label)}</span>
    </a>
  `;
}

function panelMarkup(item) {
  const photoUrl = normalizeUrl(item.photo_url);
  const photoMarkup = photoUrl
    ? `
      <figure class="parcel-photo">
        <img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(item.name)}" loading="lazy" />
      </figure>
    `
    : "";

  return `
    <article class="parcel-details">
      <h2>${escapeHtml(item.name || "Без назви")}</h2>
      <div class="details-list">
        ${detailRow("Кадастровий номер", item.cadastral)}
        ${detailRow("Площа", item.area)}
        ${detailRow("Цільове призначення", item.purpose)}
        ${detailRow("До Києва", item.distance_to_kyiv)}
      </div>
      ${photoMarkup}
      <div class="price-card">
        <span>Ціна</span>
        <strong>${escapeHtml(item.price || "—")}</strong>
      </div>
      <div class="panel-actions">
        ${actionButton({
          href: item.google_maps_url,
          icon: "IMG_5575.PNG",
          label: "Google Maps",
          modifier: "maps",
        })}
        ${actionButton({
          href: TELEGRAM_URL,
          icon: "telegram.png",
          label: "Telegram",
          modifier: "telegram",
        })}
      </div>
    </article>
  `;
}

function getLandmatchItems() {
  return Array.isArray(dataset.categories?.landmatch)
    ? dataset.categories.landmatch
    : [];
}

function setSelectedMarker(nextId) {
  if (selectedId && markerRefs.has(selectedId)) {
    const previous = markerRefs.get(selectedId);
    previous.marker.setIcon(markerIcon(previous.item, false));
  }

  selectedId = nextId || "";

  if (selectedId && markerRefs.has(selectedId)) {
    const current = markerRefs.get(selectedId);
    current.marker.setIcon(markerIcon(current.item, true));
  }
}

function openPanel(item) {
  panelContentNode.innerHTML = panelMarkup(item);
  panelNode.setAttribute("aria-hidden", "false");
  layoutNode.classList.add("panel-open");
  setSelectedMarker(item.id);
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function closePanel() {
  panelNode.setAttribute("aria-hidden", "true");
  layoutNode.classList.remove("panel-open");
  setSelectedMarker("");
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function renderMarkers() {
  markerLayer.clearLayers();
  markerRefs = new Map();
  const items = getLandmatchItems();

  if (items.length === 0) {
    panelContentNode.innerHTML = '<div class="panel-empty">Немає активних ділянок для карти.</div>';
    return;
  }

  const bounds = [];
  items.forEach((item) => {
    const lat = Number(item.latitude);
    const lng = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const marker = L.marker([lat, lng], {
      icon: markerIcon(item, item.id === selectedId),
      riseOnHover: true,
    });
    marker.on("click", () => openPanel(item));
    marker.addTo(markerLayer);
    markerRefs.set(item.id, { marker, item });
    bounds.push([lat, lng]);
  });

  if (bounds.length > 0) {
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 12 });
  }
}

async function loadData() {
  const response = await fetch("./data/parcels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load parcels.json: ${response.status}`);
  }
  return response.json();
}

function registerEvents() {
  panelCloseNode.addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePanel();
    }
  });
}

async function bootstrap() {
  registerEvents();

  try {
    dataset = await loadData();
    renderMarkers();
  } catch (error) {
    console.error(error);
    panelContentNode.innerHTML = '<div class="panel-empty">Не вдалося завантажити дані карти.</div>';
  }
}

void bootstrap();
