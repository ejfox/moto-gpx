/**
 * gpx.js — GPX parsing, geo math, stage splitting, and per-stage statistics.
 *
 * Role in the pipeline: foundational layer. Parses raw GPX XML into a plain
 * array of trackpoints, then provides the geometry helpers (haversine,
 * bearing, bbox, Douglas-Peucker simplification) and the summary-stats
 * computation that every downstream module leans on. Imported by
 * `moto-gpx.js` (orchestrator), `src/layers.js`, `src/svg.js`,
 * `src/superlatives.js`, and all `src/enrich/*` modules.
 *
 * Contract: pure functions, no I/O. Every export is deterministic given its
 * inputs — no filesystem access, no network, no globals, no mutation of
 * arguments. `parseGpx` returns a fresh array; `splitStages` and
 * `simplifyPoints` return new arrays without modifying their inputs.
 *
 * External dependencies: none (zero-dep by design — no xml parser, no geo
 * library; everything is inlined so the tool runs against any Node that has
 * the language features used).
 *
 * Exports:
 *   parseGpx(xml)             — regex-based GPX → trackpoint array
 *   haversine(from, to)       — great-circle distance in meters
 *   bearing(from, to)         — initial bearing in degrees, 0=N, clockwise
 *   bboxOf(points)            — [minLon, minLat, maxLon, maxLat] or null
 *   simplifyPoints(pts, tol)  — Douglas-Peucker in equirectangular meters
 *   splitStages(pts, gapMs)   — break track at time gaps into sub-stages
 *   segmentStats(points)      — distance / speed / elevation / bbox summary
 *   toLineFeature(pts, props) — GeoJSON LineString feature
 *   dayKey(time, tzH)         — "YYYY-MM-DD" in a given UTC offset
 *   hourKey(time, tzH)        — "YYYY-MM-DD_HH" in a given UTC offset
 */

/**
 * @typedef {Object} Trkpt
 * @property {number} lat  - decimal degrees, WGS84
 * @property {number} lon  - decimal degrees, WGS84
 * @property {number|null} ele  - meters above sea level, null if absent in source
 * @property {number|null} time - ms since epoch, null if absent in source
 */

/**
 * @typedef {[number, number, number, number]} BBox
 * [minLon, minLat, maxLon, maxLat]
 */

// ═══ constants ═══

// Earth's mean radius in meters, per IUGG 1980 mean-sphere. Used by haversine;
// accurate to ~0.5% vs. ellipsoidal models, which is fine for motorcycle-trip
// distances (we're not doing survey-grade geodesy).
const EARTH_RADIUS_M = 6371000;

// Equirectangular-projection meters-per-degree for Douglas-Peucker. These are
// only used to make tolerance comparisons isotropic at the track's starting
// latitude — not for accurate distance, so the approximation is fine.
//   mx = 111320 * cos(lat0) meters per degree of longitude
//   my = 110540              meters per degree of latitude
const METERS_PER_DEG_LAT = 110540;
const EQUIRECT_LON_BASE = 111320;

// Sliding-window length for max-speed computation. A single GPS sample-to-sample
// hop (e.g. a 50 m teleport between two 1-second samples → a 112 mph phantom)
// is smoothed out by averaging distance over a ≥5-second window. Matches
// src/superlatives.js so summary "max mph" and telemetry.top_speed agree.
const SPEED_WINDOW_MS = 5000;

// Sanity cap for GPS-derived speeds. Anything above this implies a GPS
// jump/teleport rather than real motion. 134 m/s ≈ 300 mph — well above the
// terminal velocity of any legal-road ground vehicle.
const MAX_PLAUSIBLE_SPEED_MPS = 134;

// A trackpoint is considered "moving" (vs. stopped at a light / fueling) when
// its instantaneous speed exceeds this value. 0.5 m/s ≈ 1.1 mph — slow enough
// to not miss a crawl, fast enough to exclude GPS noise while parked.
const MOVING_SPEED_THRESHOLD_MPS = 0.5;

// Unit conversions.
const MPS_TO_MPH = 2.23694;
const MPS_TO_KMH = 3.6;
const METERS_PER_MILE = 1609.344;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

// ═══ parsing ═══

/**
 * Parse a GPX document into a flat array of trackpoints.
 *
 * Uses regex rather than an XML parser to keep this module zero-dep. GPX is
 * well-regularized in practice (every motorcycle GPS exporter emits the
 * same shape), so this is robust for the universe of real-world inputs.
 * Silently skips `<trkpt>` entries that lack finite lat/lon. Missing `<ele>`
 * or `<time>` become `null` (not `undefined`) so downstream code can
 * null-check consistently.
 *
 * @param {string} xml - raw GPX XML text
 * @returns {Trkpt[]} trackpoints in document order (all tracks/segments flattened)
 * @example
 *   const pts = parseGpx(fs.readFileSync('ride.gpx', 'utf8'));
 *   // → [{ lat: 41.7, lon: -74, ele: 123, time: 1717251600000 }, ...]
 */
export function parseGpx(xml) {
  const points = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
  const latRe = /\blat\s*=\s*"([^"]+)"/;
  const lonRe = /\blon\s*=\s*"([^"]+)"/;
  const eleRe = /<ele>\s*([^<]+?)\s*<\/ele>/;
  const timeRe = /<time>\s*([^<]+?)\s*<\/time>/;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const lat = Number((attrs.match(latRe) || [])[1]);
    const lon = Number((attrs.match(lonRe) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleM = body.match(eleRe);
    const timeM = body.match(timeRe);
    const ele = eleM ? Number(eleM[1]) : null;
    const time = timeM ? Date.parse(timeM[1]) : null;
    points.push({
      lat, lon,
      ele: Number.isFinite(ele) ? ele : null,
      time: Number.isFinite(time) ? time : null,
    });
  }
  return points;
}

// ═══ geo helpers ═══

/**
 * Great-circle distance between two lat/lon points via the haversine formula.
 *
 * Returns meters on a spherical Earth of radius 6371 km. Accurate to ~0.5%
 * vs. ellipsoidal geodesics — more than good enough for trip-scale distance.
 *
 * @param {{lat: number, lon: number}} from
 * @param {{lat: number, lon: number}} to
 * @returns {number} distance in meters
 * @example
 *   haversine({lat: 40.7, lon: -74}, {lat: 40.8, lon: -74}) // ≈ 11120
 */
export function haversine(a, b) {
  const R = EARTH_RADIUS_M;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial great-circle bearing from `from` toward `to`.
 *
 * This is the *forward azimuth* — i.e. the compass direction you'd set off in
 * at `from` to reach `to` along a great-circle path. For short segments that
 * dominate GPS tracks, it is effectively equal to the rhumb-line bearing.
 *
 * @param {{lat: number, lon: number}} from
 * @param {{lat: number, lon: number}} to
 * @returns {number} bearing in degrees, [0, 360), 0 = North, clockwise
 * @example
 *   bearing({lat: 40, lon: -74}, {lat: 41, lon: -74}) // 0 (due north)
 */
export function bearing(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Axis-aligned bounding box around a set of points.
 *
 * Returns the GeoJSON-conventional `[west, south, east, north]` ordering
 * (lon, lat, lon, lat). Returns `null` for an empty input so callers can
 * distinguish "no data" from "zero-size bbox".
 *
 * @param {Array<{lat: number, lon: number}>} points
 * @returns {BBox|null} [minLon, minLat, maxLon, maxLat], or null if empty
 */
export function bboxOf(points) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (p.lon < b[0]) b[0] = p.lon;
    if (p.lat < b[1]) b[1] = p.lat;
    if (p.lon > b[2]) b[2] = p.lon;
    if (p.lat > b[3]) b[3] = p.lat;
  }
  return b[0] === Infinity ? null : b;
}

/**
 * Douglas-Peucker line simplification in local equirectangular meters.
 *
 * Iterative (stack-based) implementation so very long tracks don't blow the
 * call stack. Points are projected once into a flat meters space at the
 * track's starting latitude — fine for any single-day ride; would distort
 * slightly for continental-scale tracks but still deliver a reasonable
 * simplification. Always keeps the first and last points.
 *
 * @param {Trkpt[]} points
 * @param {number} tolerance - max perpendicular distance in meters; `0` or
 *   fewer than 3 points skips simplification and returns the input as-is.
 * @returns {Trkpt[]} simplified subset, referencing the original point objects
 * @example
 *   const simplified = simplifyPoints(raw, 5); // 5m tolerance
 */
export function simplifyPoints(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const lat0 = (points[0].lat * Math.PI) / 180;
  const mx = EQUIRECT_LON_BASE * Math.cos(lat0);
  const my = METERS_PER_DEG_LAT;
  const xs = points.map(p => p.lon * mx);
  const ys = points.map(p => p.lat * my);
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD2 = 0;
    let idx = -1;
    const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i] - ax;
      const py = ys[i] - ay;
      let d2;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const qx = t * dx - px;
        const qy = t * dy - py;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > maxD2) { maxD2 = d2; idx = i; }
    }
    if (maxD2 > tol2 && idx > -1) {
      keep[idx] = 1;
      stack.push([a, idx]);
      stack.push([idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// ═══ stage splitting & stats ═══

/**
 * Split a flat trackpoint array into sub-stages at time gaps.
 *
 * A "stage" is a continuous run of riding. Whenever the time between
 * consecutive points exceeds `gapMs` (e.g. a fuel stop, lunch, overnight),
 * the previous accumulated stage is closed and a new one begins. Points
 * lacking a timestamp never trigger a split — they just accrete into the
 * current stage.
 *
 * @param {Trkpt[]} points
 * @param {number} gapMs - minimum inter-sample gap (in ms) that ends a stage
 * @returns {Trkpt[][]} array of stages, each a non-empty trackpoint array
 * @example
 *   splitStages(points, 30 * 60_000); // split on gaps > 30 minutes
 */
export function splitStages(points, gapMs) {
  const stages = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (prev && p.time != null && prev.time != null && (p.time - prev.time) > gapMs) {
      if (cur.length) stages.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) stages.push(cur);
  return stages;
}

/**
 * Compute distance / speed / duration / elevation / bbox stats for a segment.
 *
 * Max speed is computed over a 5-second sliding window (see
 * `SPEED_WINDOW_MS`) to suppress single-sample GPS jitter, and clamped to
 * `MAX_PLAUSIBLE_SPEED_MPS` to reject outright teleports. Moving time sums
 * only intervals where instantaneous speed exceeded `MOVING_SPEED_THRESHOLD_MPS`.
 * Returned distances and speeds are rounded for human-facing display.
 *
 * @param {Trkpt[]} points
 * @returns {{
 *   points: number,
 *   start_iso: string|null,
 *   end_iso: string|null,
 *   duration_min: number|null,
 *   moving_min: number,
 *   distance_km: number,
 *   distance_mi: number,
 *   max_speed_mph: number,
 *   max_speed_kmh: number,
 *   avg_moving_mph: number|null,
 *   ele_gain_m: number,
 *   ele_loss_m: number,
 *   bbox: BBox|null
 * }}
 */
export function segmentStats(points) {
  let distance = 0;
  let maxSpeed = 0;
  let movingSec = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    distance += d;
    const t0 = points[i - 1].time;
    const t1 = points[i].time;
    if (t0 != null && t1 != null) {
      const dt = (t1 - t0) / 1000;
      if (dt > 0) {
        const speed = d / dt;
        if (speed > MOVING_SPEED_THRESHOLD_MPS) movingSec += dt;
      }
    }
  }

  // Max speed computed over a 5-second sliding window so a single GPS jitter
  // (e.g. 50m hop between adjacent 1s samples → 112 mph phantom) doesn't
  // dominate. Still sanity-clamped to <300 mph.
  for (let i = 0; i < points.length; i++) {
    if (points[i].time == null) continue;
    let j = i + 1;
    let winDist = 0;
    while (j < points.length) {
      if (points[j].time == null) { j++; continue; }
      winDist += haversine(points[j - 1], points[j]);
      if ((points[j].time - points[i].time) >= SPEED_WINDOW_MS) break;
      j++;
    }
    if (j >= points.length) break;
    const dt = (points[j].time - points[i].time) / 1000;
    if (dt <= 0) continue;
    const speed = winDist / dt;
    if (speed < MAX_PLAUSIBLE_SPEED_MPS && speed > maxSpeed) maxSpeed = speed;
  }
  let gain = 0, loss = 0;
  let prevEle = null;
  for (const p of points) {
    if (p.ele == null) continue;
    if (prevEle != null) {
      const dz = p.ele - prevEle;
      if (dz > 0) gain += dz;
      else loss += -dz;
    }
    prevEle = p.ele;
  }
  const firstT = points.find(p => p.time != null)?.time ?? null;
  const lastT = [...points].reverse().find(p => p.time != null)?.time ?? null;
  return {
    points: points.length,
    start_iso: firstT != null ? new Date(firstT).toISOString() : null,
    end_iso: lastT != null ? new Date(lastT).toISOString() : null,
    duration_min: firstT != null && lastT != null ? (lastT - firstT) / MS_PER_MINUTE : null,
    moving_min: movingSec / 60,
    distance_km: +(distance / 1000).toFixed(3),
    distance_mi: +(distance / METERS_PER_MILE).toFixed(3),
    max_speed_mph: +(maxSpeed * MPS_TO_MPH).toFixed(1),
    max_speed_kmh: +(maxSpeed * MPS_TO_KMH).toFixed(1),
    avg_moving_mph: movingSec > 0 ? +((distance / movingSec) * MPS_TO_MPH).toFixed(1) : null,
    ele_gain_m: Math.round(gain),
    ele_loss_m: Math.round(loss),
    bbox: bboxOf(points),
  };
}

// ═══ GeoJSON + time-key helpers ═══

/**
 * Wrap a trackpoint array as a GeoJSON LineString Feature.
 *
 * Emits 3D coordinates `[lon, lat, ele]` when elevation is present, 2D
 * `[lon, lat]` when not — never mixes per coordinate so parsers that only
 * look at the first vertex still infer the right dimensionality.
 *
 * @param {Trkpt[]} points
 * @param {Object} props - feature-level `properties` (copied by reference)
 * @returns {Object} a GeoJSON Feature of geometry type LineString
 */
export function toLineFeature(points, props) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat]),
    },
  };
}

/**
 * Local-calendar day key in a given UTC offset, as "YYYY-MM-DD".
 *
 * Used to group trackpoints by *local* day even when the GPX stream is in
 * UTC — so a ride that crosses midnight UTC but not midnight local time
 * still reads as one day.
 *
 * @param {number} time - ms since epoch (UTC)
 * @param {number} tzH  - UTC offset in hours (may be fractional, e.g. 5.5)
 * @returns {string} e.g. "2025-06-01"
 */
export function dayKey(time, tzH) {
  return new Date(time + tzH * MS_PER_HOUR).toISOString().slice(0, 10);
}

/**
 * Local-calendar hour key in a given UTC offset, as "YYYY-MM-DD_HH".
 *
 * Same rationale as `dayKey`, one granularity finer. The `T` separator from
 * the ISO string is rewritten to `_` so the result is filename-safe.
 *
 * @param {number} time - ms since epoch (UTC)
 * @param {number} tzH  - UTC offset in hours
 * @returns {string} e.g. "2025-06-01_14"
 */
export function hourKey(time, tzH) {
  return new Date(time + tzH * MS_PER_HOUR).toISOString().slice(0, 13).replace('T', '_');
}
