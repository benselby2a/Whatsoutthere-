"use strict";

const EARTH_RADIUS_KM = 6371;
const STEP_KM = 12;
const MAX_KM = 20000;
const REFINE_ITERATIONS = 9;
const TARGET_LAND = 3; // how many countries to report along the heading
const KM_PER_MILE = 1.609344;
const HEADING_EPSILON = 1.5; // deg of change before we re-run the trace
const LIVE_INTERVAL_MS = 180; // min gap between live recomputes
const MOVE_EPSILON_KM = 0.5; // location change before we re-run the trace

const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

const els = {
  enableBtn: document.getElementById("enableBtn"),
  compassRose: document.getElementById("compassRose"),
  pointingLabel: document.getElementById("pointingLabel"),
  headingReadout: document.getElementById("headingReadout"),
  locationReadout: document.getElementById("locationReadout"),
  result: document.getElementById("result"),
  status: document.getElementById("status"),
};

let landFeatures = null;
let marineFeatures = null;
let cities = null;
let currentHeading = null;
let currentPosition = null; // {lat, lon}
let roseAngle = 0; // continuous (unwrapped) rose rotation, for smooth turns
let liveTimer = null;
let lastRendered = { heading: null, lat: null, lon: null };
let geoWatchId = null;

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

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
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

function bboxContains(b, lon, lat) {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

function findLandAt(lon, lat) {
  for (const f of landFeatures) {
    if (!bboxContains(f.bbox, lon, lat)) continue;
    if (pointInGeometry(lon, lat, f.geometry)) return f;
  }
  return null;
}

// Name the sea/ocean at a point, preferring the most specific (smallest) polygon.
function seaNameAt(lon, lat) {
  let best = null;
  let bestArea = Infinity;
  for (const f of marineFeatures) {
    if (!bboxContains(f.bbox, lon, lat)) continue;
    if (pointInGeometry(lon, lat, f.geometry)) {
      if (f.area < bestArea) {
        bestArea = f.area;
        best = f.name;
      }
    }
  }
  return best;
}

function nearestCity(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const c of cities) {
    const d = haversineKm(lat, lon, c.y, c.x);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best ? { name: best.n, country: best.c, distKm: bestDist } : null;
}

function cardinal(deg) {
  return DIRS[Math.round(deg / 22.5) % 16];
}

const COMPASS_WORDS = { N: "north", E: "east", S: "south", W: "west" };
function cardinalWords(deg) {
  return cardinal(deg)
    .split("")
    .map((c) => COMPASS_WORDS[c])
    .join("-");
}

function angleDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function km(v) { return `${Math.round(v).toLocaleString()} km`; }
function miles(v) { return `${Math.round(v / KM_PER_MILE).toLocaleString()} mi`; }
function dist(v) { return `${miles(v)} (${km(v)})`; }

// ---------- data loading ----------

async function loadData() {
  const [countriesRes, marineRes, citiesRes] = await Promise.all([
    fetch("data/countries.geojson"),
    fetch("data/marine.geojson"),
    fetch("data/cities.json"),
  ]);
  const [countries, marine, citiesJson] = await Promise.all([
    countriesRes.json(),
    marineRes.json(),
    citiesRes.json(),
  ]);

  landFeatures = countries.features.map((f) => ({
    name: f.properties.name,
    continent: f.properties.continent,
    geometry: f.geometry,
    bbox: computeBBox(f.geometry),
  }));

  marineFeatures = marine.features.map((f) => {
    const bbox = computeBBox(f.geometry);
    return {
      name: f.properties.name,
      geometry: f.geometry,
      bbox,
      area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]),
    };
  });

  cities = citiesJson.cities;
}

// ---------- sensors ----------

function updateCompassUI(heading) {
  currentHeading = heading;

  // Rotate the rose so N points to magnetic north. Unwrap the target angle so
  // the dial always turns the short way (e.g. 359°→1° doesn't spin backwards).
  const target = -heading;
  roseAngle += ((target - roseAngle + 540) % 360) - 180;
  els.compassRose.style.transform = `rotate(${roseAngle}deg)`;

  els.headingReadout.textContent = `${Math.round(heading)}° ${cardinal(heading)}`;
  els.pointingLabel.textContent = `Facing ${cardinalWords(heading)}`;
  scheduleLiveScan();
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
  scheduleLiveScan();
}

function allowEnableRetry() {
  els.enableBtn.disabled = false;
  els.enableBtn.textContent = "Enable Compass & Location";
}

function startGeolocation() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation isn't available in this browser.", true);
    return;
  }
  // Avoid stacking watchers if the user taps Enable again after an error.
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      currentPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      updateLocationUI();
    },
    (err) => {
      // Use numeric codes rather than the inherited constants so the branch is
      // robust across engines: 1=denied, 2=unavailable, 3=timeout.
      if (err.code === 1) {
        setStatus(
          "Location permission denied. On iPhone check Settings → Privacy & Security → " +
            "Location Services is On AND scroll to Safari Websites → set it to \"While Using\" " +
            "(this is separate from the main switch, and the usual reason it works on iPad but " +
            "not iPhone). If you tapped \"Don't Allow\" before, clear it via Settings → Safari → " +
            "Clear History and Website Data, then reload and tap Enable again.",
          true
        );
        allowEnableRetry();
      } else if (err.code === 2) {
        setStatus("Your location is currently unavailable — try again with a clearer view of the sky.", true);
        allowEnableRetry();
      } else if (err.code === 3) {
        setStatus("Timed out getting your location. Tap Enable to retry.", true);
        allowEnableRetry();
      } else {
        setStatus(`Location error: ${err.message}`, true);
        allowEnableRetry();
      }
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

// ---------- route tracing ----------

// Bisection: find the distance at which we enter `target` (a land feature or null),
// somewhere between loKm and hiKm.
function refineBoundary(startLat, startLon, heading, target, loKm, hiKm) {
  let lo = loKm, hi = hiKm;
  for (let r = 0; r < REFINE_ITERATIONS; r++) {
    const mid = (lo + hi) / 2;
    const p = destinationPoint(startLat, startLon, heading, mid);
    if (findLandAt(p.lon, p.lat) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Walk outward and record the ordered sequence of land/sea segments until we've
// crossed TARGET_LAND distinct countries (the one you're on counts as the first).
function traceRoute(startLat, startLon, heading) {
  let openFeat = findLandAt(startLon, startLat);
  let open = { feat: openFeat, startKm: 0, startPt: { lat: startLat, lon: startLon } };
  const segments = [];
  let landOpened = openFeat ? 1 : 0;
  let truncated = true;

  for (let d = STEP_KM; d <= MAX_KM; d += STEP_KM) {
    const pt = destinationPoint(startLat, startLon, heading, d);
    const feat = findLandAt(pt.lon, pt.lat);

    if (feat !== open.feat) {
      const boundary = refineBoundary(startLat, startLon, heading, feat, d - STEP_KM, d);
      const boundaryPt = destinationPoint(startLat, startLon, heading, boundary);
      open.endKm = boundary;
      segments.push(open);
      open = { feat, startKm: boundary, startPt: boundaryPt };

      if (feat) {
        landOpened++;
        if (landOpened >= TARGET_LAND) {
          // We've just entered the final country to report; landfall is enough.
          segments.push(open);
          truncated = false;
          break;
        }
      }
    }
  }

  if (truncated && open.endKm === undefined) {
    open.endKm = MAX_KM;
    open.truncated = true;
    segments.push(open);
  }

  return segments;
}

// ---------- rendering ----------

function renderResult(startLat, startLon, heading, segments) {
  els.result.hidden = false;
  els.result.classList.remove("error");

  const landCount = segments.filter((s) => s.feat).length;
  if (landCount === 0) {
    els.result.classList.add("error");
    els.result.innerHTML = `
      <h2>Nothing but open water</h2>
      <p>No land within ${dist(MAX_KM)} along ${Math.round(heading)}° ${cardinal(heading)} — you're looking out across open ocean.</p>
    `;
    return;
  }

  const items = [];
  let landIndex = 0;

  for (const seg of segments) {
    if (seg.feat) {
      landIndex++;
      const city = nearestCity(seg.startPt.lat, seg.startPt.lon);
      const cityLine = city
        ? `Nearest city: <strong>${city.name}</strong>${city.country && city.country !== seg.feat.name ? ` (${city.country})` : ""} · ${dist(city.distKm)} away`
        : "";

      let where;
      if (seg.startKm === 0) {
        // The landmass you're standing on.
        where = seg.truncated
          ? `You're here — coastline more than ${dist(seg.endKm)} ahead`
          : `You're here — leaving in about ${dist(seg.endKm)}`;
      } else {
        where = `Landfall at about ${dist(seg.startKm)}`;
      }

      items.push(`
        <li class="route-land">
          <div class="route-num">${landIndex}</div>
          <div class="route-body">
            <div class="route-name">${seg.feat.name || "Unnamed land"}</div>
            <div class="route-sub">${where}</div>
            ${cityLine ? `<div class="route-city">${cityLine}</div>` : ""}
          </div>
        </li>
      `);
    } else if (seg.startKm > 0 || seg.endKm !== undefined) {
      // A stretch of sea between landmasses (skip a trailing open-ended one).
      if (seg.endKm === undefined) continue;
      const midKm = (seg.startKm + seg.endKm) / 2;
      const midPt = destinationPoint(startLat, startLon, heading, midKm);
      const name = seaNameAt(midPt.lon, midPt.lat) || "Open sea";
      const width = seg.endKm - seg.startKm;
      items.push(`
        <li class="route-sea">
          <span class="route-sea-name">🌊 ${name}</span>
          <span class="route-sea-width">${dist(width)} across</span>
        </li>
      `);
    }
  }

  els.result.innerHTML = `
    <h2>Heading ${Math.round(heading)}° ${cardinal(heading)}<span class="live-badge"><span class="live-dot"></span>Live</span></h2>
    <p class="result-lead">Crossings from your location, in order:</p>
    <ol class="route">${items.join("")}</ol>
  `;
}

// Recompute + render, but only when the heading or position has actually moved
// enough to matter, and no more often than LIVE_INTERVAL_MS.
function scheduleLiveScan() {
  if (currentHeading === null || !currentPosition || !landFeatures) return;
  if (liveTimer !== null) return;
  liveTimer = setTimeout(runLiveScan, LIVE_INTERVAL_MS);
}

function runLiveScan() {
  liveTimer = null;
  if (currentHeading === null || !currentPosition || !landFeatures) return;

  const { lat, lon } = currentPosition;
  const heading = currentHeading;

  const turned =
    lastRendered.heading === null ||
    angleDelta(heading, lastRendered.heading) >= HEADING_EPSILON;
  const moved =
    lastRendered.lat === null ||
    haversineKm(lastRendered.lat, lastRendered.lon, lat, lon) >= MOVE_EPSILON_KM;
  if (!turned && !moved) return;

  try {
    const segments = traceRoute(lat, lon, heading);
    renderResult(lat, lon, heading, segments);
    lastRendered = { heading, lat, lon };
    setStatus("");
  } catch (e) {
    setStatus(`Something went wrong: ${e.message}`, true);
  }
}

// ---------- init ----------

async function init() {
  setStatus("Loading map data…");
  try {
    await loadData();
    setStatus("");
  } catch (e) {
    setStatus("Failed to load map data. Check your connection and reload.", true);
  }

  els.enableBtn.addEventListener("click", () => {
    els.enableBtn.disabled = true;
    els.enableBtn.textContent = "Sensors enabled";
    els.pointingLabel.textContent = "Move your device to wake the compass";
    setStatus("Waiting for compass and GPS…");
    // Kick off BOTH permission requests synchronously, while we still have the
    // user activation from this tap. iOS Safari (iPhone especially) denies a
    // geolocation prompt that fires after `await`-ing the orientation dialog,
    // so we must not await before calling watchPosition(). Set the status
    // first so a permission error (sync or async) replaces it rather than the
    // other way round.
    startGeolocation();
    startOrientation();
  });
}

init();
