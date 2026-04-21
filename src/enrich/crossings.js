import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversine, dayKey } from '../gpx.js';

const STATES_PATH = fileURLToPath(new URL('../../data/states.geojson', import.meta.url));
const STATES = JSON.parse(readFileSync(STATES_PATH, 'utf8'));

const INDEX = STATES.features.map(f => {
  const rings = [];
  if (f.geometry.type === 'Polygon') rings.push(f.geometry.coordinates);
  else if (f.geometry.type === 'MultiPolygon') rings.push(...f.geometry.coordinates);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const poly of rings) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return { props: f.properties, polys: rings, bbox: [minLon, minLat, maxLon, maxLat] };
});

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPoly(lon, lat, poly) {
  if (!pointInRing(lon, lat, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) {
    if (pointInRing(lon, lat, poly[h])) return false;
  }
  return true;
}

function locate(lon, lat, hint) {
  if (hint != null) {
    const b = INDEX[hint].bbox;
    if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) {
      for (const poly of INDEX[hint].polys) {
        if (pointInPoly(lon, lat, poly)) return hint;
      }
    }
  }
  for (let i = 0; i < INDEX.length; i++) {
    if (i === hint) continue;
    const b = INDEX[i].bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    for (const poly of INDEX[i].polys) {
      if (pointInPoly(lon, lat, poly)) return i;
    }
  }
  return -1;
}

function feat(p, props) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'Point',
      coordinates: p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat],
    },
  };
}

export function computeCrossings(points, tzH, trip) {
  if (!points.length) return [];
  const features = [];
  let cumMeters = 0;
  let prevIdx = -2;

  for (let i = 0; i < points.length; i++) {
    if (i > 0) cumMeters += haversine(points[i - 1], points[i]);
    const p = points[i];
    const idx = locate(p.lon, p.lat, prevIdx >= 0 ? prevIdx : null);

    if (i > 0 && idx !== prevIdx) {
      const fromProps = prevIdx >= 0 ? INDEX[prevIdx].props : null;
      const toProps = idx >= 0 ? INDEX[idx].props : null;
      features.push(feat(p, {
        kind: 'crossing',
        trip,
        from_state: fromProps?.name ?? null,
        to_state: toProps?.name ?? null,
        from_country: fromProps?.admin ?? null,
        to_country: toProps?.admin ?? null,
        from_iso: fromProps?.iso_3166_2 ?? null,
        to_iso: toProps?.iso_3166_2 ?? null,
        time_iso: p.time != null ? new Date(p.time).toISOString() : null,
        day: p.time != null ? dayKey(p.time, tzH) : null,
        mile_into_trip: +(cumMeters / 1609.344).toFixed(3),
        km_into_trip: +(cumMeters / 1000).toFixed(3),
      }));
    }
    prevIdx = idx;
  }

  const last = points[points.length - 1];
  const lastProps = prevIdx >= 0 ? INDEX[prevIdx].props : null;
  features.push(feat(last, {
    kind: 'end_state',
    trip,
    state: lastProps?.name ?? null,
    country: lastProps?.admin ?? null,
    iso: lastProps?.iso_3166_2 ?? null,
    time_iso: last.time != null ? new Date(last.time).toISOString() : null,
    day: last.time != null ? dayKey(last.time, tzH) : null,
    mile_into_trip: +(cumMeters / 1609.344).toFixed(3),
    km_into_trip: +(cumMeters / 1000).toFixed(3),
  }));

  return features;
}
