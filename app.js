"use strict";

const EARTH_RADIUS_KM = 6371;
const STEP_KM = 12;
const MAX_KM = 20000;
const REFINE_ITERATIONS = 9;
const MAX_DESTINATIONS = 3; // countries ahead to look for along the heading
const KM_PER_MILE = 1.609344;
const DEST_GAP_KM = 2000 * KM_PER_MILE; // drop a 2nd/3rd dest farther than this past the previous
const HEADING_EPSILON = 1.5; // deg of change before we re-run the trace
const MOVE_EPSILON_KM = 0.5; // location change before we re-run the trace
const UI_HEADING_EPSILON = 0.5; // deg of change before we touch the compass DOM
const SETTLE_MS = 200; // wait for the turn to settle before re-tracing the route
const BIG_DRIFT_DEG = 25; // re-trace immediately once the heading drifts this far

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
  status: document.getElementById("status"),
  map: document.getElementById("map"),
  mapEmpty: document.getElementById("mapEmpty"),
  dotCompass: document.getElementById("dotCompass"),
  dotLocation: document.getElementById("dotLocation"),
  dotNetwork: document.getElementById("dotNetwork"),
  wootBtn: document.getElementById("wootBtn"),
  wootPanel: document.getElementById("wootPanel"),
  wootTitle: document.getElementById("wootTitle"),
  wootMeta: document.getElementById("wootMeta"),
  wootList: document.getElementById("wootList"),
  wootClose: document.getElementById("wootClose"),
};

let compassGotReading = false;

function setPermStatus(kind, state) {
  const dot = kind === "compass" ? els.dotCompass : kind === "location" ? els.dotLocation : els.dotNetwork;
  if (dot) dot.className = "dot " + state;
}

let landFeatures = null;
let marineFeatures = null;
let cities = null;
let sealife = null;
let wootData = null; // current "who's out there" context
let currentHeading = null;
let currentPosition = null; // {lat, lon}
let roseAngle = 0; // continuous (unwrapped) rose rotation, for smooth turns
let liveTimer = null;
let lastRendered = { heading: null, lat: null, lon: null };
let geoWatchId = null;
let lastMapArgs = null;
let sensorsOn = false; // user has tapped Enable
let orientationGranted = false;
let pendingHeading = null;
let orientationRaf = null;
let lastAppliedHeading = null;
let mapHeading = null; // eased heading the map is currently drawn at
let mapFramingKm = null; // eased zoom (how far out the map is framed)
let targetFramingKm = null;
let mapRaf = null;

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

// Distance from a point to a lon/lat bounding box (0 if inside) — a cheap lower
// bound used to skip far countries when finding the nearest one.
function distToBBoxKm(lat, lon, b) {
  const clampLon = Math.max(b[0], Math.min(lon, b[2]));
  const clampLat = Math.max(b[1], Math.min(lat, b[3]));
  return haversineKm(lat, lon, clampLat, clampLon);
}

// Nearest country to a point (used when you're at sea). Approximated by the
// closest polygon vertex, with a bbox pre-filter so it stays fast.
function nearestCountry(lat, lon) {
  let best = null, bestDist = Infinity;
  for (const f of landFeatures) {
    if (distToBBoxKm(lat, lon, f.bbox) >= bestDist) continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const rings of polys) {
      const ring = rings[0];
      for (let i = 0; i < ring.length; i++) {
        const d = haversineKm(lat, lon, ring[i][1], ring[i][0]);
        if (d < bestDist) { bestDist = d; best = f; }
      }
    }
  }
  return best;
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
  const [countriesRes, marineRes, citiesRes, sealifeRes] = await Promise.all([
    fetch("data/countries.geojson"),
    fetch("data/marine.geojson"),
    fetch("data/cities.json"),
    fetch("data/sealife.json"),
  ]);
  const [countries, marine, citiesJson, sealifeJson] = await Promise.all([
    countriesRes.json(),
    marineRes.json(),
    citiesRes.json(),
    sealifeRes.json(),
  ]);
  sealife = sealifeJson;

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
  requestMapSpin();
}

// Smoothly rotate the map toward the live heading. The heavy route/text is left
// to the throttled scan; here we only ease the rotation and redraw, running an
// rAF loop while turning and stopping once it has caught up (so it's idle when
// you hold still).
function drawMapNow(full) {
  if (!lastMapArgs || mapHeading === null) return;
  drawMap(lastMapArgs.startLat, lastMapArgs.startLon, mapHeading, lastMapArgs.segments, full !== false, mapFramingKm);
}

function requestMapSpin() {
  if (!lastMapArgs || currentHeading === null) return;
  if (mapHeading === null) mapHeading = currentHeading;
  if (mapRaf === null) mapRaf = requestAnimationFrame(spinMap);
}

// Ease both the rotation and the zoom toward their targets so nothing snaps —
// when the route re-traces on settle, the framing glides to the new distance
// instead of jumping.
function spinMap() {
  mapRaf = null;
  if (!lastMapArgs || currentHeading === null) return;

  const dHeading = ((currentHeading - mapHeading + 540) % 360) - 180; // shortest turn
  const headingSettled = Math.abs(dHeading) < 0.4;

  let framingSettled = true;
  if (targetFramingKm !== null && mapFramingKm !== null) {
    const dF = targetFramingKm - mapFramingKm;
    framingSettled = Math.abs(dF) < Math.max(5, targetFramingKm * 0.01);
    if (!framingSettled) mapFramingKm += dF * 0.22;
  }

  if (headingSettled && framingSettled) {
    mapHeading = currentHeading;
    if (targetFramingKm !== null) mapFramingKm = targetFramingKm;
    drawMapNow(true); // settled — full draw (all labels)
    return;
  }

  if (!headingSettled) mapHeading = (mapHeading + dHeading * 0.3 + 360) % 360;
  // Light draw only while actively rotating; a zoom-only glide can afford labels.
  drawMapNow(headingSettled);
  mapRaf = requestAnimationFrame(spinMap);
}

// Orientation events fire ~60×/s. Rather than touch the DOM on every one, stash
// the latest heading and apply it at most once per animation frame — and skip
// sub-half-degree jitter entirely. Much less main-thread work and repainting.
function handleOrientation(event) {
  let heading;
  if (typeof event.webkitCompassHeading === "number" && !Number.isNaN(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading; // iOS Safari: already 0=N, clockwise
  } else if (event.alpha !== null && event.alpha !== undefined) {
    heading = 360 - event.alpha; // best-effort fallback for other browsers
  } else {
    return;
  }
  pendingHeading = (heading + 360) % 360;
  if (!compassGotReading) { compassGotReading = true; setPermStatus("compass", "ok"); }
  if (orientationRaf === null) orientationRaf = requestAnimationFrame(applyPendingHeading);
}

function applyPendingHeading() {
  orientationRaf = null;
  if (pendingHeading === null) return;
  if (lastAppliedHeading !== null && angleDelta(pendingHeading, lastAppliedHeading) < UI_HEADING_EPSILON) return;
  lastAppliedHeading = pendingHeading;
  updateCompassUI(pendingHeading);
}

function addOrientationListener() {
  window.removeEventListener("deviceorientation", handleOrientation, true);
  window.addEventListener("deviceorientation", handleOrientation, true);
}

function removeOrientationListener() {
  window.removeEventListener("deviceorientation", handleOrientation, true);
  if (orientationRaf !== null) { cancelAnimationFrame(orientationRaf); orientationRaf = null; }
}

function updateLocationUI() {
  if (!currentPosition) return;
  const { lat, lon } = currentPosition;
  setPermStatus("location", "ok");

  // Show the current place (city + country) right next to the coordinates. If
  // you're at sea, use the nearest country instead of "at sea".
  let place = "";
  if (landFeatures) {
    const country = findLandAt(lon, lat);
    const city = nearestCity(lat, lon);
    let cname;
    if (country) cname = country.name;
    else { const nc = nearestCountry(lat, lon); cname = nc ? `near ${nc.name}` : "at sea"; }
    place = city ? `${city.name}, ${cname}` : cname;
  }
  els.locationReadout.textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}${place ? " · " + place : ""}`;

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
        setPermStatus("location", "err");
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
        setPermStatus("location", "warn");
        setStatus("Your location is currently unavailable — try again with a clearer view of the sky.", true);
        allowEnableRetry();
      } else if (err.code === 3) {
        setPermStatus("location", "warn");
        setStatus("Timed out getting your location. Tap Enable to retry.", true);
        allowEnableRetry();
      } else {
        setPermStatus("location", "err");
        setStatus(`Location error: ${err.message}`, true);
        allowEnableRetry();
      }
    },
    // Low-power location: coarse accuracy is plenty for "which country is that
    // way", and it lets the OS avoid keeping the GPS radio hot. Cached fixes up
    // to a minute old are fine since you're pointing from roughly one spot.
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 }
  );
}

async function startOrientation() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) {
    setPermStatus("compass", "err");
    setStatus("This browser doesn't provide a compass.", true);
    return;
  }
  if (typeof DOE.requestPermission === "function") {
    try {
      const result = await DOE.requestPermission();
      if (result !== "granted") {
        setPermStatus("compass", "err");
        setStatus("Compass permission was not granted.", true);
        return;
      }
    } catch (e) {
      setPermStatus("compass", "err");
      setStatus(`Compass permission error: ${e.message}`, true);
      return;
    }
  }
  orientationGranted = true;
  addOrientationListener();
}

// Stop / resume the sensors when the page is backgrounded, so it isn't draining
// the battery while it's not on screen.
function setSensorsActive(active) {
  if (!sensorsOn) return;
  if (active) {
    if (orientationGranted) addOrientationListener();
    startGeolocation();
  } else {
    removeOrientationListener();
    if (geoWatchId !== null) { navigator.geolocation.clearWatch(geoWatchId); geoWatchId = null; }
    if (liveTimer !== null) { clearTimeout(liveTimer); liveTimer = null; }
    if (mapRaf !== null) { cancelAnimationFrame(mapRaf); mapRaf = null; }
  }
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
// reached MAX_DESTINATIONS countries after leaving the one you're standing on.
function traceRoute(startLat, startLon, heading) {
  let openFeat = findLandAt(startLon, startLat);
  let open = { feat: openFeat, startKm: 0, startPt: { lat: startLat, lon: startLon } };
  const segments = [];
  let destOpened = 0;
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
        destOpened++; // any land opened after a transition is a destination
        if (destOpened >= MAX_DESTINATIONS) {
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

// Always keep the 1st destination; drop the 2nd/3rd (and everything after) once
// one lands more than DEST_GAP_KM beyond the previous kept destination.
function trimSegments(segments) {
  const out = [];
  let destCount = 0, prevKm = null;
  const pendingSeas = [];
  for (const seg of segments) {
    if (seg.feat && seg.startKm === 0) {
      out.push(seg); // the country you're standing on
    } else if (seg.feat) {
      destCount++;
      if (destCount > 1 && seg.startKm - prevKm > DEST_GAP_KM) break; // too far — stop here
      out.push(...pendingSeas.splice(0), seg);
      prevKm = seg.startKm;
    } else {
      pendingSeas.push(seg); // hold seas until we know the next dest is kept
    }
  }
  return out;
}

// ---------- rendering ----------

function renderResult(startLat, startLon, heading, segments) {
  // Cache the nearest city per destination so the per-frame map draw doesn't
  // have to rescan every city while the map is spinning.
  for (const seg of segments) {
    if (seg.feat && seg.startKm > 0 && seg.cityName === undefined) {
      const c = nearestCity(seg.startPt.lat, seg.startPt.lon);
      seg.cityName = c ? c.name : "";
    }
  }

  lastMapArgs = { startLat, startLon, segments };
  if (mapHeading === null) mapHeading = heading;
  targetFramingKm = computeFramingKm(segments);
  if (mapFramingKm === null) mapFramingKm = targetFramingKm; // no ease on first paint
  els.mapEmpty.hidden = true;
  requestMapSpin();
  drawMapNow(true);
  updateWoot(startLat, startLon, heading, segments);

  const hasLand = segments.some((s) => s.feat && s.startKm > 0);
  setStatus(hasLand ? "" : `Open ocean — no land within range facing ${cardinal(heading)}.`);
}

// Re-trace the route only when the turn has settled (a debounce), so the heavy
// work doesn't hitch the smooth rotation. If the heading has drifted a long way
// from the last trace, re-trace at once so the route isn't badly stale.
function scheduleLiveScan() {
  if (currentHeading === null || !currentPosition || !landFeatures) return;
  if (lastMapArgs === null) { if (liveTimer !== null) { clearTimeout(liveTimer); liveTimer = null; } runLiveScan(); return; }
  const bigDrift = lastRendered.heading !== null && angleDelta(currentHeading, lastRendered.heading) >= BIG_DRIFT_DEG;
  if (bigDrift) {
    if (liveTimer !== null) { clearTimeout(liveTimer); liveTimer = null; }
    runLiveScan();
    return;
  }
  if (liveTimer !== null) clearTimeout(liveTimer);
  liveTimer = setTimeout(runLiveScan, SETTLE_MS);
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
    const segments = trimSegments(traceRoute(lat, lon, heading));
    renderResult(lat, lon, heading, segments);
    lastRendered = { heading, lat, lon };
  } catch (e) {
    setStatus(`Something went wrong: ${e.message}`, true);
  }
}

// ---------- map ----------

function mapColors() {
  const dark = !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark
    ? { sea: "#0d1526", land: "#26324e", coast: "#46557d", aheadFill: "rgba(79,209,197,0.32)", aheadStroke: "#4fd1c5", path: "#f6ad55", user: "#f6ad55", userRing: "#0d1526", labelText: "#c8d3ef", labelAhead: "#eafff9", labelHalo: "rgba(5,10,20,0.85)", panelBg: "rgba(9,15,28,0.86)", labelStart: "#ffd9a8", seaLabel: "#93a6cc" }
    : { sea: "#cfe0f2", land: "#c2cde0", coast: "#8194b6", aheadFill: "rgba(47,184,171,0.35)", aheadStroke: "#2fb8ab", path: "#d9772a", user: "#d9772a", userRing: "#ffffff", labelText: "#2a3550", labelAhead: "#0f5f57", labelHalo: "rgba(255,255,255,0.88)", panelBg: "rgba(255,255,255,0.9)", labelStart: "#8a4b12", seaLabel: "#5a6b8f" };
}

// Area-weighted centroid of a ring (falls back to the vertex average for
// degenerate rings), used to place a country's name label.
function polygonCentroid(ring) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x0 = ring[j][0], y0 = ring[j][1], x1 = ring[i][0], y1 = ring[i][1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    x += (x0 + x1) * f;
    y += (y0 + y1) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [x / (6 * a), y / (6 * a)];
}

// A [lon, lat] label anchor: the centroid of the country's largest polygon.
function labelPoint(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = polys[0][0], bestArea = -1;
  for (const rings of polys) {
    const ring = rings[0];
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    a = Math.abs(a * 0.5);
    if (a > bestArea) { bestArea = a; best = ring; }
  }
  return polygonCentroid(best);
}

// Draw one land feature (Polygon/MultiPolygon), each polygon as its own path so
// even-odd hole handling doesn't bleed across separate islands. `seamPx` breaks
// an edge when consecutive points jump too far in x, which stops countries near
// the antimeridian from streaking a line across the whole map.
function drawFeature(ctx, geometry, project, fill, stroke, lineWidth, seamPx) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      let prevX = null;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = project(ring[i][1], ring[i][0]);
        if (i === 0 || (prevX !== null && Math.abs(x - prevX) > seamPx)) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        prevX = x;
      }
    }
    ctx.fillStyle = fill;
    ctx.fill("evenodd");
    if (lineWidth > 0) {
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }
}

// A rough canvas map (no tiles / no network) showing the user, the great-circle
// path, and the outlines of the countries ahead, highlighted.
// How far out to frame the map, from the route's farthest point.
function computeFramingKm(segments) {
  const anyLand = segments.some((s) => s.feat);
  let farKm = 0;
  for (const s of segments) {
    if (typeof s.startKm === "number") farKm = Math.max(farKm, s.startKm);
    if (typeof s.endKm === "number") farKm = Math.max(farKm, s.endKm);
  }
  return anyLand ? Math.max(farKm, 200) : Math.min(Math.max(farKm, 200), 5000);
}

function drawMap(startLat, startLon, heading, segments, full = true, framingKm = null) {
  const canvas = els.map;
  const wrap = canvas.parentElement;
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const C = mapColors();

  const highlights = new Set(segments.filter((s) => s.feat).map((s) => s.feat));
  const framing = framingKm != null ? framingKm : computeFramingKm(segments);

  // Unwrap longitudes relative to the start so paths/shapes stay continuous
  // across the antimeridian.
  const unwrap = (lon) => {
    let x = lon;
    while (x - startLon > 180) x -= 360;
    while (x - startLon < -180) x += 360;
    return x;
  };

  // Sample the great-circle path for framing + drawing.
  const pathPts = [];
  const N = 160;
  for (let i = 0; i <= N; i++) {
    pathPts.push(destinationPoint(startLat, startLon, heading, (framing * i) / N));
  }
  const framePts = [{ lat: startLat, lon: startLon }, ...pathPts];

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of framePts) {
    const lon = unwrap(p.lon);
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  const midLat = (minLat + maxLat) / 2;
  const k = Math.max(0.15, Math.cos(toRad(midLat))); // longitude compression

  // Work in a "world" frame (east scaled by k, north up), then rotate it about
  // the user so the heading points straight up — a heading-up map. The initial
  // path segment defines "up", so it points up regardless of projection skew.
  const uwx = unwrap(startLon) * k, uwy = startLat;
  const p1 = pathPts[1] || pathPts[pathPts.length - 1];
  const phi = Math.PI / 2 - Math.atan2(p1.lat - uwy, unwrap(p1.lon) * k - uwx);
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const rot = (wx, wy) => [
    uwx + (wx - uwx) * cosP - (wy - uwy) * sinP,
    uwy + (wx - uwx) * sinP + (wy - uwy) * cosP,
  ];

  // Fit the rotated frame points (user + path) to the canvas.
  let minRX = Infinity, maxRX = -Infinity, minRY = Infinity, maxRY = -Infinity;
  for (const p of framePts) {
    const [rx, ry] = rot(unwrap(p.lon) * k, p.lat);
    if (rx < minRX) minRX = rx;
    if (rx > maxRX) maxRX = rx;
    if (ry < minRY) minRY = ry;
    if (ry > maxRY) maxRY = ry;
  }
  // Generous padding so adjacent countries (and roughly one ring beyond) show.
  const padX = (maxRX - minRX) * 0.32 || 0.5;
  const padY = (maxRY - minRY) * 0.32 || 0.5;
  minRX -= padX; maxRX += padX; minRY -= padY; maxRY += padY;

  const geoW = maxRX - minRX, geoH = maxRY - minRY;
  const scale = Math.min(cssW / geoW, cssH / geoH);
  const offX = (cssW - geoW * scale) / 2;
  const offY = (cssH - geoH * scale) / 2;

  const project = (lat, lon) => {
    const [rx, ry] = rot(unwrap(lon) * k, lat);
    return [offX + (rx - minRX) * scale, offY + (maxRY - ry) * scale];
  };

  ctx.fillStyle = C.sea;
  ctx.fillRect(0, 0, cssW, cssH);

  // Geographic bounds that enclose the rotated visible area, for culling. Walk
  // the four canvas corners back through the inverse transform.
  const invRot = (rx, ry) => [
    uwx + (rx - uwx) * cosP + (ry - uwy) * sinP,
    uwy - (rx - uwx) * sinP + (ry - uwy) * cosP,
  ];
  let cullMinLon = Infinity, cullMaxLon = -Infinity, cullMinLat = Infinity, cullMaxLat = -Infinity;
  for (const [sx, sy] of [[0, 0], [cssW, 0], [0, cssH], [cssW, cssH]]) {
    const [wx, wy] = invRot(minRX + (sx - offX) / scale, maxRY - (sy - offY) / scale);
    const lon = wx / k, lat = wy;
    if (lon < cullMinLon) cullMinLon = lon;
    if (lon > cullMaxLon) cullMaxLon = lon;
    if (lat < cullMinLat) cullMinLat = lat;
    if (lat > cullMaxLat) cullMaxLat = lat;
  }

  for (const f of landFeatures) {
    const b = f.bbox;
    if (b[3] < cullMinLat || b[1] > cullMaxLat) continue;
    const lo = unwrap(b[0]), hi = unwrap(b[2]);
    if (Math.max(lo, hi) < cullMinLon || Math.min(lo, hi) > cullMaxLon) continue;
    const ahead = highlights.has(f);
    drawFeature(ctx, f.geometry, project, ahead ? C.aheadFill : C.land, ahead ? C.aheadStroke : C.coast, ahead ? 1.6 : 0.7, cssW * 0.5);
  }

  // Great-circle path.
  ctx.beginPath();
  for (let i = 0; i < pathPts.length; i++) {
    const [x, y] = project(pathPts[i].lat, pathPts[i].lon);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.path;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // ---- Annotations: destination callouts (country + cumulative distance +
  // nearest city), a "you are here" callout, sea names, then neighbour names. ----
  const placed = [];
  const LH = 13;
  const fontName = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
  const fontSub = "500 10px -apple-system, BlinkMacSystemFont, sans-serif";

  const roundRect = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  const drawCallout = (anchorX, anchorY, lines, borderColor) => {
    let w = 0;
    for (const ln of lines) { ctx.font = ln.font; w = Math.max(w, ctx.measureText(ln.text).width); }
    const padX = 6, padY = 5;
    const boxW = w + padX * 2, boxH = lines.length * LH + padY * 2;
    let bx = anchorX + 12;
    if (bx + boxW > cssW - 2) bx = anchorX - 12 - boxW; // flip to the left edge
    let by = anchorY - boxH / 2;
    bx = Math.min(Math.max(bx, 2), cssW - boxW - 2);
    by = Math.min(Math.max(by, 2), cssH - boxH - 2);
    for (let t = 0; t < 6; t++) { // nudge down past already-placed boxes
      let hit = false;
      for (const p of placed) {
        if (!(bx + boxW < p[0] || bx > p[2] || by + boxH < p[1] || by > p[3])) { hit = true; by = Math.min(p[3] + 3, cssH - boxH - 2); break; }
      }
      if (!hit) break;
    }
    placed.push([bx, by, bx + boxW, by + boxH]);
    roundRect(bx, by, boxW, boxH, 6);
    ctx.fillStyle = C.panelBg; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = borderColor; ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let ty = by + padY + LH / 2;
    for (const ln of lines) { ctx.font = ln.font; ctx.fillStyle = ln.color; ctx.fillText(ln.text, bx + padX, ty); ty += LH; }
  };

  const [ux, uy] = project(startLat, startLon);
  let destIndex = 0;
  let startFeat = null;
  for (const s of segments) {
    if (!s.feat) continue;
    if (s.startKm > 0) {
      destIndex++;
      const [x, y] = project(s.startPt.lat, s.startPt.lon);
      drawCallout(x, y, [
        { text: `${destIndex}. ${s.feat.name}`, font: fontName, color: C.labelAhead },
        { text: `${miles(s.startKm)}${s.cityName ? " · " + s.cityName : ""}`, font: fontSub, color: C.labelText },
      ], C.aheadStroke);
    } else {
      startFeat = s.feat;
    }
  }
  if (startFeat) {
    drawCallout(ux, uy, [
      { text: startFeat.name, font: fontName, color: C.labelStart },
      { text: "You are here", font: fontSub, color: C.labelText },
    ], C.user);
  }

  // Sea names + neighbour labels are the costly passes (many measureText +
  // collision checks); skip them on the light mid-turn frames.
  if (full) {
  // Sea names along the path.
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "italic 600 10px -apple-system, BlinkMacSystemFont, sans-serif";
  for (const s of segments) {
    if (s.feat || s.endKm === undefined) continue;
    const midKm = (s.startKm + s.endKm) / 2;
    const mp = destinationPoint(startLat, startLon, heading, midKm);
    const name = seaNameAt(mp.lon, mp.lat) || "Open sea";
    const [x, y] = project(mp.lat, mp.lon);
    if (x < 0 || x > cssW || y < 0 || y > cssH) continue;
    const tw = ctx.measureText(name).width;
    const box = [x - tw / 2 - 2, y - 8, x + tw / 2 + 2, y + 8];
    let overlap = false;
    for (const p of placed) { if (!(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3])) { overlap = true; break; } }
    if (overlap) continue;
    placed.push(box);
    ctx.lineWidth = 3; ctx.strokeStyle = C.labelHalo; ctx.strokeText(name, x, y);
    ctx.fillStyle = C.seaLabel; ctx.fillText(name, x, y);
  }

  // Neighbour country names (the ones ahead already have callouts).
  ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
  const candidates = [];
  for (const f of landFeatures) {
    if (!f.name || highlights.has(f)) continue;
    const b = f.bbox;
    if (b[3] < cullMinLat || b[1] > cullMaxLat) continue;
    const lo = unwrap(b[0]), hi = unwrap(b[2]);
    if (Math.max(lo, hi) < cullMinLon || Math.min(lo, hi) > cullMaxLon) continue;
    const [cx, cy] = project(b[1], b[0]);
    const [dx, dy] = project(b[3], b[2]);
    const onW = Math.abs(dx - cx), onH = Math.abs(dy - cy);
    if (Math.min(onW, onH) < 20) continue;
    if (!f._label) f._label = labelPoint(f.geometry);
    const [lx, ly] = project(f._label[1], f._label[0]);
    if (lx < 0 || lx > cssW || ly < 0 || ly > cssH) continue;
    candidates.push({ name: f.name, x: lx, y: ly, area: onW * onH });
  }
  candidates.sort((a, b) => b.area - a.area);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let placedNames = 0;
  for (const c of candidates) {
    if (placedNames >= 16) break;
    const tw = ctx.measureText(c.name).width;
    const x = Math.min(Math.max(c.x, tw / 2 + 3), cssW - tw / 2 - 3);
    const y = Math.min(Math.max(c.y, 9), cssH - 9);
    const box = [x - tw / 2 - 2, y - 8, x + tw / 2 + 2, y + 8];
    let overlap = false;
    for (const p of placed) { if (!(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3])) { overlap = true; break; } }
    if (overlap) continue;
    placed.push(box); placedNames++;
    ctx.lineWidth = 3; ctx.strokeStyle = C.labelHalo; ctx.strokeText(c.name, x, y);
    ctx.fillStyle = C.labelText; ctx.fillText(c.name, x, y);
  }
  } // end if (full)

  // Numbered landfall markers + the user dot, drawn last so they stay visible.
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  let markerIndex = 0;
  for (const s of segments) {
    if (!s.feat || s.startKm === 0) continue;
    markerIndex++;
    const [x, y] = project(s.startPt.lat, s.startPt.lon);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = C.aheadStroke; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = C.userRing; ctx.stroke();
    ctx.fillStyle = "#04201d";
    ctx.font = "bold 10px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(String(markerIndex), x, y);
  }
  ctx.beginPath();
  ctx.arc(ux, uy, 6, 0, Math.PI * 2);
  ctx.fillStyle = C.user; ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = C.userRing; ctx.stroke();
}

// ---------- who's out there (sea life) ----------

const COAST_MAX_KM = 55; // treat as "on the coast facing the sea" within this

// Rough ocean basin for a point — the fallback when the specific sea isn't in
// the dataset. Returns a key present in sealife.oceans. Longitude alone can't
// split Atlantic from Pacific in the Americas (both coasts share longitudes),
// so the Americas use a latitude-aware rule.
function oceanBasin(lat, lon) {
  if (lat <= -60) return "SOUTHERN OCEAN";
  if (lat >= 66) return "Arctic Ocean";
  // The Mediterranean/Black Sea region has small gulfs (e.g. the Saronic Gulf)
  // with no named marine polygon at this resolution; without this, those gaps
  // fall through to the open-ocean basins below and get misclassified.
  if (lon >= -6 && lon <= 36 && lat >= 30 && lat <= 46) return "Mediterranean Sea";
  const north = lat >= 0;
  // Indian Ocean (Arabian Sea, Bay of Bengal, and south of Indonesia).
  if (lon >= 20 && lon <= 100 && lat <= 30) return "INDIAN OCEAN";
  if (lon > 100 && lon <= 147 && lat <= 0) return "INDIAN OCEAN";
  // Pacific: open west/central Pacific, plus the western coasts of the Americas.
  if (lon >= 105 || lon <= -100 || (lat < 8 && lon <= -70)) {
    return north ? "North Pacific Ocean" : "South Pacific Ocean";
  }
  // Everything else is Atlantic (incl. Caribbean, Gulf, US east coast, S America east).
  return north ? "North Atlantic Ocean" : "South Atlantic Ocean";
}

function prettySea(name) {
  if (name === "INDIAN OCEAN") return "Indian Ocean";
  if (name === "SOUTHERN OCEAN") return "Southern Ocean";
  return name;
}

function seaLifeFor(seaName, lat, lon) {
  if (!sealife) return [];
  // oceanBasin() can return either a named sea (e.g. "Mediterranean Sea", for
  // small gulfs with no marine polygon) or an ocean basin key — check both.
  const basin = oceanBasin(lat, lon);
  const list =
    (seaName && sealife.seas[seaName]) ||
    sealife.seas[basin] ||
    sealife.oceans[basin] ||
    [];
  return list.slice().sort((a, b) => b.commonality - a.commonality).slice(0, 10);
}

// Work out the water you're facing (if you're on/near the coast looking seaward)
// and refresh the "Who's out there?" trigger + panel.
function updateWoot(startLat, startLon, heading, segments) {
  let seaSeg = null;
  for (const s of segments) {
    if (!s.feat && s.endKm !== undefined) { seaSeg = s; break; }
  }
  if (!sealife || !seaSeg || seaSeg.startKm > COAST_MAX_KM) {
    wootData = null;
    els.wootBtn.hidden = true;
    if (!els.wootPanel.hidden) closeWoot();
    return;
  }

  // Sample a point out in the water to name the sea reliably.
  const sampleKm = seaSeg.startKm + Math.min(20, (seaSeg.endKm - seaSeg.startKm) / 2 || 5);
  const wp = destinationPoint(startLat, startLon, heading, sampleKm);
  const rawSea = seaNameAt(wp.lon, wp.lat);
  const displaySea = prettySea(rawSea || oceanBasin(wp.lat, wp.lon));
  const animals = seaLifeFor(rawSea, wp.lat, wp.lon);
  const city = nearestCity(startLat, startLon);

  wootData = { sea: displaySea, animals, cityName: city ? city.name : null };
  els.wootBtn.hidden = false;
  els.wootBtn.querySelector(".woot-label").textContent = `🐋 Who's out there? · ${displaySea}`;
  if (!els.wootPanel.hidden) renderWootPanel();
}

function renderWootPanel() {
  if (!wootData) return;
  els.wootTitle.textContent = wootData.sea;
  els.wootMeta.textContent = wootData.cityName ? `Near ${wootData.cityName}` : "";
  if (!wootData.animals.length) {
    els.wootList.innerHTML = `<li class="woot-empty">No sea-life data for this water yet.</li>`;
    return;
  }
  els.wootList.innerHTML = wootData.animals
    .map((a) => {
      const c = Math.max(0, Math.min(5, a.commonality));
      const dots = "●".repeat(c) + "○".repeat(5 - c);
      return `<li class="woot-item">
        <span class="woot-emoji">${a.emoji || "🐟"}</span>
        <span class="woot-name">${a.name}</span>
        <span class="woot-rating" title="${c}/5 — how commonly seen">${dots}</span>
      </li>`;
    })
    .join("");
}

function openWoot() {
  if (!wootData) return;
  renderWootPanel();
  els.wootPanel.hidden = false;
}

function closeWoot() {
  els.wootPanel.hidden = true;
}

// ---------- init ----------

async function init() {
  // Traffic-light statuses: network reflects connectivity now; compass and
  // location stay idle (grey) until you enable the sensors.
  const applyNetwork = () => setPermStatus("network", navigator.onLine === false ? "err" : "ok");
  applyNetwork();
  window.addEventListener("online", applyNetwork);
  window.addEventListener("offline", applyNetwork);
  setPermStatus("compass", "idle");
  setPermStatus("location", "geolocation" in navigator ? "idle" : "err");

  setStatus("Loading map data…");
  try {
    await loadData();
    setStatus("");
  } catch (e) {
    setStatus("Failed to load map data. Check your connection and reload.", true);
  }

  window.addEventListener("resize", drawMapNow);

  document.addEventListener("visibilitychange", () => setSensorsActive(!document.hidden));

  els.wootBtn.addEventListener("click", openWoot);
  els.wootClose.addEventListener("click", closeWoot);
  els.wootPanel.addEventListener("click", (e) => { if (e.target === els.wootPanel) closeWoot(); });

  els.enableBtn.addEventListener("click", () => {
    els.enableBtn.disabled = true;
    els.enableBtn.textContent = "Sensors enabled";
    els.pointingLabel.textContent = "Move your device to wake the compass";
    setStatus("Waiting for compass and GPS…");
    setPermStatus("compass", "warn");
    setPermStatus("location", "warn");
    sensorsOn = true;
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
