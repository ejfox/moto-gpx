// OSRM public endpoint — suggested driving route vs. actual track per stage.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://router.project-osrm.org/route/v1/driving';

async function fetchRoute(lon1, lat1, lon2, lat2) {
  const url = `${BASE}/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'moto-gpx/0.1', 'Accept': '*/*' } });
      if (res.status === 504 || res.status === 429) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok) {
        console.error(`    osrm ${lon1},${lat1}→${lon2},${lat2}: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      if (!data.routes || !data.routes[0]) return null;
      return data.routes[0];
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 3000)); continue; }
      console.error(`    osrm: ${e.message}`);
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

export async function fetchOSRMRoutes(perStage, outDir, trip) {
  const jobs = perStage.map(stage => async () => {
    const { pts, stats, i, day } = stage;
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    const route = await fetchRoute(a.lon, a.lat, b.lon, b.lat);
    if (!route || !route.geometry) return null;
    const suggestedKm = route.distance / 1000;
    const actualKm = stats.distance_km;
    const extraPct = suggestedKm > 0 ? +(((actualKm - suggestedKm) / suggestedKm) * 100).toFixed(1) : null;
    return {
      type: 'Feature',
      properties: {
        stage: i,
        day,
        trip,
        actual_distance_km: actualKm,
        actual_distance_mi: +(actualKm * 0.621371).toFixed(3),
        suggested_distance_km: +suggestedKm.toFixed(3),
        suggested_distance_mi: +(suggestedKm * 0.621371).toFixed(3),
        suggested_duration_min: +(route.duration / 60).toFixed(1),
        extra_distance_pct: extraPct,
        endpoints: [[a.lon, a.lat], [b.lon, b.lat]],
      },
      geometry: route.geometry,
    };
  });

  const results = await runWithConcurrency(jobs, 3);
  const features = results.filter(Boolean);
  writeFileSync(
    join(outDir, 'optimal_routes.geojson'),
    JSON.stringify({ type: 'FeatureCollection', properties: { trip }, features }),
  );
  return { count: features.length };
}
