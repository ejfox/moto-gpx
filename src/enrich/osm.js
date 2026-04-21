/**
 * osm.js — pull roads, place names, and POIs near the track from OpenStreetMap.
 *
 * Role in the pipeline: optional enrichment (--enrich osm). Writes three
 * top-level layers (places.geojson, roads.geojson, pois.geojson) and
 * attaches a `stats.roads` summary to each stage.
 *
 * Contract: fail-soft. Overpass queries retry once on 429/504 after a 5 s
 * backoff, then skip. A failed query produces no file and no stats but
 * doesn't throw. The three queries run sequentially — Overpass doesn't like
 * concurrent hits from the same IP.
 *
 * External: public Overpass API (overpass-api.de). No auth. Community-hosted;
 * polite usage is expected — we set User-Agent, keep queries tightly
 * bbox-scoped, and serialize requests.
 *
 * Exports:
 *   - fetchOSM(bbox, points, perStage, outDir, trip) — primary entry point.
 */

// ═══ Overpass API ═══
//
//   Endpoint: https://overpass-api.de/api/interpreter
//   Community instance run by the OpenStreetMap volunteer group. Free,
//   no API key. Alt mirrors exist (overpass.kumi.systems, overpass.osm.ch)
//   if overpass-api.de is down — swap ENDPOINT and expect identical behavior.
//
//   Query language: Overpass QL. We POST a form-encoded `data=<query>` body.
//   Every query here is bounded by the trip bbox to keep response size sane.
//
//   Rate limiting: the public instance enforces per-IP slot limits
//   (~2 concurrent, 10k / day). We always serialize (no Promise.all) and
//   set a User-Agent so we can be identified and rate-limited cleanly.
//
//   Status codes seen in the wild:
//     429 Too Many Requests    — slot exhausted, retry after 5 s
//     504 Gateway Timeout      — query too heavy; retrying usually works
//     200 OK                   — JSON with `elements: [...]`
//
//   Response shape:
//     {
//       version: ..., generator: ..., osm3s: {...},
//       elements: [
//         { type: "node", id, lat, lon, tags: { ... } },
//         { type: "way",  id, nodes: [...], geometry: [{lat,lon}, ...], tags: {...} },
//         ...
//       ]
//     }
//   We request `out geom` for ways so each way carries its full inline
//   geometry; this avoids a second query to resolve node references.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { haversine } from '../gpx.js';

// ═══ constants ═══
const ENDPOINT = 'https://overpass-api.de/api/interpreter';

// ═══ HTTP helpers ═══
// POSTs an Overpass QL query. One automatic retry (5 s backoff) on 429/504
// and on any transport error. Returns parsed JSON or null.
async function overpass(query) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': '*/*',
          'User-Agent': 'moto-gpx/0.1',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (res.status === 429 || res.status === 504) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (!res.ok) {
        console.error(`    overpass HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 5000)); continue; }
      console.error(`    overpass: ${e.message}`);
      return null;
    }
  }
  return null;
}

function writeFc(path, features, properties = {}) {
  writeFileSync(path, JSON.stringify({ type: 'FeatureCollection', properties, features }));
}

// nearest trkpt index + distance (meters) for a given lat/lon; sample every `step` points.
function nearestTrkpt(points, lat, lon, step = 1) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < points.length; i += step) {
    const d = haversine({ lat, lon }, points[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, dist: bestD };
}

export async function fetchOSM(bbox, points, perStage, outDir, trip) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const bboxStr = `${minLat},${minLon},${maxLat},${maxLon}`;

  // ---------- PLACES ----------
  const placesQ = `[out:json][timeout:60];(node["place"~"city|town|village|hamlet"](${bboxStr}););out body;`;
  const placesRaw = await overpass(placesQ);
  const placeFeatures = [];
  if (placesRaw && placesRaw.elements) {
    for (const el of placesRaw.elements) {
      if (el.type !== 'node' || el.lat == null || el.lon == null) continue;
      const near = nearestTrkpt(points, el.lat, el.lon, 10);
      if (near.dist >= 2000) continue;
      const t = el.tags || {};
      const nearestTime = points[near.index]?.time ?? null;
      placeFeatures.push({
        type: 'Feature',
        properties: {
          name: t.name ?? null,
          place_type: t.place ?? null,
          population: t.population ? Number(t.population) || t.population : null,
          trip,
          nearest_km: +(near.dist / 1000).toFixed(3),
          nearest_time_iso: nearestTime != null ? new Date(nearestTime).toISOString() : null,
          _t: nearestTime ?? Number.MAX_SAFE_INTEGER,
        },
        geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
      });
    }
    placeFeatures.sort((a, b) => a.properties._t - b.properties._t);
    for (const f of placeFeatures) delete f.properties._t;
    writeFc(join(outDir, 'places.geojson'), placeFeatures, { trip });
  }

  // ---------- ROADS ----------
  const roadsQ = `[out:json][timeout:90];(way["highway"~"motorway|trunk|primary|secondary|tertiary|unclassified|residential"](${bboxStr}););out geom;`;
  const roadsRaw = await overpass(roadsQ);
  const roadFeatures = [];
  // For per-stage road naming: for each stage, count trkpt->nearest-way hits.
  const stageWayCounts = perStage.map(() => new Map()); // stageIdx -> Map<osmId, count>
  const wayMeta = new Map(); // osmId -> { name, ref, highway }

  if (roadsRaw && roadsRaw.elements) {
    const kept = [];
    for (const el of roadsRaw.elements) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      // Keep only ways with at least one node within 100m of a (sampled) trkpt.
      let close = false;
      for (const g of el.geometry) {
        const n = nearestTrkpt(points, g.lat, g.lon, 20);
        if (n.dist < 100) { close = true; break; }
      }
      if (!close) continue;
      const t = el.tags || {};
      kept.push(el);
      wayMeta.set(el.id, { name: t.name ?? null, ref: t.ref ?? null, highway: t.highway ?? null });
      roadFeatures.push({
        type: 'Feature',
        properties: {
          osm_id: el.id,
          name: t.name ?? null,
          ref: t.ref ?? null,
          highway: t.highway ?? null,
          surface: t.surface ?? null,
          maxspeed: t.maxspeed ?? null,
          trip,
        },
        geometry: {
          type: 'LineString',
          coordinates: el.geometry.map(g => [g.lon, g.lat]),
        },
      });
    }
    writeFc(join(outDir, 'roads.geojson'), roadFeatures, { trip });

    // Stage road attribution: for each stage trkpt, find its nearest kept way by min-node-distance.
    // To keep O() sane: flatten all kept way nodes into one array with backref.
    if (kept.length) {
      const wayNodes = [];
      for (const el of kept) {
        for (const g of el.geometry) wayNodes.push({ lat: g.lat, lon: g.lon, id: el.id });
      }
      for (let si = 0; si < perStage.length; si++) {
        const stage = perStage[si];
        const counts = stageWayCounts[si];
        for (let pi = 0; pi < stage.pts.length; pi += 5) {
          const p = stage.pts[pi];
          let bestId = null, bestD = Infinity;
          for (const w of wayNodes) {
            const d = haversine({ lat: w.lat, lon: w.lon }, p);
            if (d < bestD) { bestD = d; bestId = w.id; }
          }
          if (bestId != null && bestD < 150) {
            counts.set(bestId, (counts.get(bestId) || 0) + 1);
          }
        }
      }
      // Mutate stage stats with road summary.
      for (let si = 0; si < perStage.length; si++) {
        const counts = stageWayCounts[si];
        if (!counts.size) continue;
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const names = [];
        const refs = new Set();
        const hwCounts = {};
        let total = 0;
        for (const [id, n] of sorted) {
          total += n;
          const meta = wayMeta.get(id);
          if (!meta) continue;
          if (meta.name && !names.includes(meta.name) && names.length < 3) names.push(meta.name);
          if (meta.ref) for (const r of String(meta.ref).split(';')) refs.add(r.trim());
          if (meta.highway) hwCounts[meta.highway] = (hwCounts[meta.highway] || 0) + n;
        }
        const highway_classes = {};
        for (const [k, v] of Object.entries(hwCounts)) highway_classes[k] = +(v / total).toFixed(3);
        perStage[si].stats.roads = {
          names,
          refs: [...refs].filter(Boolean),
          highway_classes,
        };
      }
    }
  }

  // ---------- POIs ----------
  const poisQ = `[out:json][timeout:60];(node["tourism"~"viewpoint|attraction"](${bboxStr});node["natural"="peak"](${bboxStr});node["historic"](${bboxStr});node["amenity"="fuel"](${bboxStr}););out body;`;
  const poisRaw = await overpass(poisQ);
  const poiFeatures = [];
  if (poisRaw && poisRaw.elements) {
    for (const el of poisRaw.elements) {
      if (el.type !== 'node' || el.lat == null || el.lon == null) continue;
      const near = nearestTrkpt(points, el.lat, el.lon, 10);
      if (near.dist >= 1000) continue;
      const t = el.tags || {};
      let kind = null;
      if (t.tourism === 'viewpoint' || t.tourism === 'attraction') kind = 'viewpoint';
      else if (t.natural === 'peak') kind = 'peak';
      else if (t.amenity === 'fuel') kind = 'fuel';
      else if (t.historic) kind = 'historic';
      if (!kind) continue;
      poiFeatures.push({
        type: 'Feature',
        properties: {
          name: t.name ?? null,
          kind,
          nearest_km: +(near.dist / 1000).toFixed(3),
          trip,
        },
        geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
      });
    }
    writeFc(join(outDir, 'pois.geojson'), poiFeatures, { trip });
  }

  return {
    roads: roadFeatures.length,
    places: placeFeatures.length,
    pois: poiFeatures.length,
  };
}
