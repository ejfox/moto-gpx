/**
 * layers.js — builds the categorical GeoJSON layers (stops, speed-binned
 * segments, start/end markers, merged per-day lines) consumed by QGIS.
 *
 * Role in the pipeline: runs after GPX parsing + dedupe + stage segmentation
 * (see `gpx.js`). Each exported function produces a flat array of GeoJSON
 * Features that the top-level driver (`moto-gpx.js`) wraps in a
 * FeatureCollection and writes to disk. Nothing in this module performs I/O.
 *
 * Contract:
 *   - All inputs are already deduped and time-sorted by the caller.
 *   - Trkpts may have `time === null` / `ele === null`; every branch that
 *     depends on those fields must guard against null.
 *   - Returned Features use [lon, lat] or [lon, lat, ele] coordinate order
 *     (GeoJSON RFC 7946) and never mutate the input points.
 *
 * External dependencies: `./gpx.js` (haversine, bboxOf, simplifyPoints,
 *   toLineFeature, dayKey, segmentStats).
 *
 * Exports:
 *   - detectStops         — point features at gaps (short-rest → overnight)
 *   - speedBinSegments    — ~60s line chunks tagged slow/moderate/fast/highway
 *   - startEndMarkers     — per-stage and per-day first/last point markers
 *   - mergedDayLines      — one simplified LineString per calendar day
 */

import { haversine, bboxOf, simplifyPoints, toLineFeature, dayKey, segmentStats } from './gpx.js';

// ═══ constants ═══

// Minimum gap duration to classify as a "short rest" (coffee / fuel pause).
// Anything under this stays implicit in the track and is never emitted as a
// stop feature (the caller's `gapMs` parameter is compared separately).
const SHORT_REST_MIN_MS = 20 * 60_000;

// "Long rest" threshold — roughly a meal or a proper stretch. Under 6 h and
// not crossing midnight, so still same-day.
const LONG_REST_MIN_MS = 60 * 60_000;

// Gaps ≥ 6 h or that cross a calendar day boundary are counted as overnight
// stops regardless of total duration — riders commonly sleep 5 h in a motel
// and that shouldn't read as "just a long lunch." The day-cross check catches
// short overnights (e.g. 11pm → 6am) that the 6h bar would otherwise miss.
const OVERNIGHT_MS = 6 * 60 * 60_000;

// Length of a speed-binned segment. 60s is long enough to average over GPS
// jitter and short enough that distinct road types (surface street vs
// highway) end up in their own features instead of getting blurred together.
const CHUNK_SEC = 60;

// Speed bin edges in MPH. Tuned for US-style riding: under 35 is neighborhood
// / technical; 35–55 is typical secondary road; 55–75 is expressway; 75+ is
// full interstate. Chosen to align with common OSM `maxspeed` categories.
const BIN_SLOW_MAX = 35;
const BIN_MODERATE_MAX = 55;
const BIN_FAST_MAX = 75;

// ═══ private helpers ═══

/** Format an epoch-ms time as ISO-8601, or null when input is null. */
function iso(t) { return t != null ? new Date(t).toISOString() : null; }

/**
 * Format an epoch-ms time as local HH:MM given a timezone offset in hours.
 * Works without `Intl`/TZ database — we just shift and use UTC getters, which
 * is enough for the fixed integer-hour offsets the CLI accepts.
 */
function localHM(t, tzH) {
  const d = new Date(t + tzH * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Map a speed in MPH to one of four bin labels (see BIN_* constants). */
function speedBin(mph) {
  if (mph < BIN_SLOW_MAX) return 'slow';
  if (mph < BIN_MODERATE_MAX) return 'moderate';
  if (mph < BIN_FAST_MAX) return 'fast';
  return 'highway';
}

// ═══ typedefs ═══

/**
 * @typedef {Object} Trkpt
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} ele   - meters, or null when GPX had no <ele>
 * @property {number|null} time  - ms since epoch, or null when untimed
 */

/**
 * @typedef {Object} Stage
 * @property {number}   i    - chronological 0-based stage index
 * @property {Trkpt[]}  pts  - all trkpts in the stage (time-sorted)
 * @property {string}   day  - local date "YYYY-MM-DD" for the stage
 * @property {Object}  [stats] - segmentStats() output, if computed
 */

// ═══ public API ═══

/**
 * Detect inter-point time gaps and emit a Point Feature for each one that
 * qualifies as a stop. A "stop" is any consecutive pair of trkpts whose
 * time delta is ≥ `gapMs`; the `kind` property escalates from `short-rest`
 * to `overnight` based on duration and whether the gap crosses midnight.
 *
 * The anchor point is the trkpt BEFORE the gap — that's where the rider
 * actually arrived and stopped. The point AFTER the gap is their departure.
 *
 * @param {Trkpt[]} rawPoints Deduped, time-sorted trkpts.
 * @param {number}  gapMs    Minimum gap in ms to consider (e.g. 20*60_000).
 * @param {number}  tzH      Integer-hour timezone offset used for day keys.
 * @param {string}  trip     Trip label copied to each feature's properties.
 * @returns {Object[]} GeoJSON Point Features, one per qualifying gap.
 */
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

/**
 * Break a single stage into fixed-duration chunks (~CHUNK_SEC each) and emit
 * one LineString Feature per chunk, tagged with the chunk's average speed
 * and bin label. Consumers (QGIS, SVG renderer) use `speed_bin` to colour
 * segments categorically without having to re-bin on the fly.
 *
 * Chunks are stitched: each chunk ends at the point that first pushes its
 * elapsed time ≥ CHUNK_SEC, and the NEXT chunk begins with [lastPt, nextPt]
 * so there is no visual gap between consecutive segments.
 *
 * @param {Trkpt[]} stagePoints Points for a single stage (time-sorted).
 * @param {number}  stageIndex  Stage index copied to properties.
 * @param {string}  day         Local day key ("YYYY-MM-DD").
 * @param {string}  trip        Trip label.
 * @returns {Object[]} GeoJSON LineString Features.
 */
export function speedBinSegments(stagePoints, stageIndex, day, trip) {
  const feats = [];
  if (stagePoints.length < 2) return feats;
  const chunkMs = CHUNK_SEC * 1000;

  let chunk = [stagePoints[0]];
  let chunkStart = stagePoints[0].time;

  // Flush emits the current chunk as a LineString and (optionally) seeds the
  // next chunk with [lastPtOfPrevChunk, nextPt] so segments share a vertex.
  function flush(nextPt) {
    if (chunk.length >= 2) {
      let dist = 0;
      for (let i = 1; i < chunk.length; i++) dist += haversine(chunk[i - 1], chunk[i]);
      const t0 = chunk[0].time;
      const t1 = chunk[chunk.length - 1].time;
      const dt = (t0 != null && t1 != null) ? (t1 - t0) / 1000 : 0;
      // 2.23694 m/s → mph (exact: 3600/1609.344).
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

/**
 * Emit start/end Point Features at two granularities:
 *   1. Per stage — one `stage_start` + one `stage_end` per `perStage` entry.
 *   2. Per calendar day — `day_start`/`day_end` at the chronologically first
 *      and last timed points of each day, which may differ from stage
 *      boundaries when a stage is split by an overnight stop.
 *
 * @param {Stage[]} perStage Stage records in chronological order.
 * @param {number}  tzH      Integer-hour timezone offset for label formatting.
 * @param {string}  trip     Trip label.
 * @returns {Object[]} GeoJSON Point Features.
 */
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

  // Second pass: collapse stages by local day so we can emit one pair of
  // markers per calendar day. Stages from different days stay separated;
  // multiple stages in the same day merge into a single day_start/day_end.
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

/**
 * Collapse all deduped points into one simplified LineString per calendar
 * day — useful as a clean overview layer when per-stage lines are too busy.
 *
 * @param {Trkpt[]} deduped        All deduped, time-sorted trkpts.
 * @param {number}  tzH            Integer-hour timezone offset (day bucket key).
 * @param {string}  trip           Trip label.
 * @param {number}  simplifyMeters Douglas-Peucker tolerance. 0 disables simplification.
 * @returns {Object[]} GeoJSON LineString Features, one per day with ≥2 points.
 */
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
