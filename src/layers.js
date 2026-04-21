import { haversine, bboxOf, simplifyPoints, toLineFeature, dayKey, segmentStats } from './gpx.js';

const SHORT_REST_MIN_MS = 20 * 60_000;
const LONG_REST_MIN_MS = 60 * 60_000;
const OVERNIGHT_MS = 6 * 60 * 60_000;
const CHUNK_SEC = 60;
const BIN_SLOW_MAX = 35;
const BIN_MODERATE_MAX = 55;
const BIN_FAST_MAX = 75;

function iso(t) { return t != null ? new Date(t).toISOString() : null; }

function localHM(t, tzH) {
  const d = new Date(t + tzH * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function speedBin(mph) {
  if (mph < BIN_SLOW_MAX) return 'slow';
  if (mph < BIN_MODERATE_MAX) return 'moderate';
  if (mph < BIN_FAST_MAX) return 'fast';
  return 'highway';
}

export function detectStops(rawPoints, gapMs, tzH, trip) {
  const stops = [];
  for (let i = 1; i < rawPoints.length; i++) {
    const a = rawPoints[i - 1];
    const b = rawPoints[i];
    if (a.time == null || b.time == null) continue;
    const dur = b.time - a.time;
    if (dur < gapMs) continue;

    const aDay = dayKey(a.time, tzH);
    const bDay = dayKey(b.time, tzH);
    const crossesDay = aDay !== bDay;
    let kind;
    if (dur >= OVERNIGHT_MS || crossesDay) kind = 'overnight';
    else if (dur >= LONG_REST_MIN_MS) kind = 'long-rest';
    else if (dur >= SHORT_REST_MIN_MS) kind = 'rest';
    else kind = 'short-rest';

    // anchor at the point before the gap — that's where the rider actually stopped
    const lon = a.lon, lat = a.lat, ele = a.ele;
    stops.push({
      type: 'Feature',
      properties: {
        trip,
        kind,
        duration_min: +(dur / 60_000).toFixed(1),
        arrival_iso: iso(a.time),
        departure_iso: iso(b.time),
        arrival_day: aDay,
        departure_day: bDay,
        bbox: bboxOf([a, b]),
      },
      geometry: {
        type: 'Point',
        coordinates: ele != null ? [lon, lat, ele] : [lon, lat],
      },
    });
  }
  return stops;
}

export function speedBinSegments(stagePoints, stageIndex, day, trip) {
  const feats = [];
  if (stagePoints.length < 2) return feats;
  const chunkMs = CHUNK_SEC * 1000;

  let chunk = [stagePoints[0]];
  let chunkStart = stagePoints[0].time;

  function flush(nextPt) {
    if (chunk.length >= 2) {
      let dist = 0;
      for (let i = 1; i < chunk.length; i++) dist += haversine(chunk[i - 1], chunk[i]);
      const t0 = chunk[0].time;
      const t1 = chunk[chunk.length - 1].time;
      const dt = (t0 != null && t1 != null) ? (t1 - t0) / 1000 : 0;
      const mph = dt > 0 ? (dist / dt) * 2.23694 : 0;
      feats.push(toLineFeature(chunk, {
        stage: stageIndex,
        day,
        trip,
        speed_mph: +mph.toFixed(1),
        speed_bin: speedBin(mph),
        distance_m: +dist.toFixed(1),
        start_iso: iso(t0),
        end_iso: iso(t1),
      }));
    }
    if (nextPt) {
      chunk = [chunk[chunk.length - 1], nextPt];
      chunkStart = chunk[0].time;
    }
  }

  for (let i = 1; i < stagePoints.length; i++) {
    const p = stagePoints[i];
    chunk.push(p);
    if (p.time != null && chunkStart != null && (p.time - chunkStart) >= chunkMs) {
      flush(stagePoints[i + 1] || null);
      // flush seeded the next chunk with [last, next]; skip the next iteration's push
      if (stagePoints[i + 1]) i++;
    }
  }
  if (chunk.length >= 2) flush(null);
  return feats;
}

export function startEndMarkers(perStage, tzH, trip) {
  const feats = [];

  function mkPoint(p, props) {
    return {
      type: 'Feature',
      properties: props,
      geometry: {
        type: 'Point',
        coordinates: p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat],
      },
    };
  }

  for (const { i, pts, day } of perStage) {
    if (!pts.length) continue;
    const first = pts[0];
    const last = pts[pts.length - 1];
    feats.push(mkPoint(first, {
      kind: 'stage_start',
      stage: i,
      day,
      time_iso: iso(first.time),
      trip,
      label: `Stage ${i} start — ${first.time != null ? localHM(first.time, tzH) : '?'}`,
    }));
    feats.push(mkPoint(last, {
      kind: 'stage_end',
      stage: i,
      day,
      time_iso: iso(last.time),
      trip,
      label: `Stage ${i} end — ${last.time != null ? localHM(last.time, tzH) : '?'}`,
    }));
  }

  const byDay = new Map();
  for (const { pts, day } of perStage) {
    if (day == null || !pts.length) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(...pts);
  }
  const sortedDays = [...byDay.keys()].sort();
  sortedDays.forEach((day, idx) => {
    const pts = byDay.get(day).filter(p => p.time != null).sort((a, b) => a.time - b.time);
    if (!pts.length) return;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const label = `Day ${idx + 1}`;
    feats.push(mkPoint(first, {
      kind: 'day_start',
      day,
      time_iso: iso(first.time),
      trip,
      label: `${label} start — ${localHM(first.time, tzH)}`,
    }));
    feats.push(mkPoint(last, {
      kind: 'day_end',
      day,
      time_iso: iso(last.time),
      trip,
      label: `${label} end — ${localHM(last.time, tzH)}`,
    }));
  });

  return feats;
}

export function mergedDayLines(deduped, tzH, trip, simplifyMeters) {
  const byDay = new Map();
  for (const p of deduped) {
    if (p.time == null) continue;
    const k = dayKey(p.time, tzH);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  const out = [];
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const pts = byDay.get(day);
    if (pts.length < 2) continue;
    const simp = simplifyMeters > 0 ? simplifyPoints(pts, simplifyMeters) : pts;
    const stats = segmentStats(pts);
    out.push(toLineFeature(simp, { day, trip, ...stats }));
  }
  return out;
}
