const TELEGRAM_URL = "https://t.me/landhub_daniil";
const PHONE_URL = "tel:+380687155996";

const FILTERS = {
  area: { min: 1, max: 100, step: 1 },
  price: { min: 1000, max: 100000, step: 1000 },
};

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
const areaMinInput = document.getElementById("area-min");
const areaMaxInput = document.getElementById("area-max");
const areaMinLabel = document.getElementById("area-min-label");
const areaMaxLabel = document.getElementById("area-max-label");
const areaRangeFill = document.getElementById("area-range-fill");
const priceMinInput = document.getElementById("price-min");
const priceMaxInput = document.getElementById("price-max");
const priceMinLabel = document.getElementById("price-min-label");
const priceMaxLabel = document.getElementById("price-max-label");
const priceRangeFill = document.getElementById("price-range-fill");
const verifiedToggleNode = document.getElementById("verified-toggle");
const mapCountsNode = document.getElementById("map-counts");
const lightboxNode = document.getElementById("photo-lightbox");
const lightboxImageNode = document.getElementById("lightbox-image");
const lightboxCloseNode = document.getElementById("lightbox-close");
const lightboxZoomInNode = document.getElementById("lightbox-zoom-in");
const lightboxZoomOutNode = document.getElementById("lightbox-zoom-out");
const lightboxZoomResetNode = document.getElementById("lightbox-zoom-reset");
const lightboxStageNode = document.getElementById("lightbox-stage");
const lightboxPrevNode = document.getElementById("lightbox-prev");
const lightboxNextNode = document.getElementById("lightbox-next");

let dataset = { categories: { landmatch: [] } };
let markerLayer = L.layerGroup().addTo(map);
let markerRefs = new Map();
let selectedId = "";
let lightboxScale = 1;
let lightboxOffset = { x: 0, y: 0 };
let lightboxDrag = null;
let lightboxSwipe = null;
let lightboxPhotos = [];
let lightboxIndex = 0;

const state = {
  areaMin: FILTERS.area.min,
  areaMax: FILTERS.area.max,
  priceMin: FILTERS.price.min,
  priceMax: FILTERS.price.max,
  verifiedOnly: false,
};

function normalizeUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  if (
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("/") ||
    raw.startsWith("#") ||
    raw.startsWith("data:") ||
    raw.startsWith("blob:") ||
    raw.startsWith("tel:") ||
    raw.startsWith("mailto:")
  ) {
    return raw;
  }
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

function formatArea(value) {
  return `${Math.round(value)} ${Math.round(value) === 1 ? "сотка" : "соток"}`;
}

function formatPrice(value) {
  return `${Math.round(value).toLocaleString("uk-UA")}$`;
}

function formatParcelCount(count) {
  const value = Math.abs(Number(count) || 0);
  const lastTwo = value % 100;
  const last = value % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} ділянок`;
  if (last === 1) return `${count} ділянка`;
  if (last >= 2 && last <= 4) return `${count} ділянки`;
  return `${count} ділянок`;
}

function updateMapCounts() {
  if (!mapCountsNode) return;
  const total = getLandmatchItems().length;
  const filtered = getFilteredItems().length;
  mapCountsNode.textContent = `Доступно ${formatParcelCount(total)}. За вашим фільтром ${formatParcelCount(filtered)}`;
}

function markerIcon(item, isSelected = false) {
  const color = isSelected ? "#247eaf" : item.has_verified_photos ? "#2aa84a" : escapeHtml(item.marker_color || "#e0b21b");
  const symbol = isSelected ? "💙" : item.has_verified_photos ? "💚" : escapeHtml(item.marker_symbol || "💛");
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
  const photoUrls = getPhotoUrls(item);
  const previewUrls = photoUrls.slice(0, 4);
  const photoMarkup = previewUrls.length
    ? `
      <div class="photo-grid photo-grid--${Math.min(previewUrls.length, 4)}">
        ${previewUrls.map((url, index) => `
          <button class="parcel-photo" type="button" data-photo-index="${index}" data-photo-title="${escapeHtml(item.name)}">
            <img src="${escapeHtml(url)}" alt="${escapeHtml(item.name)}" loading="lazy" />
          </button>
        `).join("")}
      </div>
    `
    : "";
  const filterWarning = passesFilters(item)
    ? '<div class="filter-warning filter-warning--empty">&nbsp;</div>'
    : '<div class="filter-warning">ця ділянка не підходить під новий фільтр</div>';

  return `
    <article class="parcel-details">
      <h2>${escapeHtml(item.name || "Без назви")}</h2>
      ${filterWarning}
      <div class="details-list">
        ${detailRow("Кадастровий номер", item.cadastral)}
        ${detailRow("Площа", item.area)}
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
        ${item.has_verified_photos ? actionButton({
          href: PHONE_URL,
          icon: "phone.png",
          label: "+380 68 715 59 96",
          modifier: "phone",
        }) : ""}
      </div>
    </article>
  `;
}

function getLandmatchItems() {
  return Array.isArray(dataset.categories?.landmatch)
    ? dataset.categories.landmatch
    : [];
}

function getFilteredItems() {
  return getLandmatchItems().filter(passesFilters);
}

function getPhotoUrls(item) {
  if (Array.isArray(item.photo_urls) && item.photo_urls.length) {
    return item.photo_urls.map(normalizeUrl).filter(Boolean);
  }
  const urls = [];
  const main = normalizeUrl(item.photo_url);
  if (main) urls.push(main);
  if (Array.isArray(item.extra_photo_urls)) {
    item.extra_photo_urls.forEach((url) => {
      const normalized = normalizeUrl(url);
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    });
  }
  return urls;
}

function getItemArea(item) {
  const value = Number(item.area_sotky);
  return Number.isFinite(value) ? value : null;
}

function getItemPrice(item) {
  const value = Number(item.price_usd);
  return Number.isFinite(value) ? value : null;
}

function passesFilters(item) {
  const area = getItemArea(item);
  const price = getItemPrice(item);
  if (area === null || price === null) return false;
  if (state.verifiedOnly && !item.has_verified_photos) return false;
  return (
    area >= state.areaMin &&
    area <= state.areaMax &&
    price >= state.priceMin &&
    price <= state.priceMax
  );
}

function findItemByCadastral(cadastral) {
  const normalized = String(cadastral || "").trim();
  if (!normalized) return null;
  return getLandmatchItems().find((item) => String(item.cadastral || "").trim() === normalized) || null;
}

function findSelectedItem() {
  return getLandmatchItems().find((item) => item.id === selectedId) || null;
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

function updateUrlForItem(item, replace = false) {
  const url = new URL(window.location.href);
  if (item?.cadastral) {
    url.searchParams.set("cad", item.cadastral);
  } else {
    url.searchParams.delete("cad");
  }
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", url);
}

function openPanel(item, { updateUrl = true, replaceUrl = false } = {}) {
  panelContentNode.innerHTML = panelMarkup(item);
  panelNode.setAttribute("aria-hidden", "false");
  layoutNode.classList.add("panel-open");
  setSelectedMarker(item.id);
  if (updateUrl) updateUrlForItem(item, replaceUrl);
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function closePanel({ updateUrl = true } = {}) {
  panelNode.setAttribute("aria-hidden", "true");
  layoutNode.classList.remove("panel-open");
  setSelectedMarker("");
  if (updateUrl) updateUrlForItem(null);
  window.setTimeout(() => map.invalidateSize({ animate: true }), 260);
}

function renderMarkers({ fit = true } = {}) {
  markerLayer.clearLayers();
  markerRefs = new Map();
  const items = getFilteredItems();

  if (items.length === 0) {
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

  if (fit && bounds.length > 0) {
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 12 });
  }
}

function refreshSelectedPanel() {
  const item = findSelectedItem();
  if (!item || panelNode.getAttribute("aria-hidden") === "true") return;
  panelContentNode.innerHTML = panelMarkup(item);
  setSelectedMarker(item.id);
}

function clampRange(kind, changed) {
  const minInput = kind === "area" ? areaMinInput : priceMinInput;
  const maxInput = kind === "area" ? areaMaxInput : priceMaxInput;
  const step = FILTERS[kind].step;
  let minValue = Number(minInput.value);
  let maxValue = Number(maxInput.value);

  if (changed === "min" && minValue >= maxValue) {
    minValue = maxValue - step;
    minInput.value = String(minValue);
  }
  if (changed === "max" && maxValue <= minValue) {
    maxValue = minValue + step;
    maxInput.value = String(maxValue);
  }

  if (kind === "area") {
    state.areaMin = minValue;
    state.areaMax = maxValue;
  } else {
    state.priceMin = minValue;
    state.priceMax = maxValue;
  }
}

function updateRangeUi(kind) {
  const config = FILTERS[kind];
  const minValue = kind === "area" ? state.areaMin : state.priceMin;
  const maxValue = kind === "area" ? state.areaMax : state.priceMax;
  const minLabel = kind === "area" ? areaMinLabel : priceMinLabel;
  const maxLabel = kind === "area" ? areaMaxLabel : priceMaxLabel;
  const fill = kind === "area" ? areaRangeFill : priceRangeFill;
  const formatter = kind === "area" ? formatArea : formatPrice;
  const left = ((minValue - config.min) / (config.max - config.min)) * 100;
  const right = 100 - ((maxValue - config.min) / (config.max - config.min)) * 100;

  minLabel.textContent = formatter(minValue);
  maxLabel.textContent = formatter(maxValue);
  fill.style.left = `${left}%`;
  fill.style.right = `${right}%`;
}

function handleFilterInput(kind, changed) {
  clampRange(kind, changed);
  updateRangeUi(kind);
  updateMapCounts();
  renderMarkers({ fit: true });
  refreshSelectedPanel();
}

async function loadData() {
  const response = await fetch("./data/parcels.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load parcels.json: ${response.status}`);
  }
  return response.json();
}

function openLightbox(urls, index, title) {
  lightboxPhotos = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (!lightboxPhotos.length) return;
  lightboxImageNode.alt = title || "";
  showLightboxPhoto(index || 0);
  lightboxNode.setAttribute("aria-hidden", "false");
}

function showLightboxPhoto(index) {
  if (!lightboxPhotos.length) return;
  lightboxIndex = (index + lightboxPhotos.length) % lightboxPhotos.length;
  lightboxImageNode.src = lightboxPhotos[lightboxIndex];
  lightboxPrevNode.hidden = lightboxPhotos.length < 2;
  lightboxNextNode.hidden = lightboxPhotos.length < 2;
  resetLightboxZoom();
}

function closeLightbox() {
  lightboxNode.setAttribute("aria-hidden", "true");
  lightboxImageNode.removeAttribute("src");
  lightboxPhotos = [];
  lightboxIndex = 0;
}

function applyLightboxTransform() {
  lightboxImageNode.style.transform = `translate(${lightboxOffset.x}px, ${lightboxOffset.y}px) scale(${lightboxScale})`;
}

function zoomLightbox(delta) {
  lightboxScale = Math.min(5, Math.max(1, lightboxScale + delta));
  if (lightboxScale === 1) {
    lightboxOffset = { x: 0, y: 0 };
  }
  applyLightboxTransform();
}

function resetLightboxZoom() {
  lightboxScale = 1;
  lightboxOffset = { x: 0, y: 0 };
  applyLightboxTransform();
}

function registerEvents() {
  panelCloseNode.addEventListener("click", () => closePanel());
  areaMinInput.addEventListener("input", () => handleFilterInput("area", "min"));
  areaMaxInput.addEventListener("input", () => handleFilterInput("area", "max"));
  priceMinInput.addEventListener("input", () => handleFilterInput("price", "min"));
  priceMaxInput.addEventListener("input", () => handleFilterInput("price", "max"));
  verifiedToggleNode.addEventListener("click", () => {
    state.verifiedOnly = !state.verifiedOnly;
    verifiedToggleNode.classList.toggle("is-active", state.verifiedOnly);
    verifiedToggleNode.setAttribute("aria-pressed", state.verifiedOnly ? "true" : "false");
    verifiedToggleNode.innerHTML = state.verifiedOnly
      ? '<span class="verified-toggle-text"><span>Тільки перевірені</span><span>ділянки з фото</span></span><span class="verified-toggle-mark">✅</span>'
      : '<span class="verified-toggle-text"><span>Тільки перевірені</span><span>ділянки з фото</span></span><span class="verified-toggle-mark">▢</span>';
    updateMapCounts();
    renderMarkers({ fit: true });
    refreshSelectedPanel();
  });

  panelContentNode.addEventListener("click", (event) => {
    const button = event.target.closest(".parcel-photo");
    if (!button) return;
    const item = findSelectedItem();
    if (!item) return;
    openLightbox(getPhotoUrls(item), Number(button.dataset.photoIndex || 0), button.dataset.photoTitle);
  });

  lightboxCloseNode.addEventListener("click", closeLightbox);
  lightboxZoomInNode.addEventListener("click", () => zoomLightbox(0.25));
  lightboxZoomOutNode.addEventListener("click", () => zoomLightbox(-0.25));
  lightboxZoomResetNode.addEventListener("click", resetLightboxZoom);
  lightboxPrevNode.addEventListener("click", () => showLightboxPhoto(lightboxIndex - 1));
  lightboxNextNode.addEventListener("click", () => showLightboxPhoto(lightboxIndex + 1));
  lightboxNode.addEventListener("click", (event) => {
    if (event.target === lightboxNode) closeLightbox();
  });
  lightboxStageNode.addEventListener("click", (event) => {
    if (event.target === lightboxStageNode) closeLightbox();
  });
  lightboxStageNode.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomLightbox(event.deltaY < 0 ? 0.15 : -0.15);
  }, { passive: false });
  lightboxStageNode.addEventListener("pointerdown", (event) => {
    const point = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    if (lightboxScale <= 1) {
      lightboxSwipe = point;
      lightboxStageNode.setPointerCapture(event.pointerId);
      return;
    }
    lightboxDrag = {
      ...point,
      offsetX: lightboxOffset.x,
      offsetY: lightboxOffset.y,
    };
    lightboxStageNode.setPointerCapture(event.pointerId);
  });
  lightboxStageNode.addEventListener("pointermove", (event) => {
    if (!lightboxDrag || event.pointerId !== lightboxDrag.pointerId) return;
    lightboxOffset = {
      x: lightboxDrag.offsetX + event.clientX - lightboxDrag.startX,
      y: lightboxDrag.offsetY + event.clientY - lightboxDrag.startY,
    };
    applyLightboxTransform();
  });
  lightboxStageNode.addEventListener("pointerup", (event) => {
    if (lightboxSwipe && event.pointerId === lightboxSwipe.pointerId) {
      const deltaX = event.clientX - lightboxSwipe.startX;
      const deltaY = event.clientY - lightboxSwipe.startY;
      if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        showLightboxPhoto(lightboxIndex + (deltaX < 0 ? 1 : -1));
      }
    }
    lightboxDrag = null;
    lightboxSwipe = null;
  });
  lightboxStageNode.addEventListener("pointercancel", () => {
    lightboxDrag = null;
    lightboxSwipe = null;
  });

  window.addEventListener("popstate", () => {
    const item = findItemByCadastral(new URL(window.location.href).searchParams.get("cad"));
    if (item) {
      openPanel(item, { updateUrl: false });
    } else {
      closePanel({ updateUrl: false });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (lightboxNode.getAttribute("aria-hidden") === "false") {
      if (event.key === "Escape") {
        closeLightbox();
      } else if (event.key === "ArrowLeft") {
        showLightboxPhoto(lightboxIndex - 1);
      } else if (event.key === "ArrowRight") {
        showLightboxPhoto(lightboxIndex + 1);
      }
      return;
    }
    if (event.key !== "Escape") return;
    closePanel();
  });
}

function openInitialDeepLink() {
  const cadastral = new URL(window.location.href).searchParams.get("cad");
  const item = findItemByCadastral(cadastral);
  if (!item) return;
  openPanel(item, { updateUrl: true, replaceUrl: true });
  if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) {
    map.setView([Number(item.latitude), Number(item.longitude)], 14);
  }
}

async function bootstrap() {
  registerEvents();
  updateRangeUi("area");
  updateRangeUi("price");

  try {
    dataset = await loadData();
    updateMapCounts();
    renderMarkers();
    openInitialDeepLink();
  } catch (error) {
    console.error(error);
    panelContentNode.innerHTML = '<div class="panel-empty">Не вдалося завантажити дані карти.</div>';
  }
}

void bootstrap();
