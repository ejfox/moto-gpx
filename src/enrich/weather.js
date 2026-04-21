// Open-Meteo historical archive. Free, no auth. One call per (lat≈1km, lon≈1km, date) cell.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';
const HOURLY = 'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl';

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
