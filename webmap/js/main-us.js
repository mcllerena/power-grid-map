import {
  ISO_RECONDUCTORING_CONFIG,
  buildReconductoringPopupHtml,
} from "./reconductoring-us.js";

// Canvas-rendered square marker with diagonal line (substation symbol)
const SquareMarker = L.CircleMarker.extend({
  _updatePath() {
    const renderer = this._renderer;
    if (!renderer || !renderer._ctx) return;
    if (this._empty()) return;
    const ctx = renderer._ctx;
    const p = this._point;
    const r = Math.max(Math.round(this._radius), 1);
    ctx.beginPath();
    ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
    renderer._fillStroke(ctx, this);
    // diagonal line from bottom-left to top-right
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y + r);
    ctx.lineTo(p.x + r, p.y - r);
    if (this.options.stroke && this.options.weight !== 0) {
      if (ctx.setLineDash) {
        ctx.setLineDash(this.options.dashArray || []);
      }
      ctx.globalAlpha = this.options.opacity ?? 1;
      ctx.lineWidth = this.options.weight;
      ctx.strokeStyle = this.options.color;
      ctx.lineCap = this.options.lineCap || "round";
      ctx.lineJoin = this.options.lineJoin || "round";
      ctx.stroke();
    }
  },
  _containsPoint(p) {
    const r = this._radius + (this.options.weight || 0);
    return Math.abs(p.x - this._point.x) <= r && Math.abs(p.y - this._point.y) <= r;
  },
});

// Canvas-rendered triangle marker (TAP symbol)
const TriangleMarker = L.CircleMarker.extend({
  _updatePath() {
    const renderer = this._renderer;
    if (!renderer || !renderer._ctx) return;
    if (this._empty()) return;
    const ctx = renderer._ctx;
    const p = this._point;
    const r = Math.max(Math.round(this._radius), 1);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - r);           // top
    ctx.lineTo(p.x + r, p.y + r);       // bottom-right
    ctx.lineTo(p.x - r, p.y + r);       // bottom-left
    ctx.closePath();
    renderer._fillStroke(ctx, this);
  },
  _containsPoint(p) {
    const r = this._radius + (this.options.weight || 0);
    return Math.abs(p.x - this._point.x) <= r && Math.abs(p.y - this._point.y) <= r;
  },
});

// Load and render US substations and TAPs from CSV
async function loadUsSubstationLayer() {
  // Load the substations CSV file
  const csvUrl = makeAbsoluteUrl(`${US_DATA_ROOT}/${encodeURIComponent(US_SUBSTATIONS_FILENAME)}`);
  const csvText = await fetchText(csvUrl);
  const records = parseCsvText(csvText);

  // Group records by voltage and by TAP/substation
  const substationRecordsByVoltage = new Map();
  const tapRecordsByVoltage = new Map();
  let filteredOutCount = 0;

  for (const record of records) {
    const latitude = parseNumericValue(record.LATITUDE);
    const longitude = parseNumericValue(record.LONGITUDE);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      filteredOutCount += 1;
      continue;
    }

    const normalizedVoltage = normalizeVoltageValueLabel(record.MAX_VOLT);
    const isTap = isTapRecord(record);
    let group = "other-range";
    let displayLabel = String(record.MAX_VOLT || "Unknown").trim() || "Unknown";
    let sortVoltage = -1;
    let sortPrimaryRank = Number.POSITIVE_INFINITY;

    const isNotDetermined = normalizedVoltage === "-99999" || normalizedVoltage === "-999999";

    if (isNotDetermined) {
      group = "primary";
      displayLabel = "Not Determined";
      sortPrimaryRank = 99;
    } else if (normalizedVoltage) {
      if (isTap) {
        const tapBucket = getTapVoltageBucket(Number(normalizedVoltage));
        if (tapBucket) {
          group = "primary";
          displayLabel = tapBucket.label;
          sortVoltage = tapBucket.sortVoltage;
          sortPrimaryRank = tapBucket.sortRank;
        }
      }

      if (!isTap || group !== "primary") {
        const substationBucket = getSubstationVoltageBucket(Number(normalizedVoltage));
        if (substationBucket) {
          group = "primary";
          displayLabel = substationBucket.label;
          sortVoltage = substationBucket.sortVoltage;
          sortPrimaryRank = substationBucket.sortRank;
        } else {
          group = "other-range";
          displayLabel = formatSubstationVoltageDisplayLabel(normalizedVoltage);
          sortVoltage = Number(normalizedVoltage);
          sortPrimaryRank = getPrimaryVoltageSortRank(normalizedVoltage);
        }
      }
    }

    const targetMap = isTap ? tapRecordsByVoltage : substationRecordsByVoltage;
    const key = `${displayLabel}||${group}`;
    if (!targetMap.has(key)) {
      targetMap.set(key, {
        rows: [],
        displayLabel,
        group,
        sortVoltage,
        sortPrimaryRank,
      });
    }

    targetMap.get(key).rows.push({
      ...record,
      __lat: latitude,
      __lon: longitude,
      __voltage: normalizedVoltage,
    });
  }

  // Create layer groups and voltage layers
  usSubstationLayer = L.layerGroup();
  usSubstationVoltageLayers = new Map();
  usTapLayer = L.layerGroup();
  usTapVoltageLayers = new Map();

  const groupOrder = { primary: 0, "other-range": 1 };
  const sortEntries = (inputMap) => [...inputMap.values()].sort((a, b) => {
    const groupDelta = (groupOrder[a.group] ?? 99) - (groupOrder[b.group] ?? 99);
    if (groupDelta !== 0) {
      return groupDelta;
    }
    if (a.group === "primary" && b.group === "primary" && a.sortPrimaryRank !== b.sortPrimaryRank) {
      return a.sortPrimaryRank - b.sortPrimaryRank;
    }
    if (a.sortVoltage !== b.sortVoltage) {
      return b.sortVoltage - a.sortVoltage;
    }
    return a.displayLabel.localeCompare(b.displayLabel);
  });

  const sortedSubstationEntries = sortEntries(substationRecordsByVoltage);
  const sortedTapEntries = sortEntries(tapRecordsByVoltage);

  const buildLayerEntries = (entries, targetLayer, targetMap, markerFactory) => {
    entries.forEach((entry, index) => {
      const levelRecords = entry.rows || [];
      const color = getVoltageColorByIndex(index);
      const defaultVoltageMatch = entry.displayLabel.match(/^-?\d+(?:\.\d+)?/);
      const defaultVoltage = defaultVoltageMatch ? defaultVoltageMatch[0] : null;
      const visibleByDefault = entry.group === "primary" && US_DEFAULT_VISIBLE_SUBSTATION_LEVELS.has(defaultVoltage);
      const levelLayer = L.layerGroup();

      for (const row of levelRecords) {
        const marker = markerFactory(row, color);
        bindHoverPersistentPopup(marker, buildSubstationPopupHTML(row));
        levelLayer.addLayer(marker);
      }

      if (visibleByDefault) {
        targetLayer.addLayer(levelLayer);
      }

      targetMap.set(entry.displayLabel, {
        layer: levelLayer,
        visible: visibleByDefault,
        color,
        elementCount: levelRecords.length,
        displayLabel: entry.displayLabel,
        group: entry.group,
      });
    });
  };

  const substationMarker = (row, color) =>
    new SquareMarker([row.__lat, row.__lon], {
      radius: 2,
      color: "#0b0f0f",
      weight: 0.5,
      fillColor: color,
      fillOpacity: 0.88,
    });
  const tapMarker = (row, color) =>
    new TriangleMarker([row.__lat, row.__lon], {
      radius: 1.8,
      color: "#0b0f0f",
      weight: 0.4,
      fillColor: color,
      fillOpacity: 0.85,
    });

  buildLayerEntries(sortedSubstationEntries, usSubstationLayer, usSubstationVoltageLayers, substationMarker);
  buildLayerEntries(sortedTapEntries, usTapLayer, usTapVoltageLayers, tapMarker);

  usSubstationLayer.addTo(map);
  usTapLayer.addTo(map);
  renderUsSubstationVoltageControls();
  renderUsTapVoltageControls();
  updateUsSubstationMasterCheckbox();
}
const US_BOUNDS = [
  [24.4, -125.0],
  [49.6, -66.8],
];
const US_DEFAULT_CENTER = [39.5, -98.35];
const US_DEFAULT_ZOOM = 4;

const THEME_STORAGE_KEY = "webmap-theme";
const US_DATA_ROOT = "../geoinfo/us-data";
const US_TRANSMISSION_BASENAME = "Electric_Power_Transmission_Lines";
const US_PCA_BASENAME = "US_PCA";
const US_SUBSTATIONS_FILENAME = "Substations.csv";
const US_POWER_PLANTS_FILENAME = "Power_Plants.csv";
const US_DATA_CENTERS_ATLAS_CSV = "im3_open_source_data_center_atlas_v2026.02.09/im3_open_source_data_center_atlas_v2026.02.09.csv";
const US_PROJECTED_DATA_CENTERS_ROOT = "im3_projected_data_centers_v1.1";
const US_PROJECTED_DATA_CENTER_SCENARIOS = [
  { key: "low_growth", label: "Low growth", color: "#0e7490" },
  { key: "moderate_growth", label: "Moderate growth", color: "#15803d" },
  { key: "high_growth", label: "High growth", color: "#c2410c" },
  { key: "higher_growth", label: "Higher growth", color: "#b91c1c" },
];
const US_PROJECTED_DATA_CENTER_WEIGHTS = [0, 25, 50, 75, 100];
const ESRI_102003 = {
  semiMajorAxis: 6378137,
  inverseFlattening: 298.257222101,
  latitudeOfOrigin: 37.5 * Math.PI / 180,
  centralMeridian: -96 * Math.PI / 180,
  firstStandardParallel: 29.5 * Math.PI / 180,
  secondStandardParallel: 45.5 * Math.PI / 180,
};
const US_VOLTAGE_PALETTE = [
  "#2563eb",
  "#0891b2",
  "#10b981",
  "#84cc16",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#db2777",
  "#7c3aed",
  "#0f766e",
  "#52525b",
];
const US_ALLOWED_VOLTAGE_LEVELS = ["765", "500", "345", "230", "220", "161", "138", "115", "69", "34.5"];
const US_DEFAULT_VISIBLE_TRANSMISSION_LEVELS = new Set(["765", "500", "345", "230", "161", "138", "115", "69"]);
const US_DEFAULT_VISIBLE_SUBSTATION_LEVELS = new Set();
const US_TRANSMISSION_PRIMARY_LEVELS = new Set(["1000", "765", "500", "450", "400", "348", "345", "230", "220", "169", "161", "138", "115", "69"]);
const US_SUBSTATION_PRIMARY_LEVELS = new Set(["1000", "765", "500", "450", "400", "348", "345", "230", "220", "169", "161", "138", "115", "69"]);
const US_PRIMARY_LEVEL_SORT_ORDER = ["1000", "765", "500", "450", "400", "348", "345", "230", "220", "169", "161", "138", "115", "69", "34.5"];
const US_TAP_VOLTAGE_BUCKETS = [
  { label: "500 kV AC", exact: 500, sortRank: 0, sortVoltage: 500 },
  { label: "345 kV AC", exact: 345, sortRank: 1, sortVoltage: 345 },
  { label: "275 kV AC", exact: 275, sortRank: 2, sortVoltage: 275 },
  { label: "230 kV AC", exact: 230, sortRank: 3, sortVoltage: 230 },
  { label: "> 138 - 169 kV AC", min: 138, max: 169, sortRank: 4, sortVoltage: 169 },
  { label: "> 69 - 138 kV AC", min: 69, max: 138, sortRank: 5, sortVoltage: 138 },
  { label: "> 35 - 69 kV AC", min: 35, max: 69, sortRank: 6, sortVoltage: 69 },
  { label: "> 0 - 35 kV AC", min: 0, max: 35, sortRank: 7, sortVoltage: 35 },
];
const US_SUBSTATION_VOLTAGE_BUCKETS = [
  { label: "1000 kV DC", exact: 1000, sortRank: 0, sortVoltage: 1000 },
  { label: "765 kV AC", exact: 765, sortRank: 1, sortVoltage: 765 },
  { label: "500 kV AC", exact: 500, sortRank: 2, sortVoltage: 500 },
  { label: "360 - 500 kV AC", min: 360, max: 500, sortRank: 3, sortVoltage: 499 },
  { label: "348 kV DC", exact: 348, sortRank: 4, sortVoltage: 348 },
  { label: "345 kV AC", exact: 345, sortRank: 5, sortVoltage: 345 },
  { label: "231 - 300 kV AC", min: 231, max: 300, sortRank: 6, sortVoltage: 300 },
  { label: "230 kV AC", exact: 230, sortRank: 7, sortVoltage: 230 },
  { label: "200 - 230 kV AC", min: 200, max: 230, sortRank: 8, sortVoltage: 229 },
  { label: "138 - 200 kV AC", min: 138, max: 200, sortRank: 9, sortVoltage: 200 },
  { label: "70 - 138 kV AC", min: 70, max: 138, sortRank: 10, sortVoltage: 137 },
  { label: "69 kV AC", exact: 69, sortRank: 11, sortVoltage: 69 },
  { label: "35 - 69 kV AC", min: 35, max: 69, sortRank: 12, sortVoltage: 68 },
  { label: "0 - 35 kV AC", min: 0, max: 35, sortRank: 13, sortVoltage: 35 },
];
const US_TRANSMISSION_VOLTAGE_BUCKETS = [
  { label: "1000 kV DC", exact: 1000, currentType: "DC", sortRank: 0, sortVoltage: 1000 },
  { label: "765 kV AC", exact: 765, currentType: "AC", sortRank: 1, sortVoltage: 765 },
  { label: "500 kV AC", exact: 500, currentType: "AC", sortRank: 2, sortVoltage: 500 },
  { label: "450 kV DC", exact: 450, currentType: "DC", sortRank: 3, sortVoltage: 450 },
  { label: "400 kV DC", exact: 400, currentType: "DC", sortRank: 4, sortVoltage: 400 },
  { label: "348 kV DC", exact: 348, currentType: "DC", sortRank: 5, sortVoltage: 348 },
  { label: "345 kV AC", exact: 345, currentType: "AC", sortRank: 6, sortVoltage: 345 },
  { label: "231 - 300 kV AC", min: 231, max: 300, currentType: "AC", sortRank: 7, sortVoltage: 300 },
  { label: "230 kV AC", exact: 230, currentType: "AC", sortRank: 8, sortVoltage: 230 },
  { label: "200 - 230 kV AC", min: 200, max: 230, currentType: "AC", sortRank: 9, sortVoltage: 229 },
  { label: "138 - 200 kV AC", min: 138, max: 200, currentType: "AC", sortRank: 10, sortVoltage: 200 },
  { label: "70 - 138 kV AC", min: 70, max: 138, currentType: "AC", sortRank: 11, sortVoltage: 137 },
  { label: "69 kV AC", exact: 69, currentType: "AC", sortRank: 12, sortVoltage: 69 },
  { label: "35 - 69 kV AC", min: 35, max: 69, currentType: "AC", sortRank: 13, sortVoltage: 68 },
  { label: "0 - 35 kV AC", min: 0, max: 35, currentType: "AC", sortRank: 14, sortVoltage: 35 },
];
const US_TYPE_PALETTE = [
  "#e67e22",
  "#1d7db8",
  "#2a9d8f",
  "#9b5f3f",
  "#845ec2",
  "#f2b705",
  "#27ae60",
  "#e07a5f",
  "#6d597a",
  "#ef476f",
  "#0ea5e9",
  "#84cc16",
];
const US_POWER_PLANT_CATEGORY_COLORS = {
  Wind: "#38bdf8",
  Solar: "#facc15",
  Hydroelectric: "#2563eb",
  "Small Hydro": "#3b82f6",
  Biomass: "#22c55e",
  "Fossil Fuel": "#9a3412",
  Nuclear: "#a855f7",
  Geothermal: "#f97316",
  Batteries: "#14b8a6",
  "Flywheel (MES)": "#0ea5a4",
  Other: "#64748b",
  "Not Available": "#6b7280",
};


const map = L.map("map", {
  zoomControl: false,
  preferCanvas: true,
  minZoom: 2.5,
  maxZoom: 17,
  zoomSnap: 0.25,
  zoomDelta: 0.25,
  wheelPxPerZoomLevel: 180,
  wheelDebounceTime: 90,
  tap: false, // Fixes Safari map panning bug
}).setView(US_DEFAULT_CENTER, US_DEFAULT_ZOOM);

L.control.zoom({ position: "bottomleft" }).addTo(map);

function recenterMapToDefault() {
  map.setView(US_DEFAULT_CENTER, US_DEFAULT_ZOOM);
}

function addRecenterControlButton() {
  const zoomControl = document.querySelector(".leaflet-control-zoom");
  if (!zoomControl || zoomControl.querySelector(".leaflet-control-recenter")) {
    return;
  }

  const button = document.createElement("a");
  button.className = "leaflet-control-zoom-in leaflet-control-recenter";
  button.href = "#";
  button.role = "button";
  button.setAttribute("aria-label", "Re-center map");
  button.setAttribute("title", "Re-center");
  button.textContent = "RE-CENTER";

  button.addEventListener("click", (event) => {
    event.preventDefault();
    recenterMapToDefault();
  });

  zoomControl.appendChild(button);
  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    zoomControl.appendChild(themeToggle);
  }
}

addRecenterControlButton();

const lightTileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 20,
});

const darkTileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 20,
});

let activeBaseLayer = null;
let activeHoverPopupLayer = null;
let usTransmissionLayer = null;
let usTransmissionVoltageLayers = new Map();
let usTransmissionMasterCheckbox = null;
let usTransmissionVoltageContainer = null;
let usSubstationLayer = null;
let usSubstationVoltageLayers = new Map();
let usSubstationMasterCheckbox = null;
let usSubstationVoltageContainer = null;
let usTapLayer = null;
let usTapVoltageLayers = new Map();
let usTapVoltageContainer = null;
let usPowerPlantLayer = null;
let usPowerPlantTypeLayers = new Map();
let usPowerPlantMasterCheckbox = null;
let usPowerPlantTypeContainer = null;
let usPcaLayer = null;
let usPcaFeatureCollection = null;
let usPcaVisible = false;
let usPcaLoaded = false;
let usDataCenterLayer = null;
let usDataCenterVisible = false;
let usDataCenterLoaded = false;
const usProjectedDataCenterLayers = new Map();
const usProjectedDataCenterCheckboxes = new Map();
const usReconductoringLayers = new Map();
const usReconductoringCheckboxes = new Map();
const usReconductoringSummaries = new Map();
const usActiveReconductoringIsos = new Set();
const usRegionLayers = new Map();
const usRegionCheckboxes = new Map();
const usGetsLayers = new Map();
const usGetsCheckboxes = new Map();
const usActiveGetsIsos = new Set();
const usIsoProjectCounts = new Map();
let usStatusTrackingActive = false;

const mapShellEl = document.getElementById("map-shell");
const mapUiLeftEl = document.getElementById("map-ui-left");
const mapUiLeftToggleEl = document.getElementById("map-ui-left-toggle");
const mapUiLeftLabelToggleEl = document.getElementById("map-ui-left-label-toggle");
const mapUiLeftCloseEl = document.getElementById("map-ui-left-close");
const mapUiRightEl = document.getElementById("map-ui-right");
const mapUiRightStackEl = document.getElementById("map-ui-right-stack");
const mapUiRightToggleEl = document.getElementById("map-ui-right-toggle");
const mapUiRightLabelToggleEl = document.getElementById("map-ui-right-label-toggle");
const mapUiRightCloseEl = document.getElementById("map-ui-right-close");
const statusListEl = document.getElementById("status-list");
const mapTitleCardEl = document.getElementById("map-title-card");

function setUsLegendDrawerOpen(isOpen) {
  if (!mapUiRightEl || !mapUiRightToggleEl) {
    return;
  }

  mapUiRightEl.classList.toggle("is-open", isOpen);
  mapUiRightEl.setAttribute("aria-hidden", String(!isOpen));
  mapUiRightToggleEl.setAttribute("aria-expanded", String(isOpen));
  mapUiRightToggleEl.classList.toggle("is-open", isOpen);
  mapUiRightToggleEl.title = isOpen ? "Hide map legends" : "Show map legends";
  mapUiRightLabelToggleEl?.setAttribute("aria-expanded", String(isOpen));
  mapUiRightLabelToggleEl?.setAttribute("title", isOpen ? "Hide map legends" : "Show map legends");
  const label = mapUiRightToggleEl.querySelector(".sr-only");
  if (label) {
    label.textContent = isOpen ? "Hide map legends" : "Show map legends";
  }
}

function setUsLayerDrawerOpen(isOpen) {
  if (!mapUiLeftEl || !mapUiLeftToggleEl) {
    return;
  }

  mapUiLeftEl.classList.toggle("is-open", isOpen);
  mapUiLeftEl.setAttribute("aria-hidden", String(!isOpen));
  mapUiLeftToggleEl.setAttribute("aria-expanded", String(isOpen));
  mapUiLeftToggleEl.classList.toggle("is-open", isOpen);
  mapUiLeftToggleEl.title = isOpen ? "Hide grid layers" : "Show grid layers";
  mapUiLeftLabelToggleEl?.setAttribute("aria-expanded", String(isOpen));
  mapUiLeftLabelToggleEl?.setAttribute("title", isOpen ? "Hide grid layers" : "Show grid layers");
  const label = mapUiLeftToggleEl.querySelector(".sr-only");
  if (label) {
    label.textContent = isOpen ? "Hide grid layers" : "Show grid layers";
  }
}

function initializeUsLegendDrawer() {
  mapUiRightToggleEl?.addEventListener("click", () => {
    setUsLegendDrawerOpen(!mapUiRightEl?.classList.contains("is-open"));
  });
  mapUiRightLabelToggleEl?.addEventListener("click", () => {
    setUsLegendDrawerOpen(!mapUiRightEl?.classList.contains("is-open"));
  });
  mapUiRightCloseEl?.addEventListener("click", () => setUsLegendDrawerOpen(false));
}

function initializeUsLayerDrawer() {
  mapUiLeftToggleEl?.addEventListener("click", () => {
    setUsLayerDrawerOpen(!mapUiLeftEl?.classList.contains("is-open"));
  });
  mapUiLeftLabelToggleEl?.addEventListener("click", () => {
    setUsLayerDrawerOpen(!mapUiLeftEl?.classList.contains("is-open"));
  });
  mapUiLeftCloseEl?.addEventListener("click", () => setUsLayerDrawerOpen(false));
}

function appendUsLegendCard(card) {
  if (mapUiRightStackEl) {
    mapUiRightStackEl.appendChild(card);
  } else {
    mapUiRightEl?.appendChild(card);
  }
}

map.getContainer().addEventListener("mouseleave", () => {
  if (activeHoverPopupLayer) {
    activeHoverPopupLayer.closePopup();
    activeHoverPopupLayer = null;
  }
});

function getInitialTheme() {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setActiveBaseLayer(theme) {
  const targetLayer = theme === "dark" ? darkTileLayer : lightTileLayer;
  if (activeBaseLayer === targetLayer) {
    return;
  }
  if (activeBaseLayer) {
    map.removeLayer(activeBaseLayer);
  }
  activeBaseLayer = targetLayer;
  activeBaseLayer.addTo(map);
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  setActiveBaseLayer(theme);

  const themeToggleEl = document.getElementById("theme-toggle");
  if (!themeToggleEl) {
    return;
  }

  if (theme === "dark") {
    themeToggleEl.setAttribute("aria-label", "Switch to light mode");
    themeToggleEl.setAttribute("title", "Switch to light mode");
    themeToggleEl.setAttribute("aria-pressed", "true");
  } else {
    themeToggleEl.setAttribute("aria-label", "Switch to dark mode");
    themeToggleEl.setAttribute("title", "Switch to dark mode");
    themeToggleEl.setAttribute("aria-pressed", "false");
  }
}

function initializeThemeToggle() {
  const themeToggleEl = document.getElementById("theme-toggle");
  const theme = getInitialTheme();
  applyTheme(theme);

  if (!themeToggleEl) {
    return;
  }

  themeToggleEl.addEventListener("click", () => {
    const currentTheme = document.body.dataset.theme === "dark" ? "dark" : "light";
    const nextTheme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  });
}

const loadingOverlayEl = document.getElementById("loading-overlay");

function setLoadingOverlayVisible(visible) {
  if (!loadingOverlayEl) {
    return;
  }
  const show = Boolean(visible);
  loadingOverlayEl.classList.toggle("is-hidden", !show);
  loadingOverlayEl.setAttribute("aria-hidden", String(!show));
}

function initializeCountrySwitcherNavigation() {
  const switchLinks = document.querySelectorAll("#country-switcher a.country-switcher-btn");
  for (const link of switchLinks) {
    link.addEventListener("click", (event) => {
      const href = link.getAttribute("href");
      if (!href || link.classList.contains("is-active")) {
        return;
      }

      event.preventDefault();
      setLoadingOverlayVisible(true);
      window.setTimeout(() => {
        window.location.href = href;
      }, 120);
    });
  }
}

function setStatus(statusId, kind, message) {
  if (!statusListEl) {
    return;
  }

  let li = statusListEl.querySelector(`[data-status-id='${statusId}']`);
  if (!li) {
    li = document.createElement("li");
    li.dataset.statusId = statusId;
    statusListEl.appendChild(li);
  }

  li.className = kind;
  li.textContent = message;
}

function setStatusById(statusId, kind, message) {
  setStatus(statusId, kind, message);
}

function removeStatus(statusId) {
  if (!statusListEl) {
    return;
  }

  const li = statusListEl.querySelector(`[data-status-id='${statusId}']`);
  if (li) {
    li.remove();
  }
}

function clearStatusWindow() {
  if (!statusListEl) {
    return;
  }
  statusListEl.innerHTML = "";
}

function countVisibleElements(entryMap) {
  if (!entryMap || !entryMap.size) {
    return 0;
  }
  let count = 0;
  for (const entry of entryMap.values()) {
    if (entry?.visible) {
      count += Number(entry?.elementCount || 0);
    }
  }
  return count;
}

function formatCountLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function appendLegendCount(parent, count) {
  const countEl = document.createElement("span");
  countEl.className = "legend-count";
  setLegendCount(countEl, count);
  parent.appendChild(countEl);
  return countEl;
}

function setLegendCount(countEl, count) {
  if (countEl) {
    countEl.textContent = `(${Number(count || 0).toLocaleString()})`;
  }
}

function updateUsIsoProjectCount(isoKey, layerType, count) {
  const counts = usIsoProjectCounts.get(isoKey) || { reconductoring: 0, gets: 0 };
  counts[layerType] = Number(count || 0);
  usIsoProjectCounts.set(isoKey, counts);
  const countElement = document.querySelector(
    `#section-us-reconductoring [data-iso-key="${isoKey}"] .reconductoring-label-count`
  );
  setLegendCount(countElement, counts.reconductoring + counts.gets);
}

function refreshProjectedLegendCounts() {
  const countElements = [...document.querySelectorAll(".projected-legend-count")];
  const scenarioTotals = new Map();
  let projectedTotal = 0;

  for (const countEl of countElements) {
    const count = Number(countEl.dataset.count || 0);
    const scenarioKey = countEl.dataset.scenarioKey;
    scenarioTotals.set(scenarioKey, (scenarioTotals.get(scenarioKey) || 0) + count);
    projectedTotal += count;
  }

  for (const [scenarioKey, total] of scenarioTotals) {
    setLegendCount(document.querySelector(`[data-scenario-count="${scenarioKey}"]`), total);
  }
  setLegendCount(document.querySelector(".projected-total-count"), projectedTotal);
}

function appendVisibleEntryStatuses(addItem, options) {
  const { entryMap, idPrefix, nounSingular, nounPlural } = options;
  if (!entryMap || !entryMap.size) {
    return;
  }

  for (const [entryKey, entry] of entryMap.entries()) {
    if (!entry?.visible) {
      continue;
    }

    const label = String(entry.displayLabel || entryKey || "Unknown").trim() || "Unknown";
    const count = Number(entry.elementCount || 0);
    addItem(`${idPrefix}-${label}`, `${label}: ${formatCountLabel(count, nounSingular, nounPlural)}`);
  }
}

function refreshStatusFromVisibility() {
  if (!statusListEl) {
    return;
  }

  statusListEl.innerHTML = "";
  if (!usStatusTrackingActive) {
    return;
  }

  const addItem = (id, text) => {
    const li = document.createElement("li");
    li.dataset.statusId = id;
    li.className = "ok";
    li.textContent = text;
    statusListEl.appendChild(li);
  };

  const pcaVisible = Boolean(usPcaVisible && usPcaLayer && map.hasLayer(usPcaLayer));
  if (pcaVisible) {
    const pcaFeatureCount = (usPcaFeatureCollection?.features || []).length;
    addItem("us-pca", `PCA areas: ${pcaFeatureCount} feature(s) visible`);
  }

  const dataCentersVisible = Boolean(usDataCenterVisible && usDataCenterLayer && map.hasLayer(usDataCenterLayer));
  if (dataCentersVisible) {
    const dataCenterCount = usDataCenterLayer.getLayers().length;
    addItem("us-data-centers", `Data centers: ${dataCenterCount} site(s) visible`);
  }

  const projectedDataCenterCount = [...usProjectedDataCenterLayers.values()]
    .filter((layer) => map.hasLayer(layer))
    .reduce((total, layer) => total + layer.getLayers().length, 0);
  if (projectedDataCenterCount) {
    addItem("us-projected-data-centers", `Projected data centers: ${projectedDataCenterCount} area(s) visible`);
  }

  appendVisibleEntryStatuses(addItem, {
    entryMap: usTransmissionVoltageLayers,
    idPrefix: "us-transmission",
    nounSingular: "line",
    nounPlural: "lines",
  });

  appendVisibleEntryStatuses(addItem, {
    entryMap: usSubstationVoltageLayers,
    idPrefix: "us-substations",
    nounSingular: "substation",
    nounPlural: "substations",
  });

  appendVisibleEntryStatuses(addItem, {
    entryMap: usTapVoltageLayers,
    idPrefix: "us-taps",
    nounSingular: "tap",
    nounPlural: "taps",
  });

  appendVisibleEntryStatuses(addItem, {
    entryMap: usPowerPlantTypeLayers,
    idPrefix: "us-power-plants",
    nounSingular: "generator",
    nounPlural: "generators",
  });

  for (const isoKey of usActiveReconductoringIsos) {
    const summary = usReconductoringSummaries.get(isoKey);
    if (!summary) {
      continue;
    }
    addItem(`us-reconductoring-${isoKey}`, buildReconductoringStatusText({ label: summary.label, summary }));
  }
}

function activateStatusTracking() {
  usStatusTrackingActive = true;
  refreshStatusFromVisibility();
}

function buildReconductoringStatusText(dataset) {
  const summary = dataset?.summary;
  if (!summary) {
    return "Reconductoring dataset ready";
  }

  return `${dataset.label}: ${summary.existingSegmentCount} existing segment(s)`;
}

function renderUsReconductoringSummary(messageHtml = null) {
  void messageHtml;
}

const US_RECONDUCTORING_LINE_COLOR = "#dc2626";

function buildUsReconductoringLeafletLayer(dataset) {
  const layerGroup = L.layerGroup();

  const bindPopup = (featureLayer, feature) => {
    bindHoverPersistentPopup(featureLayer, buildReconductoringPopupHtml(feature));
  };

  if (dataset.existingFeatures?.length) {
    const existingLayer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: dataset.existingFeatures,
      },
      {
        style: {
          color: US_RECONDUCTORING_LINE_COLOR,
          weight: 3,
          opacity: 0.95,
        },
        onEachFeature: (feature, featureLayer) => bindPopup(featureLayer, feature),
      }
    );
    layerGroup.addLayer(existingLayer);
  }

  if (dataset.newLineFeatures?.length) {
    const newLayer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: dataset.newLineFeatures,
      },
      {
        style: {
          color: US_RECONDUCTORING_LINE_COLOR,
          weight: 3.2,
          opacity: 0.96,
        },
        onEachFeature: (feature, featureLayer) => bindPopup(featureLayer, feature),
      }
    );
    layerGroup.addLayer(newLayer);
  }

  if (dataset.newPointFeatures?.length) {
    const newPointLayer = L.geoJSON(
      {
        type: "FeatureCollection",
        features: dataset.newPointFeatures,
      },
      {
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          radius: 4,
          color: US_RECONDUCTORING_LINE_COLOR,
          weight: 1.5,
          fillColor: "#fecaca",
          fillOpacity: 0.95,
        }),
        onEachFeature: (feature, featureLayer) => bindPopup(featureLayer, feature),
      }
    );
    layerGroup.addLayer(newPointLayer);
  }

  return layerGroup;
}

function buildUsRegionLeafletLayer(dataset) {
  if (!dataset.regionFeatures?.length) {
    return L.layerGroup();
  }

  return L.geoJSON(
    {
      type: "FeatureCollection",
      features: dataset.regionFeatures,
    },
    {
      style: {
        color: dataset.regionStyle?.color || "#9a6700",
        weight: 1.1,
        fillColor: dataset.regionStyle?.fillColor || "#fbbf24",
        fillOpacity: 0.14,
        dashArray: "6 4",
      },
    }
  );
}

function buildUsGetsLeafletLayer(dataset) {
  const layerGroup = L.layerGroup();
  const bindGetsPopup = (feature, featureLayer) => {
    bindHoverPersistentPopup(featureLayer, buildPopupHTML(feature));
  };

  if (dataset.lineFeatures?.length) {
    layerGroup.addLayer(L.geoJSON(
      { type: "FeatureCollection", features: dataset.lineFeatures },
      {
        style: { color: "#2563eb", weight: 3.2, opacity: 0.95, dashArray: "8 5" },
        onEachFeature: bindGetsPopup,
      }
    ));
  }

  if (dataset.nodeFeatures?.length) {
    layerGroup.addLayer(L.geoJSON(
      { type: "FeatureCollection", features: dataset.nodeFeatures },
      {
        pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
          radius: 5,
          color: "#1d4ed8",
          weight: 1.5,
          fillColor: "#60a5fa",
          fillOpacity: 0.95,
        }),
        onEachFeature: bindGetsPopup,
      }
    ));
  }

  return layerGroup;
}

async function ensureUsReconductoringDataset(isoKey) {
  const datasetUrl = makeAbsoluteUrl(`./data/reconductoring-us/${encodeURIComponent(isoKey)}.json`);
  const response = await fetch(datasetUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${datasetUrl}`);
  }
  return response.json();
}

async function ensureUsReconductoringLayerPrepared(isoKey) {
  if (usReconductoringLayers.has(isoKey)) {
    return usReconductoringLayers.get(isoKey);
  }

  const dataset = await ensureUsReconductoringDataset(isoKey);
  const layer = buildUsReconductoringLeafletLayer(dataset);
  usReconductoringLayers.set(isoKey, layer);
  return layer;
}

async function syncUsRegionLayer(isoKey, shouldShow) {
  const checkbox = usRegionCheckboxes.get(isoKey);
  if (!shouldShow) {
    const layer = usRegionLayers.get(isoKey);
    if (layer && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
    usRegionLayers.delete(isoKey);
    return;
  }

  try {
    if (checkbox) checkbox.disabled = true;
    const dataset = await ensureUsReconductoringDataset(isoKey);
    const layer = buildUsRegionLeafletLayer(dataset);
    layer.addTo(map);
    usRegionLayers.set(isoKey, layer);
  } catch (error) {
    if (checkbox) checkbox.checked = false;
    console.warn(`${isoKey} region area unavailable`, error);
  } finally {
    if (checkbox && ISO_RECONDUCTORING_CONFIG.find((entry) => entry.key === isoKey)?.enabled) {
      checkbox.disabled = false;
    }
  }
}

async function syncUsGetsLayer(isoKey, shouldShow) {
  const checkbox = usGetsCheckboxes.get(isoKey);
  if (!shouldShow) {
    const layer = usGetsLayers.get(isoKey);
    if (layer && map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
    usGetsLayers.delete(isoKey);
    usActiveGetsIsos.delete(isoKey);
    updateUsIsoProjectCount(isoKey, "gets", 0);
    activateStatusTracking();
    return;
  }

  try {
    if (checkbox) checkbox.disabled = true;
    const url = makeAbsoluteUrl(`./data/gets/${encodeURIComponent(isoKey)}.json`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const dataset = await response.json();
    const layer = buildUsGetsLeafletLayer(dataset);
    layer.addTo(map);
    usGetsLayers.set(isoKey, layer);
    usActiveGetsIsos.add(isoKey);
    updateUsIsoProjectCount(isoKey, "gets", dataset.summary?.projectCount);
    activateStatusTracking();
  } catch (error) {
    if (checkbox) checkbox.checked = false;
    usActiveGetsIsos.delete(isoKey);
    updateUsIsoProjectCount(isoKey, "gets", 0);
    setStatusById(`us-gets-${isoKey}`, "warn", `${isoKey.toUpperCase()} GETS unavailable: ${error?.message || "unknown error"}`);
  } finally {
    if (checkbox && ISO_RECONDUCTORING_CONFIG.find((entry) => entry.key === isoKey)?.enabled) {
      checkbox.disabled = false;
    }
  }
}

async function syncUsReconductoringLayer(isoKey, shouldShow) {
  const statusId = `us-reconductoring-${isoKey}`;
  const checkbox = usReconductoringCheckboxes.get(isoKey);

  if (!shouldShow) {
    const existingLayer = usReconductoringLayers.get(isoKey);
    if (existingLayer && map.hasLayer(existingLayer)) {
      map.removeLayer(existingLayer);
    }
    usReconductoringLayers.delete(isoKey);
    usReconductoringSummaries.delete(isoKey);
    usActiveReconductoringIsos.delete(isoKey);
    updateUsIsoProjectCount(isoKey, "reconductoring", 0);
    removeStatus(statusId);
    renderUsReconductoringSummary();
    activateStatusTracking();
    return;
  }

  try {
    if (checkbox) {
      checkbox.disabled = true;
    }
    renderUsReconductoringSummary(`
      <strong>${isoKey.toUpperCase()}</strong><br />
      Preparing reconductoring dataset...
    `);
    const dataset = await ensureUsReconductoringDataset(isoKey);
    const layer = await ensureUsReconductoringLayerPrepared(isoKey);

    if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }

    usActiveReconductoringIsos.add(isoKey);
    usReconductoringSummaries.set(isoKey, {
      ...dataset.summary,
      label: dataset.label,
    });
    updateUsIsoProjectCount(
      isoKey,
      "reconductoring",
      dataset.summary.workbookProjectRowCount ?? dataset.summary.existingSegmentCount + dataset.summary.newSegmentCount
    );
    setStatusById(statusId, "ok", buildReconductoringStatusText(dataset));
    renderUsReconductoringSummary(`
      <strong>${dataset.label}</strong><br />
      States: ${dataset.summary.states.join(", ")}<br />
      ReEDS candidate lines in region: ${dataset.summary.candidateLineCount}<br />
      Line Reconductoring segments: ${dataset.summary.existingSegmentCount}<br />
      New direct reconductoring links: ${dataset.summary.newSegmentCount}<br />
      Substation pairs tracked: ${dataset.summary.substationPairCount}
    `);
    activateStatusTracking();
  } catch (error) {
    if (checkbox) {
      checkbox.checked = false;
    }
    usActiveReconductoringIsos.delete(isoKey);
    updateUsIsoProjectCount(isoKey, "reconductoring", 0);
    setStatusById(statusId, "warn", `${isoKey.toUpperCase()} reconductoring unavailable: ${error?.message || "unknown error"}`);
    renderUsReconductoringSummary(`
      <strong>${isoKey.toUpperCase()} reconductoring unavailable.</strong><br />
      ${error?.message || "Unknown error"}
    `);
  } finally {
    if (checkbox && ISO_RECONDUCTORING_CONFIG.find((entry) => entry.key === isoKey)?.enabled) {
      checkbox.disabled = false;
    }
  }
}

function normalizeVoltageValueLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const numeric = Number(match[0]);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  if (Number.isInteger(numeric)) {
    return String(numeric);
  }

  return String(Number(numeric.toFixed(3))).replace(/\.0+$/, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function storeCardRelativePosition(card) {
  if (!card || !mapShellEl || !card.classList.contains("is-floating")) {
    return;
  }

  const shellRect = mapShellEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const left = Number.parseFloat(card.style.left);
  const top = Number.parseFloat(card.style.top);
  const resolvedLeft = Number.isFinite(left) ? left : cardRect.left - shellRect.left;
  const resolvedTop = Number.isFinite(top) ? top : cardRect.top - shellRect.top;
  const maxLeft = Math.max(0, shellRect.width - cardRect.width);
  const maxTop = Math.max(0, shellRect.height - cardRect.height);

  card.dataset.floatLeftRatio = String(maxLeft > 0 ? resolvedLeft / maxLeft : 0);
  card.dataset.floatTopRatio = String(maxTop > 0 ? resolvedTop / maxTop : 0);
}

function clampCardPositionToShell(card) {
  if (!card || !mapShellEl || !card.classList.contains("is-floating")) {
    return;
  }

  const shellRect = mapShellEl.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const currentLeft = Number.parseFloat(card.style.left);
  const currentTop = Number.parseFloat(card.style.top);
  const maxLeft = Math.max(0, shellRect.width - cardRect.width);
  const maxTop = Math.max(0, shellRect.height - cardRect.height);
  const leftRatio = Number.parseFloat(card.dataset.floatLeftRatio);
  const topRatio = Number.parseFloat(card.dataset.floatTopRatio);
  const fallbackLeft = Number.isFinite(currentLeft) ? currentLeft : cardRect.left - shellRect.left;
  const fallbackTop = Number.isFinite(currentTop) ? currentTop : cardRect.top - shellRect.top;
  const nextLeft = Number.isFinite(leftRatio) ? leftRatio * maxLeft : fallbackLeft;
  const nextTop = Number.isFinite(topRatio) ? topRatio * maxTop : fallbackTop;

  card.style.left = `${clamp(nextLeft, 0, maxLeft)}px`;
  card.style.top = `${clamp(nextTop, 0, maxTop)}px`;
  storeCardRelativePosition(card);
}

function refreshResponsiveCardLayout() {
  map.invalidateSize(false);

  const floatingCards = mapShellEl?.querySelectorAll(".draggable-card.is-floating, .section-card.is-floating");
  floatingCards?.forEach((card) => clampCardPositionToShell(card));
}

function getVoltClassValue(properties) {
  const props = properties || {};
  const direct = props.VOLT_CLASS ?? props.volt_class ?? props.Volt_Class;
  if (direct !== null && direct !== undefined) {
    const text = String(direct).trim().toUpperCase();
    if (text) {
      return text;
    }
  }

  for (const [key, value] of Object.entries(props)) {
    if (!/volt.*class/i.test(key)) {
      continue;
    }

    const text = String(value ?? "").trim().toUpperCase();
    if (text) {
      return text;
    }
  }

  return "";
}

function getCurrentTypeFromVoltClass(properties) {
  const voltClass = getVoltClassValue(properties);
  return /\bDC\b/.test(voltClass) ? "DC" : "AC";
}

function getPrimaryVoltageSortRank(voltageLabel) {
  const index = US_PRIMARY_LEVEL_SORT_ORDER.indexOf(voltageLabel);
  if (index >= 0) {
    return index;
  }

  const value = Number(voltageLabel);
  if (Number.isFinite(value)) {
    return 1000 - value;
  }

  return Number.POSITIVE_INFINITY;
}

function formatTransmissionVoltageDisplayLabel(voltageLabel, currentType) {
  if (!voltageLabel || voltageLabel === "Unknown") {
    return "Unknown";
  }
  return `${voltageLabel} kV ${currentType}`;
}

function formatSubstationVoltageDisplayLabel(voltageLabel) {
  if (!voltageLabel || voltageLabel === "Unknown") {
    return "Unknown";
  }

  const currentType = voltageLabel === "348" || voltageLabel === "1000" ? "DC" : "AC";
  return `${voltageLabel} kV ${currentType}`;
}

function getTapVoltageBucket(voltage) {
  if (!Number.isFinite(voltage)) {
    return null;
  }

  return US_TAP_VOLTAGE_BUCKETS.find((bucket) => (
    bucket.exact === voltage || (bucket.exact === undefined && voltage > bucket.min && voltage <= bucket.max)
  )) || null;
}

function getSubstationVoltageBucket(voltage) {
  if (!Number.isFinite(voltage)) {
    return null;
  }

  return findVoltageBucket(US_SUBSTATION_VOLTAGE_BUCKETS, voltage);
}

function getTransmissionVoltageBucket(voltage, currentType) {
  if (!Number.isFinite(voltage)) {
    return null;
  }

  return findVoltageBucket(US_TRANSMISSION_VOLTAGE_BUCKETS, voltage, (bucket) => {
    const matchesType = !bucket.currentType || bucket.currentType === currentType;
    return matchesType;
  });
}

function findVoltageBucket(buckets, voltage, predicate = () => true) {
  const exactBucket = buckets.find((bucket) => bucket.exact === voltage && predicate(bucket));
  if (exactBucket) {
    return exactBucket;
  }

  return buckets.find((bucket) => {
    const matchesRange = bucket.exact === undefined && voltage >= bucket.min && voltage <= bucket.max;
    return matchesRange && predicate(bucket);
  }) || null;
}

function setCardVisibility(card, visible) {
  if (!card) {
    return;
  }

  card.classList.toggle("is-hidden-card", !visible);
}

function positionPopupCardNearAnchor(card, anchorElement) {
  if (!card || !anchorElement || !mapShellEl) {
    return;
  }

  const shellRect = mapShellEl.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  const cardWidth = card.offsetWidth || 360;
  const cardHeight = card.offsetHeight || 260;

  let left = anchorRect.right - shellRect.left + 10;
  if (left + cardWidth > shellRect.width - 8) {
    left = anchorRect.left - shellRect.left - cardWidth - 10;
  }

  let top = anchorRect.top - shellRect.top;
  // Clamp left/top so card stays in viewport
  left = Math.max(8, Math.min(left, shellRect.width - cardWidth - 8));
  top = Math.max(8, Math.min(top, shellRect.height - cardHeight - 8));

  // On small screens, force card fully visible
  if (window.innerWidth < cardWidth + 16) {
    left = 8;
    card.style.width = `calc(100vw - 16px)`;
  }
  if (window.innerHeight < cardHeight + 16) {
    top = 8;
    card.style.maxHeight = `calc(100vh - 16px)`;
    card.style.overflow = 'auto';
  }

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  storeCardRelativePosition(card);
}

function togglePopupCard(card, anchorElement) {
  if (!card) {
    return;
  }

  const shouldShow = card.classList.contains("is-hidden-card");
  setCardVisibility(card, shouldShow);
  if (shouldShow) {
    positionPopupCardNearAnchor(card, anchorElement);
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  const visiblePopupCards = document.querySelectorAll(
    ".floating-popup-card:not(.is-hidden-card)"
  );
  if (!visiblePopupCards.length) {
    return;
  }

  event.preventDefault();
  visiblePopupCards.forEach((card) => setCardVisibility(card, false));
});

function isTapRecord(record) {
  const type = String(record?.TYPE || "").trim().toUpperCase();
  return type.includes("TAP");
}

function enableCardDrag(card, handle = card) {
  if (!card || !handle || !mapShellEl) {
    return;
  }

  card.classList.add("draggable-card");
  handle.classList.add("draggable-handle");

  let pointerId = null;
  let offsetX = 0;
  let offsetY = 0;
  let shellRect = null;
  let placeholder = null;
  let originalParent = null;

  const onPointerMove = (event) => {
    if (pointerId !== event.pointerId || !shellRect) {
      return;
    }

    event.preventDefault();
    const maxX = shellRect.width - card.offsetWidth;
    const maxY = shellRect.height - card.offsetHeight;
    const nextX = event.clientX - shellRect.left - offsetX;
    const nextY = event.clientY - shellRect.top - offsetY;
    card.style.left = `${Math.min(Math.max(0, nextX), Math.max(0, maxX))}px`;
    card.style.top = `${Math.min(Math.max(0, nextY), Math.max(0, maxY))}px`;
    storeCardRelativePosition(card);
  };

  const onPointerUp = (event) => {
    if (pointerId !== event.pointerId) {
      return;
    }

    card.classList.remove("is-dragging");
    card.releasePointerCapture(pointerId);
    pointerId = null;
    shellRect = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button, input, a, label")) {
      return;
    }

    const cardRect = card.getBoundingClientRect();
    shellRect = mapShellEl.getBoundingClientRect();
    offsetX = event.clientX - cardRect.left;
    offsetY = event.clientY - cardRect.top;
    pointerId = event.pointerId;

    const isAlreadyFloating = card.classList.contains("is-floating");
    card.classList.add("draggable-card", "is-dragging");

    if (!isAlreadyFloating) {
      card.classList.add("is-floating");
      card.style.width = `${cardRect.width}px`;

      originalParent = card.parentElement;
      if (originalParent && originalParent !== mapShellEl && !placeholder) {
        placeholder = document.createElement("div");
        placeholder.className = "card-placeholder";
        placeholder.style.width = `${cardRect.width}px`;
        placeholder.style.height = `${cardRect.height}px`;
        placeholder.style.flex = "0 0 auto";

        const computedOrder = window.getComputedStyle(card).order;
        if (computedOrder) {
          placeholder.style.order = computedOrder;
        }

        originalParent.insertBefore(placeholder, card.nextSibling);
      }

      mapShellEl.appendChild(card);
    }

    card.style.left = `${cardRect.left - shellRect.left}px`;
    card.style.top = `${cardRect.top - shellRect.top}px`;
    storeCardRelativePosition(card);
    clampCardPositionToShell(card);
    card.setPointerCapture(pointerId);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}

function enableSectionCardDrag(card) {
  void card;
}

function makeAbsoluteUrl(path) {
  return new URL(path, window.location.href).href;
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.arrayBuffer();
}

async function fetchOptionalText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.text();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

function getShpParser() {
  const parser = window.shp || window.shpjs;
  if (typeof parser !== "function") {
    throw new Error("shpjs parser is unavailable (window.shp)");
  }
  return parser;
}

function toFeatureCollection(parsedData, sourceName) {
  if (Array.isArray(parsedData)) {
    const features = parsedData.flatMap((item) => item?.features || []);
    return {
      type: "FeatureCollection",
      features: features.map((feature) => ({
        ...feature,
        properties: {
          ...(feature?.properties || {}),
          source_file: sourceName,
        },
      })),
    };
  }

  if (parsedData?.type === "FeatureCollection") {
    return {
      type: "FeatureCollection",
      features: (parsedData.features || []).map((feature) => ({
        ...feature,
        properties: {
          ...(feature?.properties || {}),
          source_file: sourceName,
        },
      })),
    };
  }

  return { type: "FeatureCollection", features: [] };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildPopupHTML(feature) {
  const properties = feature?.properties || {};
  const keys = Object.keys(properties).slice(0, 20);
  if (!keys.length) {
    return "No attributes available.";
  }

  const rows = keys
    .map((key) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(properties[key] ?? "-")}</td></tr>`)
    .join("");
  return `<table>${rows}</table>`;
}

function bindHoverPersistentPopup(layer, popupHtml) {
  layer.bindPopup(popupHtml, {
    closeButton: true,
    autoClose: true,
    closeOnClick: false,
    closeOnEscapeKey: true,
  });

  layer.on("mouseover", () => {
    if (activeHoverPopupLayer && activeHoverPopupLayer !== layer) {
      activeHoverPopupLayer.closePopup();
    }

    layer.openPopup();
    activeHoverPopupLayer = layer;
  });

  layer.on("popupclose", () => {
    if (activeHoverPopupLayer === layer) {
      activeHoverPopupLayer = null;
    }
  });
}

function buildSubstationPopupHTML(properties) {
  const fields = [
    ["NAME", properties.NAME],
    ["CITY", properties.CITY],
    ["STATE", properties.STATE],
    ["ZIP", properties.ZIP],
    ["TYPE", properties.TYPE],
    ["STATUS", properties.STATUS],
    ["COUNTY", properties.COUNTY],
    ["MAX_VOLT", properties.MAX_VOLT],
    ["MIN_VOLT", properties.MIN_VOLT],
  ];

  const rows = fields
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value ?? "-")}</td></tr>`)
    .join("");

  return `<table>${rows}</table>`;
}

function buildPowerPlantPopupHTML(properties) {
  const category = resolvePowerPlantCategoryLabel(properties, null);
  const fields = [
    ["NAME", properties.NAME],
    ["ADDRESS", properties.ADDRESS],
    ["CITY", properties.CITY],
    ["STATE", properties.STATE],
    ["ZIP", properties.ZIP],
    ["CATEGORY", category],
    ["NAICS_DESC", properties.NAICS_DESC],
    ["TYPE", properties.TYPE],
    ["STATUS", properties.STATUS],
    ["COUNTY", properties.COUNTY],
    ["OPERATOR", properties.OPERATOR],
    ["OPER_CAP", properties.OPER_CAP],
    ["SUMMER_CAP", properties.SUMMER_CAP],
    ["WINTER_CAP", properties.WINTER_CAP],
    ["PRIM_FUEL", properties.PRIM_FUEL],
    ["SEC_FUEL", properties.SEC_FUEL],
    ["COAL_USED", properties.COAL_USED],
    ["NGAS_USED", properties.NGAS_USED],
    ["OIL_USED", properties.OIL_USED],
    ["NET_GEN", properties.NET_GEN],
    ["CAP_FACTOR", properties.CAP_FACTOR],
    ["SUB_1", properties.SUB_1],
    ["SUB_2", properties.SUB_2],
  ];

  const rows = fields
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value ?? "-")}</td></tr>`)
    .join("");

  return `<table>${rows}</table>`;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  values.push(current);
  return values;
}

function parseCsvText(csvText) {
  const lines = String(csvText || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => String(header).trim());
  const records = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    records.push(row);
  }

  return records;
}

function parseNumericValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseLooseNumericValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const cleaned = text.replaceAll(",", "");
  const direct = Number(cleaned);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function extractPowerPlantCapacityMw(record) {
  const preferredFields = ["OPER_CAP", "SUMMER_CAP", "WINTER_CAP", "PLAN_CAP", "RETIRE_CAP", "NET_GEN"];
  for (const field of preferredFields) {
    const value = parseLooseNumericValue(record?.[field]);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  for (const [field, rawValue] of Object.entries(record || {})) {
    if (!/(?:\bmw\b|\bcap\b|capacity|nameplate)/i.test(field)) {
      continue;
    }

    const value = parseLooseNumericValue(rawValue);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return null;
}

function getPowerPlantRadiusForMw(capacityMw, minCapacityMw, maxCapacityMw) {
  const minRadius = 3.2;
  const maxRadius = 10.5;

  if (!Number.isFinite(capacityMw) || !Number.isFinite(minCapacityMw) || !Number.isFinite(maxCapacityMw)) {
    return 4.8;
  }

  if (maxCapacityMw <= minCapacityMw) {
    return (minRadius + maxRadius) / 2;
  }

  // Use sqrt scaling so very large plants do not dominate marker size.
  const safeValue = Math.max(0, capacityMw);
  const t = (Math.sqrt(safeValue) - Math.sqrt(minCapacityMw)) / (Math.sqrt(maxCapacityMw) - Math.sqrt(minCapacityMw));
  const clamped = Math.max(0, Math.min(1, t));
  return minRadius + clamped * (maxRadius - minRadius);
}

function toTitleCase(text) {
  return String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function cleanNaicsLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  let normalized = text.toUpperCase();
  normalized = normalized.replace(/\bELECTRIC POWER GENERATION\b/g, "");
  normalized = normalized.replace(/\bPOWER GENERATION\b/g, "");
  normalized = normalized.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return null;
  }

  return toTitleCase(normalized);
}

function cleanTypeLabel(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "Unknown";
  }
  return toTitleCase(text);
}

function normalizeTypeKey(raw) {
  return String(raw || "").trim().toUpperCase();
}

function isOtherNaics(raw) {
  const text = String(raw || "").trim().toUpperCase();
  if (!text) {
    return false;
  }

  return text.startsWith("OTHER") || /\bOTHER\b/.test(text);
}

function isNotAvailableNaics(raw) {
  const text = String(raw || "").trim().toUpperCase();
  if (!text) {
    return false;
  }

  return (
    text.includes("NOT AVAILABLE") ||
    text === "N/A" ||
    text === "NA" ||
    text === "UNKNOWN"
  );
}

function isNotAvailableType(raw) {
  const text = String(raw || "").trim().toUpperCase();
  if (!text) {
    return true;
  }

  return (
    text.includes("NOT AVAILABLE") ||
    text === "N/A" ||
    text === "NA" ||
    text === "UNKNOWN" ||
    text === "UNK"
  );
}

function inferCategoryFromTypeWhenNaicsIsOther(typeKey) {
  const key = String(typeKey || "").trim().toUpperCase();
  if (!key) {
    return null;
  }

  if (key.includes("BATTERIES") || key.includes("BATTERY")) {
    return "Batteries";
  }

  if (key.includes("FLYWHEEL")) {
    return "Flywheel (MES)";
  }

  if (key.includes("SOLAR PHOTOVOLTAIC") || key.includes("SOLAR")) {
    return "Solar";
  }

  if (key.includes("NATURAL GAS FIRED COMBINED CYCLE")) {
    return "Fossil Fuel";
  }

  if (key.includes("HYDRO")) {
    return "Hydroelectric";
  }

  if (key.includes("NUCLEAR")) {
    return "Nuclear";
  }

  if (key.includes("WIND")) {
    return "Wind";
  }

  if (
    key.includes("NATURAL GAS") ||
    key.includes("COAL") ||
    key.includes("PETROLEUM") ||
    key.includes("OIL") ||
    key.includes("DIESEL") ||
    key.includes("COMBUSTION TURBINE") ||
    key.includes("STEAM")
  ) {
    return "Fossil Fuel";
  }

  if (key.includes("GEOTHERMAL")) {
    return "Geothermal";
  }

  if (key.includes("BIOMASS") || key.includes("WOOD") || key.includes("WASTE")) {
    return "Biomass";
  }

  return null;
}

function resolvePowerPlantCategoryLabel(record, fallbackByType) {
  const naicsRaw = record?.NAICS_DESC;
  const fromNaics = cleanNaicsLabel(naicsRaw);
  const typeKey = normalizeTypeKey(record?.TYPE);
  const naicsUnavailable = isNotAvailableNaics(naicsRaw) || fromNaics === "Not Available";
  const typeUnavailable = isNotAvailableType(record?.TYPE);

  // Special handling: when NAICS is OTHER*/NOT AVAILABLE*, infer from TYPE.
  if (isOtherNaics(naicsRaw) || naicsUnavailable || fromNaics === "Other") {
    if (naicsUnavailable && typeUnavailable) {
      return "Not Available";
    }

    const inferredFromType = inferCategoryFromTypeWhenNaicsIsOther(typeKey);
    if (inferredFromType) {
      return inferredFromType;
    }

    if (fallbackByType && typeKey && fallbackByType.has(typeKey)) {
      const fallbackLabel = fallbackByType.get(typeKey);
      if (fallbackLabel && fallbackLabel !== "Other") {
        return fallbackLabel;
      }
    }

    return naicsUnavailable ? "Not Available" : "Other";
  }

  if (fromNaics) {
    return fromNaics;
  }

  const inferredFromType = inferCategoryFromTypeWhenNaicsIsOther(typeKey);
  if (inferredFromType) {
    return inferredFromType;
  }

  if (fallbackByType && typeKey && fallbackByType.has(typeKey)) {
    return fallbackByType.get(typeKey);
  }

  return cleanTypeLabel(record?.TYPE);
}

function normalizeVoltageLabel(feature) {
  const properties = feature?.properties || {};
  const exact = properties.VOLTAGE ?? properties.Voltage ?? properties.voltage;
  if (exact !== null && exact !== undefined && String(exact).trim()) {
    return String(exact).trim();
  }

  for (const [key, value] of Object.entries(properties)) {
    if (!/voltage/i.test(key)) {
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }

  return "Unknown";
}

function voltageSortValue(label) {
  if (label === "Unknown") {
    return -1;
  }

  const match = String(label).match(/\d+(?:\.\d+)?/);
  if (!match) {
    return -1;
  }
  return Number(match[0]);
}

function getVoltageColorByIndex(index) {
  if (index < US_VOLTAGE_PALETTE.length) {
    return US_VOLTAGE_PALETTE[index];
  }

  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue}, 70%, 50%)`;
}

function getVoltageColorForLabel(label) {
  const transmissionEntry = usTransmissionVoltageLayers.get(label);
  if (transmissionEntry?.color) {
    return transmissionEntry.color;
  }

  const index = US_ALLOWED_VOLTAGE_LEVELS.indexOf(label);
  return getVoltageColorByIndex(index >= 0 ? index : 0);
}

function normalizeTypeLabel(value) {
  const text = String(value || "").trim();
  return text || "Unknown";
}

function getTypeColorByIndex(index) {
  if (index < US_TYPE_PALETTE.length) {
    return US_TYPE_PALETTE[index];
  }
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue}, 68%, 52%)`;
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getPcaStateKey(properties) {
  const props = properties || {};
  return String(props.st ?? props.ST ?? props.rb ?? props.RB ?? "Unknown").trim() || "Unknown";
}

function getPcaColorForStateKey(stateKey) {
  const hue = hashString(stateKey) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function rebuildUsPcaLayer() {
  if (!usPcaFeatureCollection) {
    return;
  }

  if (usPcaLayer && map.hasLayer(usPcaLayer)) {
    map.removeLayer(usPcaLayer);
  }

  const colorByStateKey = new Map();
  for (const feature of usPcaFeatureCollection.features || []) {
    const key = getPcaStateKey(feature?.properties || {});
    if (!colorByStateKey.has(key)) {
      colorByStateKey.set(key, getPcaColorForStateKey(key));
    }
  }

  usPcaLayer = L.geoJSON(usPcaFeatureCollection, {
    style: (feature) => {
      const stateKey = getPcaStateKey(feature?.properties || {});
      return {
      color: "#1f2937",
      weight: 0.7,
      fillColor: colorByStateKey.get(stateKey) || "#4f46e5",
      fillOpacity: 0.28,
      };
    },
    onEachFeature: (feature, featureLayer) => {
      bindHoverPersistentPopup(featureLayer, buildPopupHTML(feature));
    },
  });

  if (usPcaVisible) {
    usPcaLayer.addTo(map);
  }
}

function buildUsPcaControl() {
  if (!mapUiRightEl) {
    return;
  }

  const card = document.createElement("section");
  card.id = "section-us-pca";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";
  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "PCA Areas";
  header.appendChild(title);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const showRow = document.createElement("label");
  showRow.className = "voltage-filter-row";
  const showCheckbox = document.createElement("input");
  showCheckbox.type = "checkbox";
  showCheckbox.checked = usPcaVisible;
  const showText = document.createElement("span");
  showText.textContent = "Show PCA areas";
  const showCount = appendLegendCount(showText, 0);
  showRow.appendChild(showCheckbox);
  showRow.appendChild(showText);
  body.appendChild(showRow);
  card.appendChild(body);

  appendUsLegendCard(card);

  enableSectionCardDrag(card);

  showCheckbox.addEventListener("change", () => {
    const applyToggle = async () => {
      usPcaVisible = showCheckbox.checked;

      if (usPcaVisible && !usPcaLoaded) {
        try {
          await loadUsPcaLayer();
        } catch (pcaError) {
          setStatusById("us-pca", "warn", `US PCA load skipped: ${pcaError?.message || "unknown error"}`);
          console.warn("US PCA load skipped", pcaError);
          usPcaVisible = false;
          showCheckbox.checked = false;
          activateStatusTracking();
          return;
        }
      }

      if (!usPcaLayer) {
        activateStatusTracking();
        return;
      }

      if (usPcaVisible) {
        usPcaLayer.addTo(map);
      } else if (map.hasLayer(usPcaLayer)) {
        map.removeLayer(usPcaLayer);
      }

      setLegendCount(showCount, usPcaFeatureCollection?.features?.length || 0);

      activateStatusTracking();
    };

    applyToggle();
  });

  loadUsPcaLayer()
    .then(() => setLegendCount(showCount, usPcaFeatureCollection?.features?.length || 0))
    .catch((error) => console.warn("US PCA count unavailable", error));

}

function buildDataCenterPopupHTML(record) {
  const powerMw = parseLooseNumericValue(record.power_mw);
  const powerLabel = Number.isFinite(powerMw) ? `${powerMw.toLocaleString(undefined, { maximumFractionDigits: 2 })} MW` : "-";

  const rows = [
    ["Name", record.name || "-"],
    ["Operator", record.operator || "-"],
    ["Power", powerLabel],
    ["Type", record.type || "-"],
    ["State", record.state_abb || record.state || "-"],
    ["County", record.county || "-"],
    ["Sqft", record.sqft || "-"],
  ];

  const tableRows = rows
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value ?? "-")}</td></tr>`)
    .join("");

  return `<table>${tableRows}</table>`;
}

async function loadUsDataCenterLayer() {
  const atlasCsvUrl = makeAbsoluteUrl(`${US_DATA_ROOT}/${US_DATA_CENTERS_ATLAS_CSV}`);
  const atlasCsvText = await fetchText(atlasCsvUrl);
  const records = parseCsvText(atlasCsvText);

  usDataCenterLayer = L.layerGroup();

  for (const record of records) {
    const latitude = parseNumericValue(record.lat);
    const longitude = parseNumericValue(record.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const marker = L.circleMarker([latitude, longitude], {
      radius: 5,
      color: "#0b0f0f",
      weight: 0.8,
      fillColor: "#22d3ee",
      fillOpacity: 0.9,
    });

    bindHoverPersistentPopup(marker, buildDataCenterPopupHTML(record));
    usDataCenterLayer.addLayer(marker);
  }

  usDataCenterLoaded = true;
  if (usDataCenterVisible) {
    usDataCenterLayer.addTo(map);
  }
}

function buildProjectedDataCenterPopupHTML(properties, scenarioLabel, weight) {
  const rows = [
    ["Scenario", scenarioLabel],
    ["Market gravity", `${weight}%`],
    ["Region", properties.region || "-"],
    ["IT power", `${parseLooseNumericValue(properties.data_center_it_power_mw)?.toLocaleString() || "-"} MW`],
    ["Campus size", `${parseLooseNumericValue(properties.campus_size_square_ft)?.toLocaleString() || "-"} sq ft`],
    ["Total cost", `${parseLooseNumericValue(properties.total_cost_million_usd)?.toLocaleString() || "-"} million USD`],
  ];
  const tableRows = rows
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  return `<table>${tableRows}</table>`;
}

function inverseAlbersEqualArea([x, y]) {
  const projection = ESRI_102003;
  const flattening = 1 / projection.inverseFlattening;
  const eccentricitySquared = 2 * flattening - flattening ** 2;
  const eccentricity = Math.sqrt(eccentricitySquared);
  const meridionalPart = (latitude) => {
    const sine = Math.sin(latitude);
    return Math.cos(latitude) / Math.sqrt(1 - eccentricitySquared * sine ** 2);
  };
  const authalicLatitude = (latitude) => {
    const sine = Math.sin(latitude);
    return (1 - eccentricitySquared) * (
      sine / (1 - eccentricitySquared * sine ** 2)
      - Math.log((1 - eccentricity * sine) / (1 + eccentricity * sine)) / (2 * eccentricity)
    );
  };

  const m1 = meridionalPart(projection.firstStandardParallel);
  const m2 = meridionalPart(projection.secondStandardParallel);
  const q0 = authalicLatitude(projection.latitudeOfOrigin);
  const q1 = authalicLatitude(projection.firstStandardParallel);
  const q2 = authalicLatitude(projection.secondStandardParallel);
  const n = (m1 ** 2 - m2 ** 2) / (q2 - q1);
  const constant = m1 ** 2 + n * q1;
  const rho0 = projection.semiMajorAxis * Math.sqrt(constant - n * q0) / n;
  const rho = Math.sqrt(x ** 2 + (rho0 - y) ** 2);
  const theta = Math.atan2(x, rho0 - y);
  const targetQ = (constant - (rho * n / projection.semiMajorAxis) ** 2) / n;

  let latitude = Math.asin(targetQ / 2);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sine = Math.sin(latitude);
    const denominator = 1 - eccentricitySquared * sine ** 2;
    const currentQ = authalicLatitude(latitude);
    const derivative = 2 * (1 - eccentricitySquared) * Math.cos(latitude) / denominator ** 2;
    latitude += (targetQ - currentQ) / derivative;
  }

  const longitude = projection.centralMeridian + theta / n;
  return [longitude * 180 / Math.PI, latitude * 180 / Math.PI];
}

function reprojectProjectedDataCenterGeometry(geometry) {
  if (!geometry) {
    return geometry;
  }
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: geometry.geometries.map(reprojectProjectedDataCenterGeometry),
    };
  }
  const mapCoordinates = (coordinates) => (
    typeof coordinates[0] === "number"
      ? inverseAlbersEqualArea(coordinates)
      : coordinates.map(mapCoordinates)
  );
  return { ...geometry, coordinates: mapCoordinates(geometry.coordinates) };
}

function reprojectProjectedDataCenterFeatureCollection(data) {
  return {
    ...data,
    features: (data.features || []).map((feature) => ({
      ...feature,
      geometry: reprojectProjectedDataCenterGeometry(feature.geometry),
    })),
  };
}

function getProjectedDataCenterFeaturePoint(feature) {
  const coordinates = [];
  const collectCoordinates = (value) => {
    if (typeof value[0] === "number") {
      coordinates.push(value);
      return;
    }
    value.forEach(collectCoordinates);
  };
  collectCoordinates(feature.geometry?.coordinates || []);
  if (!coordinates.length) {
    return null;
  }
  const [longitude, latitude] = coordinates.reduce(
    ([sumLongitude, sumLatitude], [nextLongitude, nextLatitude]) => [
      sumLongitude + nextLongitude,
      sumLatitude + nextLatitude,
    ],
    [0, 0]
  );
  return [latitude / coordinates.length, longitude / coordinates.length];
}

async function loadProjectedDataCenterLayer(scenario, weight) {
  const layerKey = `${scenario.key}:${weight}`;
  if (usProjectedDataCenterLayers.has(layerKey)) {
    return usProjectedDataCenterLayers.get(layerKey);
  }

  const fileName = `${scenario.key}_${weight}_market_gravity.geojson`;
  const url = makeAbsoluteUrl(`${US_DATA_ROOT}/${US_PROJECTED_DATA_CENTERS_ROOT}/${scenario.key}/${fileName}`);
  const data = reprojectProjectedDataCenterFeatureCollection(JSON.parse(await fetchText(url)));
  const polygonLayer = L.geoJSON(data, {
    style: {
      color: scenario.color,
      weight: 1,
      fillColor: scenario.color,
      fillOpacity: 0.24,
    },
    onEachFeature: (feature, featureLayer) => {
      bindHoverPersistentPopup(
        featureLayer,
        buildProjectedDataCenterPopupHTML(feature.properties || {}, scenario.label, weight)
      );
    },
  });

  const markerLayer = L.layerGroup();
  for (const feature of data.features || []) {
    const point = getProjectedDataCenterFeaturePoint(feature);
    if (!point) {
      continue;
    }
    const marker = L.circleMarker(point, {
      radius: 3.5,
      color: scenario.color,
      weight: 1,
      fillColor: scenario.color,
      fillOpacity: 0.8,
    });
    bindHoverPersistentPopup(
      marker,
      buildProjectedDataCenterPopupHTML(feature.properties || {}, scenario.label, weight)
    );
    markerLayer.addLayer(marker);
  }

  const layer = L.layerGroup([polygonLayer, markerLayer]);
  layer.projectedFeatureCount = data.features?.length || 0;

  usProjectedDataCenterLayers.set(layerKey, layer);
  return layer;
}

function buildUsDataCenterControl() {
  if (!mapUiRightEl) {
    return;
  }

  const card = document.createElement("section");
  card.id = "section-us-data-centers";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";

  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "Data Centers";
  header.appendChild(title);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const actualRow = document.createElement("label");
  actualRow.className = "voltage-filter-row";
  const actualCheckbox = document.createElement("input");
  actualCheckbox.type = "checkbox";
  actualCheckbox.checked = usDataCenterVisible;
  const actualSwatch = document.createElement("span");
  actualSwatch.className = "data-center-actual-swatch";
  actualSwatch.setAttribute("aria-hidden", "true");
  const actualText = document.createElement("span");
  actualText.textContent = "Actual data centers";
  const actualCount = appendLegendCount(actualText, 0);
  actualRow.append(actualCheckbox, actualSwatch, actualText);
  body.appendChild(actualRow);

  const projectedTitle = document.createElement("div");
  projectedTitle.className = "voltage-filter-title data-center-group-title";
  projectedTitle.textContent = "Projected data centers";
  const projectedTotalCount = appendLegendCount(projectedTitle, 0);
  projectedTotalCount.classList.add("projected-total-count");
  body.appendChild(projectedTitle);

  for (const scenario of US_PROJECTED_DATA_CENTER_SCENARIOS) {
    const scenarioTitle = document.createElement("div");
    scenarioTitle.className = "data-center-scenario-title data-center-scenario-heading";
    const scenarioCheckbox = document.createElement("input");
    scenarioCheckbox.type = "checkbox";
    scenarioCheckbox.setAttribute("aria-label", `Show all ${scenario.label} projected data centers`);
    const scenarioLabel = document.createElement("span");
    scenarioLabel.textContent = scenario.label;
    const scenarioTotalCount = appendLegendCount(scenarioLabel, 0);
    scenarioTotalCount.dataset.scenarioCount = scenario.key;
    scenarioTitle.append(scenarioCheckbox, scenarioLabel);
    body.appendChild(scenarioTitle);
    const scenarioDataCheckboxes = [];

    const updateScenarioCheckbox = () => {
      const checkedCount = scenarioDataCheckboxes.filter((checkbox) => checkbox.checked).length;
      scenarioCheckbox.checked = checkedCount === scenarioDataCheckboxes.length;
      scenarioCheckbox.indeterminate = checkedCount > 0 && checkedCount < scenarioDataCheckboxes.length;
    };

    scenarioCheckbox.addEventListener("change", () => {
      const nextChecked = scenarioCheckbox.checked;
      for (const checkbox of scenarioDataCheckboxes) {
        if (checkbox.checked !== nextChecked) {
          checkbox.checked = nextChecked;
          checkbox.dispatchEvent(new Event("change"));
        }
      }
    });

    for (const weight of US_PROJECTED_DATA_CENTER_WEIGHTS) {
      const layerKey = `${scenario.key}:${weight}`;
      const row = document.createElement("label");
      row.className = "voltage-filter-row data-center-projected-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const swatch = document.createElement("span");
      swatch.className = "data-center-projected-swatch";
      swatch.style.backgroundColor = scenario.color;
      swatch.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = `${weight}% market gravity`;
      const projectedCount = appendLegendCount(text, 0);
      projectedCount.classList.add("projected-legend-count");
      projectedCount.dataset.scenarioKey = scenario.key;

      row.append(checkbox, swatch, text);
      body.appendChild(row);
      usProjectedDataCenterCheckboxes.set(layerKey, checkbox);
      scenarioDataCheckboxes.push(checkbox);

      checkbox.addEventListener("change", async () => {
        checkbox.disabled = true;
        try {
          const layer = await loadProjectedDataCenterLayer(scenario, weight);
          if (checkbox.checked) {
            layer.addTo(map);
          } else if (map.hasLayer(layer)) {
            map.removeLayer(layer);
          }
          projectedCount.dataset.count = String(layer.projectedFeatureCount || 0);
          setLegendCount(projectedCount, layer.projectedFeatureCount);
          const scenarioCount = [...scenarioDataCheckboxes]
            .map((entry) => Number(entry.dataset.legendCount || 0))
            .reduce((total, count) => total + count, 0);
          setLegendCount(scenarioTotalCount, scenarioCount);
          const projectedCountTotal = [...usProjectedDataCenterLayers.values()]
            .reduce((total, entry) => total + Number(entry.projectedFeatureCount || 0), 0);
          setLegendCount(projectedTotalCount, projectedCountTotal);
          refreshProjectedLegendCounts();
          activateStatusTracking();
        } catch (error) {
          checkbox.checked = false;
          setStatusById("us-data-centers", "warn", `Projected data centers load skipped: ${error?.message || "unknown error"}`);
          console.warn("Projected data centers load skipped", error);
        } finally {
          checkbox.disabled = false;
          updateScenarioCheckbox();
        }
      });

      loadProjectedDataCenterLayer(scenario, weight)
        .then((layer) => {
          projectedCount.dataset.count = String(layer.projectedFeatureCount || 0);
          setLegendCount(projectedCount, layer.projectedFeatureCount);
          refreshProjectedLegendCounts();
        })
        .catch((error) => console.warn(`${scenario.label} projected count unavailable`, error));
    }

    updateScenarioCheckbox();
  }

  card.appendChild(body);
  appendUsLegendCard(card);
  enableSectionCardDrag(card);

  actualCheckbox.addEventListener("change", () => {
    const applyToggle = async () => {
      usDataCenterVisible = actualCheckbox.checked;

      if (usDataCenterVisible && !usDataCenterLoaded) {
        try {
          await loadUsDataCenterLayer();
        } catch (error) {
          setStatusById("us-data-centers", "warn", `US data centers load skipped: ${error?.message || "unknown error"}`);
          console.warn("US data centers load skipped", error);
          usDataCenterVisible = false;
          actualCheckbox.checked = false;
          activateStatusTracking();
          return;
        }
      }

      if (!usDataCenterLayer) {
        activateStatusTracking();
        return;
      }

      if (usDataCenterVisible) {
        usDataCenterLayer.addTo(map);
      } else if (map.hasLayer(usDataCenterLayer)) {
        map.removeLayer(usDataCenterLayer);
      }

      setLegendCount(actualCount, usDataCenterLayer.getLayers().length);

      activateStatusTracking();
    };

    applyToggle();
  });

  loadUsDataCenterLayer()
    .then(() => setLegendCount(actualCount, usDataCenterLayer?.getLayers().length || 0))
    .catch((error) => console.warn("US data-center count unavailable", error));
}

function buildUsReconductoringControl() {
  if (!mapUiRightEl) {
    return;
  }

  const card = document.createElement("section");
  card.id = "section-us-reconductoring";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";

  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "Reconductoring projects";
  header.appendChild(title);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "voltage-filter-container";

  const optionsTitle = document.createElement("label");
  optionsTitle.className = "voltage-filter-title";

  const reconductoringSelectAll = document.createElement("input");
  reconductoringSelectAll.type = "checkbox";

  const regionSelectAll = document.createElement("input");
  regionSelectAll.type = "checkbox";
  regionSelectAll.title = "Enable or disable all ISO region marker areas";

  const optionsTitleSpan = document.createElement("span");
  optionsTitleSpan.textContent = "ISO regions:";

  optionsTitle.appendChild(regionSelectAll);
  optionsTitle.appendChild(optionsTitleSpan);
  const optionsHeader = document.createElement("div");
  optionsHeader.className = "reconductoring-grid reconductoring-grid-header";
  optionsTitle.className = "reconductoring-grid-heading";
  optionsHeader.appendChild(optionsTitle);
  const reconductoringHeading = document.createElement("label");
  reconductoringHeading.className = "reconductoring-grid-heading";
  reconductoringHeading.appendChild(reconductoringSelectAll);
  reconductoringHeading.appendChild(document.createTextNode("Reconduct."));
  const getsHeading = document.createElement("label");
  getsHeading.className = "reconductoring-grid-heading";
  getsHeading.textContent = "GETS";
  optionsHeader.appendChild(reconductoringHeading);
  optionsHeader.appendChild(getsHeading);
  optionsWrap.appendChild(optionsHeader);

  const enabledCheckboxes = [];
  const regionCheckboxes = [];
  const getsCheckboxes = [];
  const getsSelectAll = document.createElement("input");
  getsSelectAll.type = "checkbox";
  getsSelectAll.title = "Enable or disable all GETS layers";
  getsHeading.replaceChildren(getsSelectAll, document.createTextNode("GETS"));

  for (const iso of ISO_RECONDUCTORING_CONFIG) {
    const row = document.createElement("div");
    row.className = "reconductoring-grid reconductoring-grid-row";

    const regionCell = document.createElement("label");
    regionCell.className = "reconductoring-region-cell";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = iso.enabled;
    checkbox.disabled = !iso.enabled;

    const marker = document.createElement("span");
    marker.className = "reconductoring-iso-swatch";
    marker.style.backgroundColor = iso.regionStyle?.color || "#9a6700";
    marker.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.textContent = iso.enabled ? iso.label : `${iso.label} (coming soon)`;
    const labelCount = appendLegendCount(text, 0);
    text.dataset.isoKey = iso.key;
    labelCount.classList.add("reconductoring-label-count");
    row.dataset.isoKey = iso.key;

    regionCell.appendChild(marker);
    const regionCheckbox = document.createElement("input");
    regionCheckbox.type = "checkbox";
    regionCheckbox.checked = iso.enabled;
    regionCheckbox.disabled = !iso.enabled;
    regionCheckbox.title = `Show ${iso.label} marker area`;
    regionCheckbox.addEventListener("change", () => {
      syncUsRegionLayer(iso.key, regionCheckbox.checked);
      updateRegionSelectAll();
    });
    regionCell.insertBefore(regionCheckbox, marker);
    regionCell.appendChild(text);
    row.appendChild(regionCell);

    const reconductoringCell = document.createElement("label");
    reconductoringCell.className = "reconductoring-check-cell";
    reconductoringCell.appendChild(checkbox);
    row.appendChild(reconductoringCell);

    const getsCell = document.createElement("label");
    getsCell.className = "reconductoring-check-cell";
    const getsCheckbox = document.createElement("input");
    getsCheckbox.type = "checkbox";
    const getsAvailable = iso.key === "caiso" || iso.key === "spp";
    getsCheckbox.checked = getsAvailable;
    getsCheckbox.disabled = !getsAvailable;
    getsCheckbox.title = getsAvailable ? "Show GETS projects" : `${iso.label} GETS is not available`;
    getsCheckbox.addEventListener("change", () => {
      syncUsGetsLayer(iso.key, getsCheckbox.checked);
      updateGetsSelectAll();
    });
    getsCell.appendChild(getsCheckbox);
    row.appendChild(getsCell);
    getsCheckboxes.push(getsCheckbox);
    optionsWrap.appendChild(row);
    usReconductoringCheckboxes.set(iso.key, checkbox);
    usRegionCheckboxes.set(iso.key, regionCheckbox);
    usGetsCheckboxes.set(iso.key, getsCheckbox);
    regionCheckboxes.push(regionCheckbox);

    if (iso.enabled) {
      checkbox.addEventListener("change", () => {
        syncUsReconductoringLayer(iso.key, checkbox.checked);
        updateReconductoringSelectAll();
      });
      enabledCheckboxes.push(checkbox);
    } else {
      row.title = `${iso.label} reconductoring is not implemented yet.`;
    }
  }

  const updateReconductoringSelectAll = () => {
    const checkedCount = enabledCheckboxes.filter((cb) => cb.checked).length;
    reconductoringSelectAll.checked = checkedCount > 0;
    reconductoringSelectAll.indeterminate = checkedCount > 0 && checkedCount < enabledCheckboxes.length;
  };

  const updateGetsSelectAll = () => {
    const checkedCount = getsCheckboxes.filter((cb) => cb.checked).length;
    getsSelectAll.checked = checkedCount > 0;
    getsSelectAll.indeterminate = checkedCount > 0 && checkedCount < getsCheckboxes.length;
  };

  const updateRegionSelectAll = () => {
    const checkedCount = regionCheckboxes.filter((cb) => cb.checked).length;
    regionSelectAll.checked = checkedCount > 0;
    regionSelectAll.indeterminate = checkedCount > 0 && checkedCount < regionCheckboxes.length;
  };

  reconductoringSelectAll.addEventListener("change", () => {
    const nextChecked = reconductoringSelectAll.checked;
    for (const cb of enabledCheckboxes) {
      if (cb.checked !== nextChecked) {
        cb.checked = nextChecked;
        cb.dispatchEvent(new Event("change"));
      }
    }
  });

  getsSelectAll.addEventListener("change", () => {
    const nextChecked = getsSelectAll.checked;
    for (const checkbox of getsCheckboxes) {
      if (!checkbox.disabled && checkbox.checked !== nextChecked) {
        checkbox.checked = nextChecked;
        checkbox.dispatchEvent(new Event("change"));
      }
    }
  });

  regionSelectAll.addEventListener("change", () => {
    const nextChecked = regionSelectAll.checked;
    for (const checkbox of regionCheckboxes) {
      if (!checkbox.disabled && checkbox.checked !== nextChecked) {
        checkbox.checked = nextChecked;
        checkbox.dispatchEvent(new Event("change"));
      }
    }
  });

  updateReconductoringSelectAll();
  updateGetsSelectAll();
  updateRegionSelectAll();

  body.appendChild(optionsWrap);

  card.appendChild(body);

  const pcaCard = document.getElementById("section-us-pca");
  appendUsLegendCard(card);

  enableSectionCardDrag(card);

  for (const iso of ISO_RECONDUCTORING_CONFIG.filter((entry) => entry.enabled)) {
    ensureUsReconductoringDataset(iso.key)
      .then((dataset) => {
        const countEl = card.querySelector(
          `[data-iso-key="${iso.key}"] .reconductoring-label-count`
        );
        setLegendCount(countEl, 0);
      })
      .catch((error) => console.warn(`${iso.label} reconductoring count unavailable`, error));
  }
}

async function loadUsPcaLayer() {
  const parser = getShpParser();
  const basePath = `${US_DATA_ROOT}/${encodeURIComponent(US_PCA_BASENAME)}`;
  const shpUrl = makeAbsoluteUrl(`${basePath}.shp`);
  const dbfUrl = makeAbsoluteUrl(`${basePath}.dbf`);
  const prjUrl = makeAbsoluteUrl(`${basePath}.prj`);
  const cpgUrl = makeAbsoluteUrl(`${basePath}.cpg`);

  const [shpBuffer, dbfBuffer, prjText, cpgText] = await Promise.all([
    fetchArrayBuffer(shpUrl),
    fetchArrayBuffer(dbfUrl),
    fetchOptionalText(prjUrl),
    fetchOptionalText(cpgUrl),
  ]);

  const payload = { shp: shpBuffer, dbf: dbfBuffer };
  if (prjText) {
    payload.prj = prjText;
  }
  if (cpgText) {
    payload.cpg = cpgText;
  }

  const parsed = await parser(payload);
  usPcaFeatureCollection = toFeatureCollection(parsed, US_PCA_BASENAME);
  usPcaLoaded = true;
  rebuildUsPcaLayer();
}

function getPowerPlantCategoryColor(categoryLabel, index) {
  const key = String(categoryLabel || "").trim();
  if (key && US_POWER_PLANT_CATEGORY_COLORS[key]) {
    return US_POWER_PLANT_CATEGORY_COLORS[key];
  }

  return getTypeColorByIndex(index);
}

function updateUsTransmissionMasterCheckbox() {
  if (!usTransmissionMasterCheckbox || !usTransmissionVoltageLayers.size) {
    return;
  }

  const values = [...usTransmissionVoltageLayers.values()];
  const visibleCount = values.filter((entry) => entry.visible).length;
  usTransmissionMasterCheckbox.indeterminate = visibleCount > 0 && visibleCount < values.length;
  usTransmissionMasterCheckbox.checked = visibleCount > 0;
}

function createUsTransmissionSwatch(color) {
  const w = 20;
  const h = 12;
  const el = document.createElement("span");
  el.className = "layer-swatch transmission-swatch";
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${color}" stroke-width="2"/></svg>`;
  return el;
}

function usSubstationSvg(size, color, strokeColor) {
  const sw = size > 12 ? 0.8 : 0.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect x="${sw / 2}" y="${sw / 2}" width="${size - sw}" height="${size - sw}" fill="${color}" stroke="${strokeColor}" stroke-width="${sw}"/><line x1="${sw / 2}" y1="${size - sw / 2}" x2="${size - sw / 2}" y2="${sw / 2}" stroke="${strokeColor}" stroke-width="${sw}"/></svg>`;
}

function createUsSubstationIcon(color) {
  const size = 12;
  return L.divIcon({
    html: usSubstationSvg(size, color, "#0b0f0f"),
    className: "substation-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function createUsSubstationSwatch(color) {
  const el = document.createElement("span");
  el.className = "layer-swatch substation-swatch";
  el.innerHTML = usSubstationSvg(12, color, "#0b0f0f");
  return el;
}

function usTriangleSvg(size, color, strokeColor) {
  const sw = 0.6;
  const cx = size / 2;
  const points = `${cx},${sw / 2} ${size - sw / 2},${size - sw / 2} ${sw / 2},${size - sw / 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${points}" fill="${color}" stroke="${strokeColor}" stroke-width="${sw}"/></svg>`;
}

function createUsTapIcon(color) {
  const size = 12;
  return L.divIcon({
    html: usTriangleSvg(size, color, "#0b0f0f"),
    className: "triangle-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function createUsTapSwatch(color) {
  const el = document.createElement("span");
  el.className = "layer-swatch triangle-swatch";
  el.innerHTML = usTriangleSvg(12, color, "#0b0f0f");
  return el;
}

function renderUsVoltageControls() {
  if (!usTransmissionVoltageContainer) {
    return;
  }

  const renderContainer = (container, titleText, filterGroup, multiColumn) => {
    if (!container) {
      return;
    }

    container.innerHTML = "";
    container.classList.toggle("is-multi-column", multiColumn);

    const titleRow = document.createElement("label");
    titleRow.className = "voltage-filter-title";

    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = titleText;

    titleRow.appendChild(selectAllCheckbox);
    titleRow.appendChild(titleSpan);
    container.appendChild(titleRow);

    const target = multiColumn ? document.createElement("div") : container;
    if (multiColumn) {
      target.className = "voltage-filter-grid";
      container.appendChild(target);
    }

    const groupCheckboxes = [];

    for (const [, voltageState] of usTransmissionVoltageLayers.entries()) {
      if (voltageState.group !== filterGroup) {
        continue;
      }

      const row = document.createElement("label");
      row.className = "voltage-filter-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = voltageState.visible;

      const swatch = createUsTransmissionSwatch(voltageState.color);

      const text = document.createElement("span");
      text.textContent = voltageState.displayLabel;
      appendLegendCount(text, voltageState.elementCount);

      checkbox.addEventListener("change", () => {
        voltageState.visible = checkbox.checked;
        if (!usTransmissionLayer) {
          return;
        }

        if (checkbox.checked) {
          usTransmissionLayer.addLayer(voltageState.layer);
        } else {
          usTransmissionLayer.removeLayer(voltageState.layer);
        }

        updateUsTransmissionMasterCheckbox();
        updateSelectAllState();
        activateStatusTracking();
      });

      groupCheckboxes.push({ checkbox, voltageState });

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(text);
      target.appendChild(row);
    }

    const updateSelectAllState = () => {
      const checkedCount = groupCheckboxes.filter((entry) => entry.checkbox.checked).length;
      selectAllCheckbox.checked = checkedCount > 0;
      selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < groupCheckboxes.length;
    };

    selectAllCheckbox.addEventListener("change", () => {
      const nextChecked = selectAllCheckbox.checked;
      for (const entry of groupCheckboxes) {
        if (entry.checkbox.checked !== nextChecked) {
          entry.checkbox.checked = nextChecked;
          entry.checkbox.dispatchEvent(new Event("change"));
        }
      }
    });

    updateSelectAllState();
  };

  renderContainer(usTransmissionVoltageContainer, "Main Voltage Levels:", "primary", false);
}

function updateUsSubstationMasterCheckbox() {
  if (!usSubstationMasterCheckbox || !usSubstationVoltageLayers.size) {
    return;
  }

  const values = [...usSubstationVoltageLayers.values()];
  const visibleCount = values.filter((entry) => entry.visible).length;
  usSubstationMasterCheckbox.indeterminate = visibleCount > 0 && visibleCount < values.length;
  usSubstationMasterCheckbox.checked = visibleCount > 0;
}

function renderUsSubstationVoltageControls() {
  if (!usSubstationVoltageContainer) {
    return;
  }

  const renderContainer = (container, titleText, filterGroup, multiColumn) => {
    if (!container) {
      return;
    }

    container.innerHTML = "";
    container.classList.toggle("is-multi-column", multiColumn);

    const titleRow = document.createElement("label");
    titleRow.className = "voltage-filter-title";

    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = titleText;

    titleRow.appendChild(selectAllCheckbox);
    titleRow.appendChild(titleSpan);
    container.appendChild(titleRow);

    const target = multiColumn ? document.createElement("div") : container;
    if (multiColumn) {
      target.className = "voltage-filter-grid";
      container.appendChild(target);
    }

    const groupCheckboxes = [];

    for (const [, voltageState] of usSubstationVoltageLayers.entries()) {
      if (voltageState.group !== filterGroup) {
        continue;
      }

      const row = document.createElement("label");
      row.className = "voltage-filter-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = voltageState.visible;

      const swatch = createUsSubstationSwatch(voltageState.color);

      const text = document.createElement("span");
      text.textContent = voltageState.displayLabel;
      appendLegendCount(text, voltageState.elementCount);

      checkbox.addEventListener("change", () => {
        voltageState.visible = checkbox.checked;
        if (!usSubstationLayer) {
          return;
        }

        if (checkbox.checked) {
          usSubstationLayer.addLayer(voltageState.layer);
        } else {
          usSubstationLayer.removeLayer(voltageState.layer);
        }

        updateUsSubstationMasterCheckbox();
        updateSelectAllState();
        activateStatusTracking();
      });

      groupCheckboxes.push({ checkbox, voltageState });

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(text);
      target.appendChild(row);
    }

    const updateSelectAllState = () => {
      const checkedCount = groupCheckboxes.filter((entry) => entry.checkbox.checked).length;
      selectAllCheckbox.checked = checkedCount > 0;
      selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < groupCheckboxes.length;
    };

    selectAllCheckbox.addEventListener("change", () => {
      const nextChecked = selectAllCheckbox.checked;
      for (const entry of groupCheckboxes) {
        if (entry.checkbox.checked !== nextChecked) {
          entry.checkbox.checked = nextChecked;
          entry.checkbox.dispatchEvent(new Event("change"));
        }
      }
    });

    updateSelectAllState();
  };

  renderContainer(usSubstationVoltageContainer, "Main Voltage Levels:", "primary", false);
}

function renderUsTapVoltageControls() {
  if (!usTapVoltageContainer) {
    return;
  }

  const renderContainer = (container, titleText, filterGroup, multiColumn) => {
    if (!container) {
      return;
    }

    container.innerHTML = "";
    container.classList.toggle("is-multi-column", multiColumn);

    const titleRow = document.createElement("label");
    titleRow.className = "voltage-filter-title";

    const selectAllCheckbox = document.createElement("input");
    selectAllCheckbox.type = "checkbox";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = titleText;

    titleRow.appendChild(selectAllCheckbox);
    titleRow.appendChild(titleSpan);
    container.appendChild(titleRow);

    const target = multiColumn ? document.createElement("div") : container;
    if (multiColumn) {
      target.className = "voltage-filter-grid";
      container.appendChild(target);
    }

    const groupCheckboxes = [];

    for (const [, voltageState] of usTapVoltageLayers.entries()) {
      if (voltageState.group !== filterGroup) {
        continue;
      }

      const row = document.createElement("label");
      row.className = "voltage-filter-row";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = voltageState.visible;

      const swatch = createUsTapSwatch(voltageState.color);

      const text = document.createElement("span");
      text.textContent = voltageState.displayLabel;
      appendLegendCount(text, voltageState.elementCount);

      checkbox.addEventListener("change", () => {
        voltageState.visible = checkbox.checked;
        if (!usTapLayer) {
          return;
        }

        if (checkbox.checked) {
          usTapLayer.addLayer(voltageState.layer);
        } else {
          usTapLayer.removeLayer(voltageState.layer);
        }

        updateSelectAllState();
        activateStatusTracking();
      });

      groupCheckboxes.push({ checkbox, voltageState });

      row.appendChild(checkbox);
      row.appendChild(swatch);
      row.appendChild(text);
      target.appendChild(row);
    }

    const updateSelectAllState = () => {
      const checkedCount = groupCheckboxes.filter((entry) => entry.checkbox.checked).length;
      selectAllCheckbox.checked = checkedCount > 0;
      selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < groupCheckboxes.length;
    };

    selectAllCheckbox.addEventListener("change", () => {
      const nextChecked = selectAllCheckbox.checked;
      for (const entry of groupCheckboxes) {
        if (entry.checkbox.checked !== nextChecked) {
          entry.checkbox.checked = nextChecked;
          entry.checkbox.dispatchEvent(new Event("change"));
        }
      }
    });

    updateSelectAllState();
  };

  renderContainer(usTapVoltageContainer, "Main Voltage Levels:", "primary", false);
}

function updateUsPowerPlantMasterCheckbox() {
  if (!usPowerPlantMasterCheckbox || !usPowerPlantTypeLayers.size) {
    return;
  }

  const values = [...usPowerPlantTypeLayers.values()];
  const visibleCount = values.filter((entry) => entry.visible).length;
  usPowerPlantMasterCheckbox.indeterminate = visibleCount > 0 && visibleCount < values.length;
  usPowerPlantMasterCheckbox.checked = visibleCount > 0;
}

function renderUsPowerPlantTypeControls() {
  if (!usPowerPlantTypeContainer) {
    return;
  }

  usPowerPlantTypeContainer.innerHTML = "";

  const titleRow = document.createElement("label");
  titleRow.className = "voltage-filter-title";

  const selectAllCheckbox = document.createElement("input");
  selectAllCheckbox.type = "checkbox";

  const titleSpan = document.createElement("span");
  titleSpan.textContent = "By TYPE:";

  titleRow.appendChild(selectAllCheckbox);
  titleRow.appendChild(titleSpan);
  usPowerPlantTypeContainer.appendChild(titleRow);

  const groupCheckboxes = [];

  for (const [typeLabel, typeState] of usPowerPlantTypeLayers.entries()) {
    const row = document.createElement("label");
    row.className = "voltage-filter-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = typeState.visible;

      const swatch = document.createElement("span");
      swatch.className = "layer-swatch";
      swatch.style.backgroundColor = typeState.color;

    const text = document.createElement("span");
    text.textContent = typeLabel;
    appendLegendCount(text, typeState.elementCount);

    checkbox.addEventListener("change", () => {
      typeState.visible = checkbox.checked;
      if (!usPowerPlantLayer) {
        return;
      }

      if (checkbox.checked) {
        usPowerPlantLayer.addLayer(typeState.layer);
      } else {
        usPowerPlantLayer.removeLayer(typeState.layer);
      }

      updateUsPowerPlantMasterCheckbox();
      updatePowerPlantSelectAllState();
      activateStatusTracking();
    });

    groupCheckboxes.push({ checkbox, typeState });

    row.appendChild(checkbox);
    row.appendChild(swatch);
    row.appendChild(text);
    usPowerPlantTypeContainer.appendChild(row);
  }

  const updatePowerPlantSelectAllState = () => {
    const checkedCount = groupCheckboxes.filter((entry) => entry.checkbox.checked).length;
    selectAllCheckbox.checked = checkedCount > 0;
    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < groupCheckboxes.length;
  };

  selectAllCheckbox.addEventListener("change", () => {
    const nextChecked = selectAllCheckbox.checked;
    for (const entry of groupCheckboxes) {
      if (entry.checkbox.checked !== nextChecked) {
        entry.checkbox.checked = nextChecked;
        entry.checkbox.dispatchEvent(new Event("change"));
      }
    }
  });

  updatePowerPlantSelectAllState();
}

function buildUsTransmissionControl() {
  if (!mapUiLeftEl) {
    return;
  }

  const card = document.createElement("section");
  card.id = "section-us-transmission";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";

  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "Transmission lines";
  header.appendChild(title);

  // Add hide/show toggle button
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "section-toggle-btn";
  toggleButton.textContent = "Hide";
  toggleButton.setAttribute("aria-expanded", "true");
  toggleButton.setAttribute("title", "Hide Transmission lines");
  toggleButton.addEventListener("click", () => {
    const collapsed = card.classList.toggle("is-collapsed");
    toggleButton.textContent = collapsed ? "Show" : "Hide";
    toggleButton.setAttribute("aria-expanded", String(!collapsed));
    toggleButton.setAttribute("title", `${collapsed ? "Show" : "Hide"} Transmission lines`);
  });
  header.appendChild(toggleButton);

  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const voltageContainer = document.createElement("div");
  voltageContainer.className = "voltage-filter-container";
  body.appendChild(voltageContainer);

  card.appendChild(body);
  mapUiLeftEl.appendChild(card);
  enableSectionCardDrag(card);

  usTransmissionVoltageContainer = voltageContainer;
}

function buildUsSubstationControl() {
  if (!mapUiLeftEl) {
    return;
  }


  // Substations card
  const card = document.createElement("section");
  card.id = "section-us-substations";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";

  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "Substations";
  header.appendChild(title);

  // Add hide/show toggle button
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "section-toggle-btn";
  toggleButton.textContent = "Hide";
  toggleButton.setAttribute("aria-expanded", "true");
  toggleButton.setAttribute("title", "Hide Substations");
  toggleButton.addEventListener("click", () => {
    const collapsed = card.classList.toggle("is-collapsed");
    toggleButton.textContent = collapsed ? "Show" : "Hide";
    toggleButton.setAttribute("aria-expanded", String(!collapsed));
    toggleButton.setAttribute("title", `${collapsed ? "Show" : "Hide"} Substations`);
  });
  header.appendChild(toggleButton);

  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const voltageContainer = document.createElement("div");
  voltageContainer.className = "voltage-filter-container";
  body.appendChild(voltageContainer);

  card.appendChild(body);
  mapUiLeftEl.appendChild(card);
  enableSectionCardDrag(card);

  // TAPs card
  const tapCard = document.createElement("section");
  tapCard.id = "section-us-taps";
  tapCard.className = "section-card";

  const tapHeader = document.createElement("div");
  tapHeader.className = "section-card-header";

  const tapTitle = document.createElement("h2");
  tapTitle.className = "section-card-title";
  tapTitle.textContent = "US TAPs";
  tapHeader.appendChild(tapTitle);

  // Add hide/show toggle button
  const tapToggleButton = document.createElement("button");
  tapToggleButton.type = "button";
  tapToggleButton.className = "section-toggle-btn";
  tapToggleButton.textContent = "Hide";
  tapToggleButton.setAttribute("aria-expanded", "true");
  tapToggleButton.setAttribute("title", "Hide US TAPs");
  tapToggleButton.addEventListener("click", () => {
    const collapsed = tapCard.classList.toggle("is-collapsed");
    tapToggleButton.textContent = collapsed ? "Show" : "Hide";
    tapToggleButton.setAttribute("aria-expanded", String(!collapsed));
    tapToggleButton.setAttribute("title", `${collapsed ? "Show" : "Hide"} US TAPs`);
  });
  tapHeader.appendChild(tapToggleButton);

  tapCard.appendChild(tapHeader);

  const tapBody = document.createElement("div");
  tapBody.className = "section-card-body";

  const tapVoltageContainer = document.createElement("div");
  tapVoltageContainer.className = "voltage-filter-container";
  tapBody.appendChild(tapVoltageContainer);

  tapCard.appendChild(tapBody);
  appendUsLegendCard(tapCard);
  enableSectionCardDrag(tapCard);

  usSubstationVoltageContainer = voltageContainer;
  usTapVoltageContainer = tapVoltageContainer;

}

function buildUsPowerPlantControl() {
  if (!mapUiRightEl) {
    return;
  }

  const card = document.createElement("section");
  card.id = "section-us-power-plants";
  card.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-card-header";

  const title = document.createElement("h2");
  title.className = "section-card-title";
  title.textContent = "Power plants";
  header.appendChild(title);

  // Add hide/show toggle button
  const toggleButton = document.createElement("button");
  toggleButton.type = "button";
  toggleButton.className = "section-toggle-btn";
  toggleButton.textContent = "Hide";
  toggleButton.setAttribute("aria-expanded", "true");
  toggleButton.setAttribute("title", "Hide Power plants");
  toggleButton.addEventListener("click", () => {
    const collapsed = card.classList.toggle("is-collapsed");
    toggleButton.textContent = collapsed ? "Show" : "Hide";
    toggleButton.setAttribute("aria-expanded", String(!collapsed));
    toggleButton.setAttribute("title", `${collapsed ? "Show" : "Hide"} Power plants`);
  });
  header.appendChild(toggleButton);

  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "section-card-body";

  const typeContainer = document.createElement("div");
  typeContainer.className = "voltage-filter-container";
  body.appendChild(typeContainer);

  card.appendChild(body);
  mapUiLeftEl.appendChild(card);
  enableSectionCardDrag(card);

  usPowerPlantTypeContainer = typeContainer;
}

async function loadUsTransmissionLayer() {
  const parser = getShpParser();
  const zipUrl = makeAbsoluteUrl(`${US_DATA_ROOT}/${encodeURIComponent(US_TRANSMISSION_BASENAME)}.zip`);
  const zipBuffer = await fetchArrayBuffer(zipUrl);
  const parsed = await parser(zipBuffer);
  const collection = toFeatureCollection(parsed, US_TRANSMISSION_BASENAME);

  // Group features by voltage
  const featuresByVoltage = new Map();
  for (const feature of collection.features || []) {
    const rawVoltageLabel = normalizeVoltageLabel(feature);
    const normalizedVoltage = normalizeVoltageValueLabel(rawVoltageLabel);
    const currentType = getCurrentTypeFromVoltClass(feature?.properties || {});

    let group = "other-levels";
    let displayLabel = String(rawVoltageLabel || "Unknown").trim() || "Unknown";
    let sortVoltage = -1;
    let sortPrimaryRank = Number.POSITIVE_INFINITY;

    const isNotDetermined = normalizedVoltage === "-99999" || normalizedVoltage === "-999999";
    if (normalizedVoltage && !isNotDetermined) {
      const transmissionBucket = getTransmissionVoltageBucket(Number(normalizedVoltage), currentType);
      if (transmissionBucket) {
        group = "primary";
        displayLabel = transmissionBucket.label;
        sortVoltage = transmissionBucket.sortVoltage;
        sortPrimaryRank = transmissionBucket.sortRank;
      } else {
        group = "other-levels";
        displayLabel = formatTransmissionVoltageDisplayLabel(normalizedVoltage, currentType);
        sortVoltage = Number(normalizedVoltage);
        sortPrimaryRank = getPrimaryVoltageSortRank(normalizedVoltage);
      }
    } else if (isNotDetermined) {
      group = "primary";
      displayLabel = "Not Determined";
      sortPrimaryRank = 99;
    }

    const key = `${displayLabel}||${group}`;
    if (!featuresByVoltage.has(key)) {
      featuresByVoltage.set(key, {
        features: [],
        displayLabel,
        group,
        sortVoltage,
        sortPrimaryRank,
      });
    }
    featuresByVoltage.get(key).features.push(feature);
  }

  usTransmissionLayer = L.layerGroup();
  usTransmissionVoltageLayers = new Map();

  // Sort voltage groups for display order
  const groupOrder = { primary: 0, "other-levels": 1 };
  const sortedEntries = [...featuresByVoltage.values()].sort((a, b) => {
    const groupDelta = (groupOrder[a.group] ?? 99) - (groupOrder[b.group] ?? 99);
    if (groupDelta !== 0) {
      return groupDelta;
    }
    if (a.group === "primary" && b.group === "primary" && a.sortPrimaryRank !== b.sortPrimaryRank) {
      return a.sortPrimaryRank - b.sortPrimaryRank;
    }
    if (a.sortVoltage !== b.sortVoltage) {
      return b.sortVoltage - a.sortVoltage;
    }
    return a.displayLabel.localeCompare(b.displayLabel);
  });

  sortedEntries.forEach((entry, index) => {
    const color = getVoltageColorByIndex(index);
    const defaultVoltageMatch = entry.displayLabel.match(/^-?\d+(?:\.\d+)?/);
    const defaultVoltage = defaultVoltageMatch ? defaultVoltageMatch[0] : null;
    const visibleByDefault = false;
    const voltageLayer = L.geoJSON(entry.features, {
      style: {
        color,
        weight: 1.6,
        opacity: 0.88,
      },
      onEachFeature: (feature, layer) => {
        bindHoverPersistentPopup(layer, buildPopupHTML(feature));
      },
    });
    if (visibleByDefault) {
      usTransmissionLayer.addLayer(voltageLayer);
    }
    usTransmissionVoltageLayers.set(entry.displayLabel, {
      layer: voltageLayer,
      visible: visibleByDefault,
      color,
      elementCount: entry.features.length,
      displayLabel: entry.displayLabel,
      group: entry.group,
    });
  });

  usTransmissionLayer.addTo(map);
  renderUsVoltageControls();
  updateUsTransmissionMasterCheckbox();
}

async function loadUsPowerPlantLayer() {
  const csvUrl = makeAbsoluteUrl(`${US_DATA_ROOT}/${encodeURIComponent(US_POWER_PLANTS_FILENAME)}`);
  const csvText = await fetchText(csvUrl);
  const records = parseCsvText(csvText);

  const preferredCategoryByType = new Map();
  const categoryCountByType = new Map();

  for (const record of records) {
    const typeKey = normalizeTypeKey(record.TYPE);
    const category = cleanNaicsLabel(record.NAICS_DESC);
    if (!typeKey || !category || category === "Other" || category === "Not Available") {
      continue;
    }

    if (!categoryCountByType.has(typeKey)) {
      categoryCountByType.set(typeKey, new Map());
    }
    const counts = categoryCountByType.get(typeKey);
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  for (const [typeKey, counts] of categoryCountByType.entries()) {
    const preferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (preferred) {
      preferredCategoryByType.set(typeKey, preferred);
    }
  }

  const recordsByCategory = new Map();
  const capacityValuesMw = [];
  let filteredOutCount = 0;

  for (const record of records) {
    const latitude = parseNumericValue(record.LATITUDE);
    const longitude = parseNumericValue(record.LONGITUDE);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      filteredOutCount += 1;
      continue;
    }

    const categoryLabel = resolvePowerPlantCategoryLabel(record, preferredCategoryByType);
    const capacityMw = extractPowerPlantCapacityMw(record);
    if (!recordsByCategory.has(categoryLabel)) {
      recordsByCategory.set(categoryLabel, []);
    }
    recordsByCategory.get(categoryLabel).push({
      ...record,
      __lat: latitude,
      __lon: longitude,
      __category: categoryLabel,
      __capacityMw: capacityMw,
    });
    if (Number.isFinite(capacityMw)) {
      capacityValuesMw.push(capacityMw);
    }
  }

  const minCapacityMw = capacityValuesMw.length ? Math.min(...capacityValuesMw) : null;
  const maxCapacityMw = capacityValuesMw.length ? Math.max(...capacityValuesMw) : null;

  const sortedTypes = [...recordsByCategory.keys()].sort((a, b) => a.localeCompare(b));
  usPowerPlantLayer = L.layerGroup();
  usPowerPlantTypeLayers = new Map();

  sortedTypes.forEach((typeLabel, index) => {
    const typeRows = recordsByCategory.get(typeLabel) || [];
    const color = getPowerPlantCategoryColor(typeLabel, index);
    const visibleByDefault = false;
    const typeLayer = L.layerGroup();

    for (const row of typeRows) {
      const markerRadius = getPowerPlantRadiusForMw(row.__capacityMw, minCapacityMw, maxCapacityMw);
      const marker = L.circleMarker([row.__lat, row.__lon], {
        radius: markerRadius,
        color,
        weight: 1.1,
        fillColor: color,
        fillOpacity: 0.9,
      });

      bindHoverPersistentPopup(marker, buildPowerPlantPopupHTML(row));

      typeLayer.addLayer(marker);
    }

    if (visibleByDefault) {
      usPowerPlantLayer.addLayer(typeLayer);
    }

    usPowerPlantTypeLayers.set(typeLabel, {
      layer: typeLayer,
      visible: visibleByDefault,
      color,
      count: typeRows.length,
      elementCount: typeRows.length,
    });
  });

  usPowerPlantLayer.addTo(map);
  renderUsPowerPlantTypeControls();
  updateUsPowerPlantMasterCheckbox();
}

async function initializeUsMap() {
  initializeThemeToggle();
  initializeCountrySwitcherNavigation();
  initializeUsLegendDrawer();
  initializeUsLayerDrawer();
  buildUsSubstationControl();
  buildUsTransmissionControl();
  buildUsPcaControl();
  buildUsReconductoringControl();
  buildUsDataCenterControl();
  buildUsPowerPlantControl();
  enableCardDrag(mapTitleCardEl);
  window.addEventListener("resize", refreshResponsiveCardLayout);

  setLoadingOverlayVisible(true);

  try {
    await Promise.all([
      loadUsTransmissionLayer(),
      loadUsSubstationLayer(),
      ...ISO_RECONDUCTORING_CONFIG
        .filter((entry) => entry.enabled)
        .map((entry) => syncUsReconductoringLayer(entry.key, true)),
      ...ISO_RECONDUCTORING_CONFIG
        .filter((entry) => entry.key === "caiso" || entry.key === "spp")
        .map((entry) => syncUsGetsLayer(entry.key, true)),
      ...ISO_RECONDUCTORING_CONFIG
        .filter((entry) => entry.enabled)
        .map((entry) => syncUsRegionLayer(entry.key, true)),
    ]);
  } catch (error) {
    setStatus("us-map", "error", `US data load failed: ${error?.message || "unknown error"}`);
    console.error("US data load failed", error);
  } finally {
    setLoadingOverlayVisible(false);
  }

  // Load heavy, non-default content after first paint.
  loadUsPowerPlantLayer().catch((error) => {
    setStatus("us-power-plants", "warn", `US power plants load delayed/failed: ${error?.message || "unknown error"}`);
    console.warn("US power plants load delayed/failed", error);
  });
}

initializeUsMap();
