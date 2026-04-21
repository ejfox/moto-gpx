// Fun GPS-derived stats. Year-in-review vibes from a single ride.
// Computed from deduped trkpts + perStage + optional weather enrichment +
// optional places.geojson (OSM enrichment) for the "town signs you passed" feel.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { haversine, bearing } from './gpx.js';

const MILE_M = 1609.344;
const FIELD_M = 91.44;           // football field = 100 yd
const EMPIRE_M = 381;            // roof to top floor (ESB observatory)
const EIFFEL_M = 300;
const KILIMANJARO_M = 5895;
const STRAIGHT_BEARING_TOL_DEG = 8;   // "straight" = heading drift < 8° cumulative
const STRAIGHT_MIN_M = 100;           // only care about straights ≥ 100m
const GRADE_WINDOW_M = 200;           // steepest-grade sliding window
const CLIMB_MIN_M = 50;               // ignore climbs under this height
const NONSTOP_MIN_MPS = 2.0;          // ~4.5 mph — counts as "moving"
const NONSTOP_GAP_S = 30;             // a 30s+ pause ends a streak

function fmtPace(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function iso(t) { return t != null ? new Date(t).toISOString() : null; }

// ---- fastest mile (sliding window over 1-mile chunks) ----
function fastestMile(points) {
  if (points.length < 2) return null;
  let best = null;
  let j = 0;
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < points.length - 1 && dist < MILE_M) {
      dist += haversine(points[j], points[j + 1]);
      j++;
    }
    if (dist < MILE_M) break;
    const t0 = points[i].time, t1 = points[j].time;
    if (t0 != null && t1 != null) {
      const sec = (t1 - t0) / 1000;
      const mph = sec > 0 ? (MILE_M / sec) * 2.23694 : 0;
      if (sec > 0 && mph > 1 && mph < 200 && (best == null || sec < best.sec)) {
        best = {
          sec,
          pace: fmtPace(sec),
          mph: +mph.toFixed(1),
          start: { lat: points[i].lat, lon: points[i].lon, time_iso: iso(t0) },
          end: { lat: points[j].lat, lon: points[j].lon, time_iso: iso(t1) },
        };
      }
    }
    if (i < points.length - 1) dist -= haversine(points[i], points[i + 1]);
  }
  return best;
}

// ---- longest non-stop streak ----
function longestNonstop(points) {
  let best = null;
  let streakStart = null;
  let streakDist = 0;
  let lastMovingT = null;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    const t0 = points[i - 1].time, t1 = points[i].time;
    if (t0 == null || t1 == null) continue;
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    const speed = d / dt;
    const moving = speed >= NONSTOP_MIN_MPS;
    const paused = lastMovingT != null && ((t0 - lastMovingT) / 1000) >= NONSTOP_GAP_S;
    if (!streakStart || paused) {
      streakStart = i - 1;
      streakDist = 0;
    }
    if (moving) {
      streakDist += d;
      lastMovingT = t1;
      const durMin = (t1 - points[streakStart].time) / 60000;
      if (!best || durMin > best.duration_min) {
        best = {
          duration_min: +durMin.toFixed(1),
          distance_mi: +(streakDist / MILE_M).toFixed(2),
          distance_km: +(streakDist / 1000).toFixed(2),
          started_iso: iso(points[streakStart].time),
          ended_iso: iso(t1),
        };
      }
    }
  }
  return best;
}

// ---- elevation stuff ----
function elevationExtremes(points) {
  let highEle = null, lowEle = null;
  let high = null, low = null;
  for (const p of points) {
    if (p.ele == null) continue;
    if (highEle == null || p.ele > highEle) {
      highEle = p.ele;
      high = { ele_m: Math.round(p.ele), lat: p.lat, lon: p.lon, time_iso: iso(p.time) };
    }
    if (lowEle == null || p.ele < lowEle) {
      lowEle = p.ele;
      low = { ele_m: Math.round(p.ele), lat: p.lat, lon: p.lon, time_iso: iso(p.time) };
    }
  }
  return { highest: high, lowest: low };
}

// Biggest climb: max (ele - runningMin) over the timeline.
function biggestClimb(points) {
  let runMin = null, runMinIdx = -1;
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const e = points[i].ele;
    if (e == null) continue;
    if (runMin == null || e < runMin) { runMin = e; runMinIdx = i; }
    else {
      const climbed = e - runMin;
      if (climbed >= CLIMB_MIN_M && (!best || climbed > best.climbed_m)) {
        // compute distance along the track from runMinIdx to i
        let d = 0;
        for (let k = runMinIdx + 1; k <= i; k++) d += haversine(points[k - 1], points[k]);
        best = {
          climbed_m: +climbed.toFixed(0),
          distance_km: +(d / 1000).toFixed(2),
          avg_grade_pct: d > 0 ? +((climbed / d) * 100).toFixed(1) : null,
          start: { lat: points[runMinIdx].lat, lon: points[runMinIdx].lon, ele_m: Math.round(runMin), time_iso: iso(points[runMinIdx].time) },
          peak: { lat: points[i].lat, lon: points[i].lon, ele_m: Math.round(e), time_iso: iso(points[i].time) },
        };
      }
    }
  }
  return best;
}

// Biggest descent: max (runningMax - current) — symmetric to biggestClimb.
// This is "the biggest single drop" rather than "cumulative descent."
function biggestDescent(points) {
  let runMax = null, runMaxIdx = -1;
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const e = points[i].ele;
    if (e == null) continue;
    if (runMax == null || e > runMax) { runMax = e; runMaxIdx = i; }
    else {
      const descended = runMax - e;
      if (descended >= CLIMB_MIN_M && (!best || descended > best.descended_m)) {
        let d = 0;
        for (let k = runMaxIdx + 1; k <= i; k++) d += haversine(points[k - 1], points[k]);
        best = {
          descended_m: +descended.toFixed(0),
          distance_km: +(d / 1000).toFixed(2),
          avg_grade_pct: d > 0 ? +((descended / d) * 100).toFixed(1) : null,
          start: { lat: points[runMaxIdx].lat, lon: points[runMaxIdx].lon, ele_m: Math.round(runMax), time_iso: iso(points[runMaxIdx].time) },
          end: { lat: points[i].lat, lon: points[i].lon, ele_m: Math.round(e), time_iso: iso(points[i].time) },
        };
      }
    }
  }
  return best;
}

// Steepest grade over a ~200m sliding window.
function steepestGrade(points) {
  let best = null;
  let j = 0;
  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    while (j < points.length - 1 && dist < GRADE_WINDOW_M) {
      dist += haversine(points[j], points[j + 1]);
      j++;
    }
    if (dist < GRADE_WINDOW_M) break;
    const e0 = points[i].ele, e1 = points[j].ele;
    if (e0 != null && e1 != null && dist > 0) {
      const grade = Math.abs(e1 - e0) / dist * 100;
      if (!best || grade > best.grade_pct) {
        best = {
          grade_pct: +grade.toFixed(1),
          climbed_m: +(e1 - e0).toFixed(0),
          over_m: Math.round(dist),
          start: { lat: points[i].lat, lon: points[i].lon, ele_m: Math.round(e0), time_iso: iso(points[i].time) },
          end:   { lat: points[j].lat, lon: points[j].lon, ele_m: Math.round(e1), time_iso: iso(points[j].time) },
        };
      }
    }
    if (i < points.length - 1) dist -= haversine(points[i], points[i + 1]);
  }
  return best;
}

// ---- compass extremes ----
function compassExtremes(points) {
  let n = null, s = null, e = null, w = null;
  for (const p of points) {
    if (!n || p.lat > n.lat) n = p;
    if (!s || p.lat < s.lat) s = p;
    if (!e || p.lon > e.lon) e = p;
    if (!w || p.lon < w.lon) w = p;
  }
  const mk = p => p ? { lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), time_iso: iso(p.time) } : null;
  return { north: mk(n), south: mk(s), east: mk(e), west: mk(w) };
}

// ---- turning / straightness ----
function turning(points) {
  let totalAbsDeg = 0;
  let totalDistM = 0;
  const headings = [];
  for (let i = 1; i < points.length; i++) {
    totalDistM += haversine(points[i - 1], points[i]);
    headings.push(bearing(points[i - 1], points[i]));
  }
  for (let i = 1; i < headings.length; i++) {
    let dh = headings[i] - headings[i - 1];
    while (dh > 180) dh -= 360;
    while (dh < -180) dh += 360;
    totalAbsDeg += Math.abs(dh);
  }
  const miles = totalDistM / MILE_M;
  return {
    total_turning_deg: Math.round(totalAbsDeg),
    turns_per_mile: miles > 0 ? +(totalAbsDeg / miles).toFixed(0) : null,
  };
}

// Longest straight: longest run where cumulative |Δheading| stays under tolerance.
function longestStraight(points) {
  if (points.length < 3) return null;
  let best = null;
  let i = 0;
  while (i < points.length - 2) {
    let cumDh = 0;
    let dist = 0;
    let prevH = bearing(points[i], points[i + 1]);
    let j = i + 1;
    while (j < points.length - 1) {
      const h = bearing(points[j], points[j + 1]);
      let dh = h - prevH;
      while (dh > 180) dh -= 360;
      while (dh < -180) dh += 360;
      cumDh += Math.abs(dh);
      if (cumDh > STRAIGHT_BEARING_TOL_DEG) break;
      dist += haversine(points[j], points[j + 1]);
      prevH = h;
      j++;
    }
    if (dist >= STRAIGHT_MIN_M && (!best || dist > best.distance_m)) {
      best = {
        distance_m: Math.round(dist),
        distance_mi: +(dist / MILE_M).toFixed(2),
        bearing_deg: Math.round(bearing(points[i], points[j])),
        start: { lat: points[i].lat, lon: points[i].lon, time_iso: iso(points[i].time) },
        end:   { lat: points[j].lat, lon: points[j].lon, time_iso: iso(points[j].time) },
      };
    }
    i = Math.max(i + 1, j);
  }
  return best;
}

// ---- distributions ----
function speedBucketDistribution(points) {
  const buckets = { slow: 0, moderate: 0, fast: 0, highway: 0 };
  let totalSec = 0;
  for (let i = 1; i < points.length; i++) {
    const t0 = points[i - 1].time, t1 = points[i].time;
    if (t0 == null || t1 == null) continue;
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    const d = haversine(points[i - 1], points[i]);
    const mph = (d / dt) * 2.23694;
    if (mph < 0.5) continue; // exclude stopped
    totalSec += dt;
    if (mph < 35) buckets.slow += dt;
    else if (mph < 55) buckets.moderate += dt;
    else if (mph < 75) buckets.fast += dt;
    else buckets.highway += dt;
  }
  if (totalSec === 0) return null;
  return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, +(v / totalSec).toFixed(3)]));
}

function timeOfDayDistribution(points, tzH) {
  const buckets = { early_morning: 0, morning: 0, afternoon: 0, evening: 0, night: 0 };
  let totalSec = 0;
  for (let i = 1; i < points.length; i++) {
    const t0 = points[i - 1].time, t1 = points[i].time;
    if (t0 == null || t1 == null) continue;
    const dt = (t1 - t0) / 1000;
    if (dt <= 0) continue;
    totalSec += dt;
    const h = new Date((t0 + t1) / 2 + tzH * 3600000).getUTCHours();
    if (h < 6) buckets.night += dt;
    else if (h < 9) buckets.early_morning += dt;
    else if (h < 12) buckets.morning += dt;
    else if (h < 17) buckets.afternoon += dt;
    else if (h < 21) buckets.evening += dt;
    else buckets.night += dt;
  }
  if (totalSec === 0) return null;
  return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, +(v / totalSec).toFixed(3)]));
}

// ---- weather superlatives (if present on perStage) ----
function weatherSuperlatives(perStage) {
  const withWx = perStage.filter(s => s.stats?.weather).map(s => ({ stage: s.i, day: s.day, w: s.stats.weather }));
  if (!withWx.length) return null;
  const hottest = withWx.reduce((a, b) => (b.w.temp_f ?? -Infinity) > (a.w.temp_f ?? -Infinity) ? b : a);
  const coldest = withWx.reduce((a, b) => (b.w.temp_f ?? Infinity) < (a.w.temp_f ?? Infinity) ? b : a);
  const windiest = withWx.reduce((a, b) => (b.w.wind_mph ?? -Infinity) > (a.w.wind_mph ?? -Infinity) ? b : a);
  return {
    hottest: { stage: hottest.stage, day: hottest.day, temp_f: hottest.w.temp_f, conditions: hottest.w.conditions },
    coldest: { stage: coldest.stage, day: coldest.day, temp_f: coldest.w.temp_f, conditions: coldest.w.conditions },
    windiest: { stage: windiest.stage, day: windiest.day, wind_mph: windiest.w.wind_mph, wind_deg: windiest.w.wind_deg },
  };
}

// ---- f1-style telemetry (derived from GPS alone) ----
// Compute per-point smoothed speed (m/s) and acceleration (m/s²), then find:
//   top speed (with where/when), 0-60 time, % time above 60mph,
//   max lateral G (v²/r cornering), max braking G, max launch G, smoothness score.
function telemetry(points) {
  if (points.length < 5) return null;

  // Smoothed speed: running 3s window. Kills per-sample GPS jitter.
  const speedMps = new Array(points.length).fill(0);
  const timeMs = points.map(p => p.time);
  for (let i = 0; i < points.length; i++) {
    if (timeMs[i] == null) continue;
    let j = i + 1;
    let d = 0;
    while (j < points.length) {
      if (timeMs[j] == null) { j++; continue; }
      d += haversine(points[j - 1], points[j]);
      if ((timeMs[j] - timeMs[i]) >= 5000) break;
      j++;
    }
    if (j >= points.length) { speedMps[i] = speedMps[i - 1] ?? 0; continue; }
    const dt = (timeMs[j] - timeMs[i]) / 1000;
    speedMps[i] = dt > 0 ? d / dt : 0;
  }
  for (let i = points.length - 5; i < points.length; i++) speedMps[i] = speedMps[points.length - 6] ?? 0;

  // Top speed
  let topIdx = 0;
  for (let i = 0; i < points.length; i++) if (speedMps[i] > speedMps[topIdx]) topIdx = i;
  const topMph = speedMps[topIdx] * 2.23694;
  const top_speed = topMph > 1 ? {
    mph: +topMph.toFixed(1),
    kmh: +(speedMps[topIdx] * 3.6).toFixed(1),
    lat: points[topIdx].lat,
    lon: points[topIdx].lon,
    time_iso: iso(points[topIdx].time),
  } : null;

  // Time above 60 mph
  const SIXTY_MPS = 60 / 2.23694;
  let above60Sec = 0, totalSec = 0;
  for (let i = 1; i < points.length; i++) {
    if (timeMs[i - 1] == null || timeMs[i] == null) continue;
    const dt = (timeMs[i] - timeMs[i - 1]) / 1000;
    if (dt <= 0) continue;
    totalSec += dt;
    if (speedMps[i] >= SIXTY_MPS) above60Sec += dt;
  }
  const time_above_60 = totalSec > 0 ? {
    seconds: Math.round(above60Sec),
    minutes: +(above60Sec / 60).toFixed(1),
    pct_of_ride: +(above60Sec / totalSec).toFixed(3),
  } : null;

  // 0-60: find the fastest interval where speed rose from <5mph (sustained 2+s) to >=60mph.
  const FIVE_MPS = 5 / 2.23694;
  let zeroToSixty = null;
  let stillUntil = null;
  for (let i = 0; i < points.length; i++) {
    if (timeMs[i] == null) continue;
    if (speedMps[i] < FIVE_MPS) {
      if (stillUntil == null) stillUntil = timeMs[i];
    } else if (stillUntil != null && (timeMs[i] - stillUntil) >= 2000) {
      // we're moving out of a true stop. Look ahead for 60mph.
      for (let j = i; j < points.length; j++) {
        if (timeMs[j] == null) continue;
        if (speedMps[j] >= SIXTY_MPS) {
          const dt = (timeMs[j] - timeMs[i]) / 1000;
          if (dt > 0 && dt < 30 && (!zeroToSixty || dt < zeroToSixty.seconds)) {
            zeroToSixty = {
              seconds: +dt.toFixed(1),
              start_lat: points[i].lat,
              start_lon: points[i].lon,
              start_time_iso: iso(timeMs[i]),
            };
          }
          break;
        }
        if (speedMps[j] < FIVE_MPS) break; // gave up before reaching 60
      }
      stillUntil = null;
    }
  }

  // Longitudinal G (braking / launch) from 2-second smoothed dv/dt.
  let maxBrakeG = null, maxLaunchG = null;
  for (let i = 0; i < points.length - 1; i++) {
    if (timeMs[i] == null) continue;
    let j = i + 1;
    while (j < points.length && timeMs[j] != null && (timeMs[j] - timeMs[i]) < 2000) j++;
    if (j >= points.length || timeMs[j] == null) break;
    const dt = (timeMs[j] - timeMs[i]) / 1000;
    if (dt <= 0) continue;
    const dv = speedMps[j] - speedMps[i];
    const g = dv / dt / 9.81;
    if (g < 0 && (!maxBrakeG || g < maxBrakeG.g)) {
      maxBrakeG = { g: +g.toFixed(2), mph_delta: +(dv * 2.23694).toFixed(1), lat: points[i].lat, lon: points[i].lon, time_iso: iso(timeMs[i]) };
    }
    if (g > 0 && (!maxLaunchG || g > maxLaunchG.g)) {
      maxLaunchG = { g: +g.toFixed(2), mph_delta: +(dv * 2.23694).toFixed(1), lat: points[i].lat, lon: points[i].lon, time_iso: iso(timeMs[i]) };
    }
  }
  // Sanity clamp: GPS glitches can produce absurd accelerations. Cap at ±3G.
  if (maxBrakeG && maxBrakeG.g < -3) maxBrakeG.g = -3;
  if (maxLaunchG && maxLaunchG.g > 3) maxLaunchG.g = 3;

  // Lateral G via 3-point curvature × v².
  let maxLateralG = null;
  for (let i = 2; i < points.length - 2; i++) {
    // Use points i-2, i, i+2 for a smoother triangle
    const A = points[i - 2], B = points[i], C = points[i + 2];
    if (timeMs[i] == null) continue;
    // equirectangular projection centered at B
    const lat0 = B.lat * Math.PI / 180;
    const mx = 111320 * Math.cos(lat0);
    const my = 110540;
    const ax = (A.lon - B.lon) * mx, ay = (A.lat - B.lat) * my;
    const cx = (C.lon - B.lon) * mx, cy = (C.lat - B.lat) * my;
    const ab = Math.hypot(ax, ay);
    const cb = Math.hypot(cx, cy);
    const ac = Math.hypot(ax - cx, ay - cy);
    if (ab < 2 || cb < 2 || ac < 2) continue; // too short to be meaningful
    const area2 = Math.abs(ax * cy - ay * cx);
    if (area2 < 1) continue; // nearly collinear
    const radius = (ab * cb * ac) / (2 * area2);
    if (radius < 3 || radius > 2000) continue;
    const v = speedMps[i];
    const g = (v * v) / (radius * 9.81);
    if (g > 0 && g < 4 && (!maxLateralG || g > maxLateralG.g)) {
      maxLateralG = {
        g: +g.toFixed(2),
        speed_mph: +(v * 2.23694).toFixed(1),
        radius_m: +radius.toFixed(1),
        lat: B.lat, lon: B.lon,
        time_iso: iso(timeMs[i]),
      };
    }
  }

  // Smoothness: stdev of longitudinal acceleration, mapped to 1-10 where 10 = butter.
  // σ ≈ 0 → 10; σ ≈ 1 m/s² → 5; σ ≥ 2.5 m/s² → 1.
  const accels = [];
  for (let i = 1; i < points.length; i++) {
    if (timeMs[i - 1] == null || timeMs[i] == null) continue;
    const dt = (timeMs[i] - timeMs[i - 1]) / 1000;
    if (dt <= 0) continue;
    accels.push((speedMps[i] - speedMps[i - 1]) / dt);
  }
  let smoothness = null;
  if (accels.length > 10) {
    const mean = accels.reduce((a, b) => a + b, 0) / accels.length;
    const variance = accels.reduce((s, a) => s + (a - mean) ** 2, 0) / accels.length;
    const sigma = Math.sqrt(variance);
    const score = Math.max(1, Math.min(10, Math.round(10 - sigma * 3)));
    smoothness = { stdev_mps2: +sigma.toFixed(2), score };
  }

  return {
    top_speed,
    time_above_60_mph: time_above_60,
    zero_to_sixty_sec: zeroToSixty,
    max_lateral_g: maxLateralG,
    max_braking_g: maxBrakeG,
    max_launch_g: maxLaunchG,
    smoothness,
  };
}

// ---- places traversed (from OSM enrichment if present) ----
// Reads places.geojson if the user ran --enrich osm. Returns a chronologically
// sorted list of places with their timestamps — the "town signs you passed"
// view.
function placesTraversed(outDir) {
  const p = join(outDir, 'places.geojson');
  if (!existsSync(p)) return null;
  let fc;
  try { fc = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!fc?.features?.length) return null;
  const items = fc.features
    .filter(f => f.properties?.name && f.properties?.nearest_time_iso)
    .map(f => ({
      name: f.properties.name,
      place_type: f.properties.place_type,
      population: f.properties.population,
      nearest_km: f.properties.nearest_km,
      time_iso: f.properties.nearest_time_iso,
    }))
    .sort((a, b) => Date.parse(a.time_iso) - Date.parse(b.time_iso));
  return items.length ? items : null;
}

// ---- equivalencies ----
function equivalencies(totals) {
  const out = [];
  const miles = totals.distance_mi ?? 0;
  const km = totals.distance_km ?? 0;
  const gain = totals.ele_gain_m ?? 0;
  const meters = km * 1000;

  const fields = Math.round(meters / FIELD_M);
  out.push(`${fields.toLocaleString()} football fields end-to-end`);

  if (miles >= 26.2) {
    const marathons = miles / 26.2;
    out.push(`${marathons.toFixed(1)}× a marathon in distance`);
  }
  if (miles >= 100) {
    out.push(`a century ride ×${(miles / 100).toFixed(1)}`);
  }
  if (gain >= EMPIRE_M * 0.3) {
    out.push(`${(gain / EMPIRE_M).toFixed(1)}× the Empire State Building climbed`);
  }
  if (gain >= EIFFEL_M * 0.5) {
    out.push(`${(gain / EIFFEL_M).toFixed(1)}× the Eiffel Tower climbed`);
  }
  if (gain >= KILIMANJARO_M * 0.2) {
    out.push(`${(gain / KILIMANJARO_M).toFixed(2)}× Mt. Kilimanjaro from base camp`);
  }
  return out;
}

// ---- main ----
export function computeSuperlatives(deduped, perStage, opts, totals) {
  if (!deduped.length) return null;
  const tzH = opts.tz ?? 0;
  const result = {
    fastest_mile: fastestMile(deduped),
    longest_nonstop: longestNonstop(deduped),
    ...elevationExtremes(deduped),
    biggest_climb: biggestClimb(deduped),
    biggest_descent: biggestDescent(deduped),
    steepest_grade: steepestGrade(deduped),
    compass_extremes: compassExtremes(deduped),
    ...turning(deduped),
    longest_straight: longestStraight(deduped),
    speed_bucket_pct: speedBucketDistribution(deduped),
    time_of_day_pct: timeOfDayDistribution(deduped, tzH),
    weather: weatherSuperlatives(perStage),
    performance: telemetry(deduped),
    places_traversed: placesTraversed(opts.out),
    equivalent_to: equivalencies(totals),
  };
  return result;
}

// ---- pretty console block ----
function fmtPct(n) { return n != null ? `${Math.round(n * 100)}%` : '—'; }
function fmtLatLon(p) { return p ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : '—'; }
function fmtLocalTime(isoStr, tzH) {
  if (!isoStr) return '—';
  const d = new Date(Date.parse(isoStr) + tzH * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function compassArrow(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

export function printSuperlatives(sup, opts) {
  if (!sup) return;
  const tzH = opts.tz ?? 0;
  const bar = '─'.repeat(48);
  const lines = [];
  lines.push('');
  lines.push(`  ${bar}`);
  lines.push(`  superlatives`);
  lines.push(`  ${bar}`);

  if (sup.fastest_mile) {
    const fm = sup.fastest_mile;
    lines.push(`  fastest mile      ${fm.pace} @ ${fm.mph} mph  (${fmtLocalTime(fm.start.time_iso, tzH)})`);
  }
  if (sup.longest_nonstop) {
    const ns = sup.longest_nonstop;
    lines.push(`  longest streak    ${ns.duration_min} min / ${ns.distance_mi} mi without a break`);
  }
  if (sup.highest) {
    lines.push(`  highest point     ${sup.highest.ele_m}m at ${fmtLatLon(sup.highest)}`);
  }
  if (sup.lowest) {
    lines.push(`  lowest point      ${sup.lowest.ele_m}m at ${fmtLatLon(sup.lowest)}`);
  }
  if (sup.biggest_climb) {
    const bc = sup.biggest_climb;
    lines.push(`  biggest climb     ${bc.climbed_m}m over ${bc.distance_km} km (${bc.avg_grade_pct ?? '—'}% avg)`);
  }
  if (sup.biggest_descent) {
    const bd = sup.biggest_descent;
    lines.push(`  biggest descent   ${bd.descended_m}m over ${bd.distance_km} km (${bd.avg_grade_pct ?? '—'}% avg)`);
  }
  if (sup.steepest_grade) {
    const sg = sup.steepest_grade;
    lines.push(`  steepest grade    ${sg.grade_pct}% over ${sg.over_m}m`);
  }
  if (sup.longest_straight) {
    const ls = sup.longest_straight;
    lines.push(`  longest straight  ${ls.distance_m}m (${ls.distance_mi} mi) heading ${compassArrow(ls.bearing_deg)}`);
  }
  if (sup.turns_per_mile != null) {
    const flavor =
      sup.turns_per_mile < 200 ? 'mostly straight' :
      sup.turns_per_mile < 500 ? 'some curves' :
      sup.turns_per_mile < 1000 ? 'a twisty one' :
      'absolutely serpentine';
    lines.push(`  turns per mile    ${sup.turns_per_mile}° — ${flavor}`);
  }

  if (sup.speed_bucket_pct) {
    const b = sup.speed_bucket_pct;
    lines.push(`  time at speed     slow ${fmtPct(b.slow)} · moderate ${fmtPct(b.moderate)} · fast ${fmtPct(b.fast)} · highway ${fmtPct(b.highway)}`);
  }
  if (sup.time_of_day_pct) {
    const t = sup.time_of_day_pct;
    const parts = [];
    if (t.early_morning > 0.05) parts.push(`early morning ${fmtPct(t.early_morning)}`);
    if (t.morning > 0.05) parts.push(`morning ${fmtPct(t.morning)}`);
    if (t.afternoon > 0.05) parts.push(`afternoon ${fmtPct(t.afternoon)}`);
    if (t.evening > 0.05) parts.push(`evening ${fmtPct(t.evening)}`);
    if (t.night > 0.05) parts.push(`night ${fmtPct(t.night)}`);
    if (parts.length) lines.push(`  time of day       ${parts.join(' · ')}`);
  }

  const perf = sup.performance;
  if (perf) {
    lines.push('');
    lines.push(`  telemetry`);
    if (perf.top_speed) lines.push(`    top speed       ${perf.top_speed.mph} mph at ${fmtLocalTime(perf.top_speed.time_iso, tzH)}  (${perf.top_speed.lat.toFixed(4)}, ${perf.top_speed.lon.toFixed(4)})`);
    if (perf.zero_to_sixty_sec) lines.push(`    0-60 mph        ${perf.zero_to_sixty_sec.seconds}s  (${fmtLocalTime(perf.zero_to_sixty_sec.start_time_iso, tzH)})`);
    else lines.push(`    0-60 mph        n/a (never came to a stop before hitting 60)`);
    if (perf.time_above_60_mph) lines.push(`    time > 60 mph   ${perf.time_above_60_mph.minutes} min (${fmtPct(perf.time_above_60_mph.pct_of_ride)} of ride)`);
    if (perf.max_lateral_g) {
      const lg = perf.max_lateral_g;
      lines.push(`    peak cornering  ${lg.g}G at ${lg.speed_mph} mph through a ${lg.radius_m.toFixed(0)}m-radius turn`);
    }
    if (perf.max_braking_g) lines.push(`    hardest brake   ${perf.max_braking_g.g}G  (dropped ${Math.abs(perf.max_braking_g.mph_delta)} mph in 2s)`);
    if (perf.max_launch_g) lines.push(`    biggest launch  ${perf.max_launch_g.g}G  (gained ${perf.max_launch_g.mph_delta} mph in 2s)`);
    if (perf.smoothness) {
      const s = perf.smoothness.score;
      const flavor = s >= 8 ? 'butter' : s >= 6 ? 'smooth' : s >= 4 ? 'mixed bag' : 'jerky';
      lines.push(`    smoothness      ${s}/10 — ${flavor}`);
    }
    lines.push('');
  }

  const ce = sup.compass_extremes;
  if (ce) {
    lines.push(`  furthest north    ${ce.north.lat}°   (${fmtLocalTime(ce.north.time_iso, tzH)})`);
    lines.push(`  furthest south    ${ce.south.lat}°   (${fmtLocalTime(ce.south.time_iso, tzH)})`);
    lines.push(`  furthest east     ${ce.east.lon}°   (${fmtLocalTime(ce.east.time_iso, tzH)})`);
    lines.push(`  furthest west     ${ce.west.lon}°   (${fmtLocalTime(ce.west.time_iso, tzH)})`);
  }

  if (sup.weather) {
    const w = sup.weather;
    if (w.hottest?.temp_f != null) lines.push(`  hottest stage     stage ${w.hottest.stage}: ${w.hottest.temp_f}°F ${w.hottest.conditions ?? ''}`);
    if (w.coldest?.temp_f != null && w.coldest.stage !== w.hottest?.stage) lines.push(`  coldest stage     stage ${w.coldest.stage}: ${w.coldest.temp_f}°F`);
    if (w.windiest?.wind_mph != null) lines.push(`  windiest stage    stage ${w.windiest.stage}: ${w.windiest.wind_mph} mph ${compassArrow(w.windiest.wind_deg ?? 0)}`);
  }

  if (sup.places_traversed?.length) {
    lines.push('');
    lines.push(`  town signs you passed:`);
    const items = sup.places_traversed;
    const show = items.slice(0, 20);
    for (const pl of show) {
      const t = fmtLocalTime(pl.time_iso, tzH);
      const pop = pl.population ? ` · pop. ${Number(pl.population).toLocaleString()}` : '';
      const pt = pl.place_type && pl.place_type !== 'town' ? ` (${pl.place_type})` : '';
      lines.push(`    ${t}  ${pl.name}${pt}${pop}`);
    }
    if (items.length > show.length) {
      lines.push(`    … and ${items.length - show.length} more`);
    }
  }

  if (sup.equivalent_to?.length) {
    lines.push('');
    lines.push(`  roughly equivalent to:`);
    for (const e of sup.equivalent_to) lines.push(`    · ${e}`);
  }
  lines.push(`  ${bar}`);
  console.log(lines.join('\n'));
}
