/**
 * weather.js — attach historical hourly weather to each stage via Open-Meteo.
 *
 * Role in the pipeline: optional enrichment (--enrich weather). Mutates each
 * perStage entry in place (adds `stats.weather`) and writes a separate
 * `weather_timeline.json` with full hourly traces for downstream charts.
 *
 * Contract: fail-soft. One retry on 429/network error, then skip that cell.
 * Stages whose cell failed simply won't have a `.weather` stat — the rest
 * of the pipeline never throws because of missing weather data.
 *
 * External: Open-Meteo Historical Archive API.
 *
 * Exports:
 *   - fetchWeatherForStages(perStage, outDir) — primary entry point.
 */

// ═══ Open-Meteo historical archive API ═══
//
//   https://archive-api.open-meteo.com/v1/archive
//   Free, no auth, no API key. Public SaaS, CC-BY attribution.
//   Hourly data from 1940-01-01 through roughly T-5 days (refreshed daily
//   from ERA5 reanalysis).
//   Rate limit (as of writing): ~10,000 req/day per IP; we burn O(cells) per
//   trip where a cell is (lat@0.01°, lon@0.01°, date) — i.e. ~1 km × 1 km
//   grid × days. A week-long trip is << 100 cells. On 429 we back off 2 s
//   and retry once; further 429s are logged and the cell is skipped.
//
// Response shape (abbreviated):
//   {
//     "hourly": {
//       "time": ["2024-06-01T00:00", ...],          // ISO-8601, no TZ, UTC
//       "temperature_2m":       [number|null, ...],
//       "relative_humidity_2m": [number|null, ...],
//       "precipitation":        [number|null, ...],  // mm
//       "weather_code":         [number|null, ...],  // WMO 4677
//       "wind_speed_10m":       [number|null, ...],
//       "wind_direction_10m":   [number|null, ...],  // 0=N, 90=E, ...
//       "pressure_msl":         [number|null, ...],  // hPa / mb
//     }
//   }
//   All arrays are parallel to `hourly.time` and may contain nulls when the
//   reanalysis has gaps.
//
//   We request `timezone=GMT` so timestamps are UTC and can be matched by
//   substring against our own ISO timestamps.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ═══ constants ═══
const ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl';

// ═══ WMO 4677 weather-code mapping ═══
// Open-Meteo's `weather_code` is the WMO present-weather code. Buckets here
// follow the documented Open-Meteo mapping (abridged for legibility).
function wmoConditions(code) {
  if (code == null) return null;
  if (code === 0) return 'clear';
  if (code >= 1 && code <= 3) return 'partly cloudy';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 86) return 'showers';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'unknown';
}

// ═══ HTTP helpers ═══
// One cell = (lat, lon, date). Retries once on 429 with a 2 s backoff,
// then once on network error. Returns the parsed JSON or null.
async function fetchCell(lat, lon, date) {
  const url = `${ENDPOINT}?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&hourly=${HOURLY}&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'moto-gpx/0.1', 'Accept': '*/*' } });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (!res.ok) {
        console.error(`    weather ${lat},${lon} ${date}: HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
      console.error(`    weather ${lat},${lon} ${date}: ${e.message}`);
      return null;
    }
  }
  return null;
}

// Cooperative worker pool — up to `limit` jobs in flight. Each job is a
// thunk (`() => Promise`). Preserves result order to match jobs array order.
async function runWithConcurrency(jobs, limit) {
  const results = new Array(jobs.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ═══ public API ═══

/**
 * Fetch hourly weather for every stage's midpoint (lat, lon, date) cell and
 * attach to each stage's stats.
 *
 * Mutates: each `perStage[i].stats.weather` is assigned the nearest-hour
 * snapshot for the stage's temporal midpoint. Stages whose cell fetch
 * failed are left without `.weather`.
 *
 * Writes: `<outDir>/weather_timeline.json` — keyed by "lat|lon|date", each
 * value is `{ lat, lon, date, hourly: <full Open-Meteo response> }`. Handy
 * for side-panel charts that want the full day, not just the midpoint.
 *
 * Cell grouping: coordinates are rounded to 0.01° (~1 km) and grouped with
 * the date so stages that pass through the same area on the same day share
 * one API call.
 *
 * Fail-soft: on network error, 429 after retry, or 5xx, the affected cell
 * silently has `data: null` and its stages get no weather attached. The
 * function never throws — the pipeline continues.
 *
 * @param {Array<{pts: Array<{lat:number,lon:number,time:number}>, stats:{start_iso?:string,end_iso?:string}}>} perStage
 *   stages from the main pipeline; mutated in place.
 * @param {string} outDir  absolute path to the pipeline's output directory
 * @returns {Promise<{stages:number, cells:number, timeline_path:string}>}
 */
export async function fetchWeatherForStages(perStage, outDir) {
  const cellKey = (lat, lon, date) => `${lat.toFixed(2)}|${lon.toFixed(2)}|${date}`;
  const cells = new Map();
  const stageAssign = [];

  for (const stage of perStage) {
    const { pts, stats } = stage;
    if (!pts.length || !stats.start_iso) { stageAssign.push(null); continue; }
    const mid = pts[Math.floor(pts.length / 2)];
    const latR = +mid.lat.toFixed(2);
    const lonR = +mid.lon.toFixed(2);
    const date = stats.start_iso.slice(0, 10);
    const key = cellKey(latR, lonR, date);
    if (!cells.has(key)) cells.set(key, { lat: latR, lon: lonR, date, data: null });
    const startT = Date.parse(stats.start_iso);
    const endT = Date.parse(stats.end_iso);
    const midT = Number.isFinite(startT) && Number.isFinite(endT) ? (startT + endT) / 2 : startT;
    stageAssign.push({ key, midT });
  }

  // Conservative concurrency: 3 parallel requests stays comfortably under
  // Open-Meteo's per-IP rate limit even for long trips.
  const keys = [...cells.keys()];
  const jobs = keys.map(k => async () => {
    const c = cells.get(k);
    const data = await fetchCell(c.lat, c.lon, c.date);
    c.data = data;
  });
  await runWithConcurrency(jobs, 3);

  for (let i = 0; i < perStage.length; i++) {
    const assign = stageAssign[i];
    if (!assign) continue;
    const cell = cells.get(assign.key);
    if (!cell || !cell.data || !cell.data.hourly || !cell.data.hourly.time) continue;
    const hourly = cell.data.hourly;
    // Match on the "YYYY-MM-DDTHH" prefix; both sides are UTC because we
    // asked for `timezone=GMT`. Fall back to hour 0 of that day if not
    // found (shouldn't happen for same-day stages).
    const targetHour = new Date(assign.midT).toISOString().slice(0, 13);
    let hit = -1;
    for (let h = 0; h < hourly.time.length; h++) {
      if (hourly.time[h].slice(0, 13) === targetHour) { hit = h; break; }
    }
    if (hit < 0) hit = 0;
    const code = hourly.weather_code?.[hit] ?? null;
    perStage[i].stats.weather = {
      temp_f: hourly.temperature_2m?.[hit] ?? null,
      humidity_pct: hourly.relative_humidity_2m?.[hit] ?? null,
      precipitation_mm: hourly.precipitation?.[hit] ?? null,
      weather_code: code,
      wind_mph: hourly.wind_speed_10m?.[hit] ?? null,
      wind_deg: hourly.wind_direction_10m?.[hit] ?? null,
      pressure_mb: hourly.pressure_msl?.[hit] ?? null,
      conditions: wmoConditions(code),
      cell: { lat: cell.lat, lon: cell.lon, date: cell.date },
    };
  }

  const timeline = {};
  for (const [key, c] of cells) {
    if (!c.data) continue;
    timeline[key] = { lat: c.lat, lon: c.lon, date: c.date, hourly: c.data.hourly ?? null };
  }
  const timelinePath = 'weather_timeline.json';
  writeFileSync(join(outDir, timelinePath), JSON.stringify(timeline));

  return { stages: perStage.length, cells: cells.size, timeline_path: timelinePath };
}
