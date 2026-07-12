"use strict";

const EARTH_RADIUS_KM = 6371;
const STEP_KM = 15;
const MAX_KM = 20000;
const REFINE_ITERATIONS = 8;
const YIELD_EVERY = 60; // steps between UI-thread yields

const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

const els = {
  enableBtn: document.getElementById("enableBtn"),
  scanBtn: document.getElementById("scanBtn"),
  needle: document.getElementById("needle"),
  headingReadout: document.getElementById("headingReadout"),
  locationReadout: document.getElementById("locationReadout"),
  result: document.getElementById("result"),
  status: document.getElementById("status"),
};

let features = null; // loaded + indexed land polygons
let currentHeading = null;
let currentPosition = null; // {lat, lon}

// ---------- geometry helpers ----------

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(lat);
  const lambda1 = toRad(lon);

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) +
    Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );

  let lonDeg = toDeg(lambda2);
  lonDeg = ((lonDeg + 540) % 360) - 180; // normalize to (-180, 180]
  return { lat: toDeg(phi2), lon: lonDeg };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInGeometry(x, y, geometry) {
  if (geometry.type === "Polygon") {
    return pointInPolygonRings(x, y, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    for (const poly of geometry.coordinates) {
      if (pointInPolygonRings(x, y, poly)) return true;
    }
    return false;
  }
  return false;
}

function computeBBox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const depth = geometry.type === "Polygon" ? 2 : 3;
  (function scan(coords, d) {
    if (d === 0) {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) scan(c, d - 1);
  })(geometry.coordinates, depth);
  return [minX, minY, maxX, maxY];
}

function findFeatureAt(lon, lat) {
  for (const f of features) {
    const b = f.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (pointInGeometry(lon, lat, f.geometry)) return f;
  }
  return null;
}

function cardinal(deg) {
  return DIRS[Math.round(deg / 22.5) % 16];
}

// ---------- data loading ----------

async function loadLandData() {
  const res = await fetch("data/countries.geojson");
  const geojson = await res.json();
  features = geojson.features.map((f) => ({
    name: f.properties.name,
    continent: f.properties.continent,
    geometry: f.geometry,
    bbox: computeBBox(f.geometry),
  }));
}

// ---------- sensors ----------

function updateCompassUI(heading) {
  currentHeading = heading;
  els.needle.style.transform = `rotate(${heading}deg)`;
  els.headingReadout.textContent = `${Math.round(heading)}° ${cardinal(heading)}`;
  maybeEnableScan();
}

function handleOrientation(event) {
  let heading;
  if (typeof event.webkitCompassHeading === "number" && !Number.isNaN(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading; // iOS Safari: already 0=N, clockwise
  } else if (event.alpha !== null && event.alpha !== undefined) {
    heading = 360 - event.alpha; // best-effort fallback for other browsers
  } else {
    return;
  }
  heading = (heading + 360) % 360;
  updateCompassUI(heading);
}

function updateLocationUI() {
  if (!currentPosition) return;
  const { lat, lon } = currentPosition;
  els.locationReadout.textContent = `Location: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  maybeEnableScan();
}

function maybeEnableScan() {
  if (currentHeading !== null && currentPosition && features) {
    els.scanBtn.disabled = false;
  }
}

function startGeolocation() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation isn't available in this browser.", true);
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      currentPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      updateLocationUI();
    },
    (err) => {
      setStatus(`Location error: ${err.message}`, true);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

async function startOrientation() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === "function") {
    try {
      const result = await DOE.requestPermission();
      if (result !== "granted") {
        setStatus("Compass permission was not granted.", true);
        return;
      }
    } catch (e) {
      setStatus(`Compass permission error: ${e.message}`, true);
      return;
    }
  }
  window.addEventListener("deviceorientation", handleOrientation, true);
}

function setStatus(text, isError) {
  els.status.textContent = text;
  els.status.style.color = isError ? "var(--danger)" : "";
}

// ---------- search ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findLandmass(startLat, startLon, heading) {
  const startFeature = findFeatureAt(startLon, startLat);
  let leftStartDistance = startFeature === null ? 0 : null;

  for (let d = STEP_KM, i = 0; d <= MAX_KM; d += STEP_KM, i++) {
    const pt = destinationPoint(startLat, startLon, heading, d);
    const feat = findFeatureAt(pt.lon, pt.lat);

    if (feat === null) {
      if (leftStartDistance === null) leftStartDistance = d;
    } else if (feat !== startFeature || leftStartDistance !== null) {
      // refine the exact crossing distance via bisection
      let lo = d - STEP_KM, hi = d;
      for (let r = 0; r < REFINE_ITERATIONS; r++) {
        const mid = (lo + hi) / 2;
        const midPt = destinationPoint(startLat, startLon, heading, mid);
        const midFeat = findFeatureAt(midPt.lon, midPt.lat);
        if (midFeat === feat) hi = mid; else lo = mid;
      }
      return {
        feature: feat,
        distanceKm: hi,
        seaCrossedKm: leftStartDistance === null ? 0 : hi - leftStartDistance,
        point: destinationPoint(startLat, startLon, heading, hi),
      };
    }

    if (i % YIELD_EVERY === 0) await sleep(0);
  }
  return null;
}

// ---------- UI flow ----------

function renderResult(startLat, startLon, heading, outcome) {
  els.result.hidden = false;
  els.result.classList.remove("error");

  if (!outcome) {
    els.result.classList.add("error");
    els.result.innerHTML = `
      <h2>Nothing but ocean</h2>
      <p>No land was found within 20,000&nbsp;km along that heading &mdash; you're likely looking across open ocean.</p>
    `;
    return;
  }

  const { feature, distanceKm, seaCrossedKm } = outcome;
  const label = feature.name || "Unnamed landmass";
  els.result.innerHTML = `
    <h2>${label}</h2>
    <p>Heading <strong>${Math.round(heading)}° ${cardinal(heading)}</strong> from your location, the next land is
      <span class="distance">${Math.round(distanceKm).toLocaleString()} km</span> away.</p>
    <p class="meta">${feature.continent ? `Continent: ${feature.continent} &middot; ` : ""}Sea crossed: ~${Math.round(seaCrossedKm).toLocaleString()} km</p>
  `;
}

async function runScan() {
  if (currentHeading === null || !currentPosition || !features) return;
  const heading = currentHeading;
  const { lat, lon } = currentPosition;

  els.scanBtn.disabled = true;
  els.result.hidden = true;
  setStatus("Scanning the horizon…");

  try {
    const outcome = await findLandmass(lat, lon, heading);
    renderResult(lat, lon, heading, outcome);
    setStatus("");
  } catch (e) {
    setStatus(`Something went wrong: ${e.message}`, true);
  } finally {
    els.scanBtn.disabled = false;
  }
}

async function init() {
  setStatus("Loading coastline data…");
  try {
    await loadLandData();
    setStatus("");
  } catch (e) {
    setStatus("Failed to load land data. Check your connection and reload.", true);
  }

  els.enableBtn.addEventListener("click", async () => {
    els.enableBtn.disabled = true;
    setStatus("Requesting permissions…");
    await startOrientation();
    startGeolocation();
    setStatus("");
    els.enableBtn.textContent = "Sensors enabled";
  });

  els.scanBtn.addEventListener("click", runScan);
}

init();
