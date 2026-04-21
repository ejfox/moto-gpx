#!/usr/bin/env node
// moto-gpx — dump a folder of GPX, get dope map-ready GeoJSON.
// Zero deps. Node 18+.

import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, extname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// -------- args --------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.log(`moto-gpx <folder> [options]

Recursively reads GPX files, merges & sorts by time, splits on break gaps,
emits GeoJSON (one feature per stage) + per-day and per-hour files + stats.

Options:
  --out <dir>          Output directory (default: ./moto-out)
  --split <mode>       day | hour | stage | all  (default: all)
  --break <minutes>    Gap threshold to start a new stage (default: 20)
  --min-points <n>     Drop stages with fewer points (default: 10)
  --simplify <meters>  Douglas-Peucker tolerance, 0 = off (default: 0)
  --tz <offset>        Hours from UTC for day/hour bucketing (default: local)
  --name <string>      Trip name (default: folder name)
  --media <dir>        Also ingest JPG/HEIC/MP4/MOV via exiftool (GPS+time)
                       Emits media.geojson as Point features, matched to stages
  --media-tz <offset>  Override tz for naive EXIF timestamps (default: --tz)

Output:
  <out>/all.geojson          every stage as LineString
  <out>/days/YYYY-MM-DD.geojson
  <out>/hours/YYYY-MM-DD_HH.geojson
  <out>/stages/stage-NN.geojson
  <out>/stats.json           per-stage distance, duration, speed, elevation
  <out>/media.geojson        photos/videos as Point features (if --media)
`);
  process.exit(0);
}

const folder = resolve(argv[0]);
const opts = {
  out: './moto-out',
  split: 'all',
  breakMin: 20,
  minPoints: 10,
  simplify: 0,
  tz: new Date().getTimezoneOffset() / -60,
  name: basename(folder),
  media: null,
  mediaTz: null,
};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opts.out = argv[++i];
  else if (a === '--split') opts.split = argv[++i];
  else if (a === '--break') opts.breakMin = Number(argv[++i]);
  else if (a === '--min-points') opts.minPoints = Number(argv[++i]);
  else if (a === '--simplify') opts.simplify = Number(argv[++i]);
  else if (a === '--tz') opts.tz = Number(argv[++i]);
  else if (a === '--name') opts.name = argv[++i];
  else if (a === '--media') opts.media = resolve(argv[++i]);
  else if (a === '--media-tz') opts.mediaTz = Number(argv[++i]);
}
if (opts.mediaTz == null) opts.mediaTz = opts.tz;
opts.out = resolve(opts.out);

// -------- gpx parsing (regex, tolerant) --------
function parseGpx(xml) {
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
    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, time: Number.isFinite(time) ? time : null });
  }
  return points;
}

// -------- geo helpers --------
function haversine(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bboxOf(points) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (p.lon < b[0]) b[0] = p.lon;
    if (p.lat < b[1]) b[1] = p.lat;
    if (p.lon > b[2]) b[2] = p.lon;
    if (p.lat > b[3]) b[3] = p.lat;
  }
  return b[0] === Infinity ? null : b;
}

// Douglas-Peucker in local equirectangular meters.
function simplifyPoints(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const lat0 = (points[0].lat * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
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

// -------- stage splitting --------
function splitStages(points, gapMs) {
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

// -------- media (exiftool) --------
// Parse an EXIF-ish timestamp. Formats seen:
//   "2025:06:01 14:23:45"
//   "2025:06:01 14:23:45-04:00"
//   "2025:06:01 14:23:45.123Z"
// tzFallbackH is applied only when no offset is embedded.
function parseExifTime(s, tzFallbackH) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se, tz] = m;
  const base = `${Y}-${Mo}-${D}T${h}:${mi}:${se}`;
  if (tz) {
    const norm = tz === 'Z' ? 'Z' : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
    const t = Date.parse(base + norm);
    return Number.isFinite(t) ? t : null;
  }
  const sign = tzFallbackH >= 0 ? '+' : '-';
  const abs = Math.abs(tzFallbackH);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
  const t = Date.parse(`${base}${sign}${hh}:${mm}`);
  return Number.isFinite(t) ? t : null;
}

function ingestMedia(dir, tzH) {
  // Ask exiftool for everything we need in one recursive JSON blob.
  // -n forces numeric output (lat/lon as decimal degrees, signed).
  // -ee enables extraction of embedded metadata (GPMF etc) if present.
  let stdout;
  try {
    stdout = execFileSync('exiftool', [
      '-j', '-n', '-r', '-q',
      '-GPSLatitude', '-GPSLongitude', '-GPSAltitude',
      '-DateTimeOriginal', '-CreateDate', '-GPSDateTime', '-SubSecDateTimeOriginal',
      '-FileType', '-MIMEType', '-Duration', '-ImageWidth', '-ImageHeight',
      '-SourceFile',
      dir,
    ], { maxBuffer: 1024 * 1024 * 256, encoding: 'utf8' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`exiftool not found — install with 'brew install exiftool' (or apt/dnf) then rerun`);
    } else {
      console.error(`exiftool failed: ${e.message}`);
    }
    return [];
  }
  let rows;
  try { rows = JSON.parse(stdout); } catch { return []; }
  const out = [];
  for (const r of rows) {
    const lat = Number(r.GPSLatitude);
    const lon = Number(r.GPSLongitude);
    const ele = Number(r.GPSAltitude);
    const hasGps = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    const timeStr = r.GPSDateTime || r.SubSecDateTimeOriginal || r.DateTimeOriginal || r.CreateDate || null;
    const time = parseExifTime(timeStr, tzH);
    const kind = (r.MIMEType || '').startsWith('video') ? 'video' : 'photo';
    out.push({
      file: r.SourceFile,
      kind,
      type: r.FileType || null,
      lat: hasGps ? lat : null,
      lon: hasGps ? lon : null,
      ele: Number.isFinite(ele) ? ele : null,
      time,
      duration_s: Number.isFinite(Number(r.Duration)) ? Number(r.Duration) : null,
      width: r.ImageWidth ?? null,
      height: r.ImageHeight ?? null,
    });
  }
  return out;
}

// Binary-search the nearest trkpt to a time, return index (or -1 if empty).
function nearestTrkptIndex(points, t) {
  if (!points.length) return -1;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].time - t) < Math.abs(points[lo].time - t)) lo -= 1;
  return lo;
}

// Linear interp lat/lon at time t between the two bracketing trkpts.
function interpolateAt(points, t) {
  if (!points.length) return null;
  if (t <= points[0].time) return { ...points[0], interpolated: false, edge: 'before' };
  if (t >= points[points.length - 1].time) return { ...points[points.length - 1], interpolated: false, edge: 'after' };
  let lo = 0, hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const span = b.time - a.time;
  const f = span > 0 ? (t - a.time) / span : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    ele: a.ele != null && b.ele != null ? a.ele + (b.ele - a.ele) * f : null,
    time: t,
    interpolated: true,
  };
}

// -------- stats --------
function segmentStats(points) {
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
      // stage splitting already removed big gaps, so any dt here is valid sample
      if (dt > 0) {
        const speed = d / dt; // m/s
        if (speed < 134 && speed > maxSpeed) maxSpeed = speed; // <300mph sanity
        if (speed > 0.5) movingSec += dt;
      }
    }
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
    duration_min: firstT != null && lastT != null ? (lastT - firstT) / 60000 : null,
    moving_min: movingSec / 60,
    distance_km: +(distance / 1000).toFixed(3),
    distance_mi: +(distance / 1609.344).toFixed(3),
    max_speed_mph: +(maxSpeed * 2.23694).toFixed(1),
    max_speed_kmh: +(maxSpeed * 3.6).toFixed(1),
    avg_moving_mph: movingSec > 0 ? +((distance / movingSec) * 2.23694).toFixed(1) : null,
    ele_gain_m: Math.round(gain),
    ele_loss_m: Math.round(loss),
    bbox: bboxOf(points),
  };
}

// -------- geojson --------
function toFeature(points, props) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat]),
    },
  };
}

// -------- tz-aware bucket keys --------
function dayKey(time, tzH) {
  return new Date(time + tzH * 3600000).toISOString().slice(0, 10);
}
function hourKey(time, tzH) {
  return new Date(time + tzH * 3600000).toISOString().slice(0, 13).replace('T', '_');
}

// -------- fs walk --------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) out.push(...walk(p));
    else if (extname(name).toLowerCase() === '.gpx') out.push(p);
  }
  return out;
}

// -------- run --------
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtDur(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h ? `${h}h${pad(m)}` : `${m}m`;
}

const files = walk(folder);
if (files.length === 0 && !opts.media) {
  console.error(`no .gpx files under ${folder} (pass --media <dir> if you only have photos/videos)`);
  process.exit(1);
}
console.log(`moto-gpx: ${opts.name}`);
console.log(`  found ${files.length} gpx file${files.length === 1 ? '' : 's'} in ${folder}`);

let all = [];
for (const f of files) {
  const xml = readFileSync(f, 'utf8');
  const pts = parseGpx(xml);
  all.push(...pts);
  console.log(`  · ${basename(f)}  ${pts.length} pts`);
}

const timed = all.filter(p => p.time != null);
const untimed = all.length - timed.length;
if (untimed) console.log(`  (${untimed} untimed points dropped)`);
timed.sort((a, b) => a.time - b.time);

// dedupe identical (time,lat,lon) rows
const seen = new Set();
const deduped = [];
for (const p of timed) {
  const k = p.time + '|' + p.lat.toFixed(6) + '|' + p.lon.toFixed(6);
  if (seen.has(k)) continue;
  seen.add(k);
  deduped.push(p);
}
console.log(`  merged → ${deduped.length} points (${timed.length - deduped.length} dupes removed)`);

const gapMs = opts.breakMin * 60_000;
const rawStages = splitStages(deduped, gapMs);
const stages = rawStages.filter(s => s.length >= opts.minPoints);
console.log(`  split on ${opts.breakMin}min gaps → ${rawStages.length} stages, ${stages.length} kept (min ${opts.minPoints} pts)`);

if (stages.length === 0 && !opts.media) {
  console.error('nothing to write — try lowering --min-points or --break');
  process.exit(1);
}

// ensure output dirs
mkdirSync(opts.out, { recursive: true });

// per-stage stats + optional simplification for writing
const perStage = stages.map((pts, i) => {
  const stats = segmentStats(pts);
  const simplified = opts.simplify > 0 ? simplifyPoints(pts, opts.simplify) : pts;
  return { i, pts, simplified, stats };
});

// all.geojson
{
  const fc = {
    type: 'FeatureCollection',
    properties: { trip: opts.name },
    features: perStage.map(({ i, simplified, stats }) =>
      toFeature(simplified, { stage: i, trip: opts.name, ...stats })),
  };
  writeFileSync(join(opts.out, 'all.geojson'), JSON.stringify(fc));
}

// per-stage files
if (opts.split === 'stage' || opts.split === 'all') {
  mkdirSync(join(opts.out, 'stages'), { recursive: true });
  for (const { i, simplified, stats } of perStage) {
    const fc = {
      type: 'FeatureCollection',
      features: [toFeature(simplified, { stage: i, trip: opts.name, ...stats })],
    };
    writeFileSync(join(opts.out, 'stages', `stage-${pad(i, 2)}.geojson`), JSON.stringify(fc));
  }
}

// per-day files
let dayCount = 0;
if (opts.split === 'day' || opts.split === 'all') {
  const byDay = new Map();
  for (const { i, pts, simplified, stats } of perStage) {
    const firstT = pts.find(p => p.time != null)?.time;
    if (firstT == null) continue;
    const key = dayKey(firstT, opts.tz);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ i, simplified, stats });
  }
  mkdirSync(join(opts.out, 'days'), { recursive: true });
  for (const [day, items] of byDay) {
    const fc = {
      type: 'FeatureCollection',
      properties: { day, trip: opts.name },
      features: items.map(({ i, simplified, stats }) =>
        toFeature(simplified, { stage: i, day, trip: opts.name, ...stats })),
    };
    writeFileSync(join(opts.out, 'days', `${day}.geojson`), JSON.stringify(fc));
    dayCount++;
  }
}

// per-hour files — built from raw points, not stages, so hour-crossing is clean
let hourCount = 0;
if (opts.split === 'hour' || opts.split === 'all') {
  const byHour = new Map();
  for (const p of deduped) {
    const key = hourKey(p.time, opts.tz);
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(p);
  }
  mkdirSync(join(opts.out, 'hours'), { recursive: true });
  for (const [hour, pts] of byHour) {
    if (pts.length < opts.minPoints) continue;
    const simp = opts.simplify > 0 ? simplifyPoints(pts, opts.simplify) : pts;
    const stats = segmentStats(pts);
    const fc = {
      type: 'FeatureCollection',
      properties: { hour, trip: opts.name },
      features: [toFeature(simp, { hour, trip: opts.name, ...stats })],
    };
    writeFileSync(join(opts.out, 'hours', `${hour}.geojson`), JSON.stringify(fc));
    hourCount++;
  }
}

// -------- media ingestion --------
let mediaFeatures = [];
let mediaCounts = { total: 0, with_gps: 0, interpolated: 0, unlocated: 0, photos: 0, videos: 0 };
if (opts.media) {
  console.log(`  exiftool scan: ${opts.media}`);
  const items = ingestMedia(opts.media, opts.mediaTz);
  console.log(`    ${items.length} media file${items.length === 1 ? '' : 's'}`);
  // Build a bracket of which stage a given time falls into (in-stage or nearest).
  const stageRanges = perStage.map(({ i, pts }) => {
    const first = pts.find(p => p.time != null)?.time ?? null;
    const last = [...pts].reverse().find(p => p.time != null)?.time ?? null;
    return { i, first, last };
  });
  function stageForTime(t) {
    if (t == null) return null;
    // in-range first
    for (const r of stageRanges) {
      if (r.first != null && r.last != null && t >= r.first && t <= r.last) return r.i;
    }
    // else nearest by edge
    let best = null, bestGap = Infinity;
    for (const r of stageRanges) {
      if (r.first == null || r.last == null) continue;
      const gap = t < r.first ? r.first - t : t > r.last ? t - r.last : 0;
      if (gap < bestGap) { bestGap = gap; best = r.i; }
    }
    return best;
  }

  for (const m of items) {
    mediaCounts.total++;
    if (m.kind === 'video') mediaCounts.videos++; else mediaCounts.photos++;

    let lat = m.lat, lon = m.lon, ele = m.ele;
    let interpolated = false;

    // Interpolate location from track if we have a time but no GPS.
    if ((lat == null || lon == null) && m.time != null && deduped.length) {
      const pos = interpolateAt(deduped, m.time);
      if (pos && (pos.edge == null || !pos.edge)) {
        lat = pos.lat; lon = pos.lon; ele = pos.ele ?? null;
        interpolated = true;
      }
    }

    if (lat == null || lon == null) {
      mediaCounts.unlocated++;
      continue;
    }
    if (interpolated) mediaCounts.interpolated++; else mediaCounts.with_gps++;

    const stageIdx = stageForTime(m.time);
    let matchOffsetSec = null;
    if (m.time != null && deduped.length) {
      const ni = nearestTrkptIndex(deduped, m.time);
      if (ni >= 0) matchOffsetSec = Math.round((m.time - deduped[ni].time) / 1000);
    }

    const day = m.time != null ? dayKey(m.time, opts.tz) : null;
    const relFile = (() => { try { return relative(opts.media, m.file); } catch { return m.file; } })();

    mediaFeatures.push({
      type: 'Feature',
      properties: {
        file: relFile,
        abs_path: m.file,
        kind: m.kind,
        type: m.type,
        time_iso: m.time != null ? new Date(m.time).toISOString() : null,
        day,
        stage: stageIdx,
        interpolated,
        match_offset_sec: matchOffsetSec,
        duration_s: m.duration_s,
        width: m.width,
        height: m.height,
        trip: opts.name,
      },
      geometry: {
        type: 'Point',
        coordinates: ele != null ? [lon, lat, ele] : [lon, lat],
      },
    });
  }

  const mediaFc = {
    type: 'FeatureCollection',
    properties: { trip: opts.name, count: mediaFeatures.length },
    features: mediaFeatures,
  };
  writeFileSync(join(opts.out, 'media.geojson'), JSON.stringify(mediaFc));
  console.log(`    geotagged: ${mediaCounts.with_gps} direct · ${mediaCounts.interpolated} interpolated · ${mediaCounts.unlocated} unlocated`);
}

// stats.json
const totals = perStage.reduce(
  (a, { stats }) => {
    a.distance_km += stats.distance_km;
    a.moving_min += stats.moving_min;
    a.duration_min += stats.duration_min || 0;
    a.ele_gain_m += stats.ele_gain_m;
    a.ele_loss_m += stats.ele_loss_m;
    if (stats.max_speed_mph > a.max_speed_mph) a.max_speed_mph = stats.max_speed_mph;
    return a;
  },
  { distance_km: 0, moving_min: 0, duration_min: 0, ele_gain_m: 0, ele_loss_m: 0, max_speed_mph: 0 }
);

const summary = {
  trip: opts.name,
  generated: new Date().toISOString(),
  options: opts,
  source_files: files.length,
  total_points: deduped.length,
  stages: perStage.length,
  bbox: bboxOf(deduped),
  totals: {
    distance_km: +totals.distance_km.toFixed(2),
    distance_mi: +(totals.distance_km * 0.621371).toFixed(2),
    duration_hours: +(totals.duration_min / 60).toFixed(2),
    moving_hours: +(totals.moving_min / 60).toFixed(2),
    ele_gain_m: totals.ele_gain_m,
    ele_loss_m: totals.ele_loss_m,
    max_speed_mph: totals.max_speed_mph,
    avg_moving_mph: totals.moving_min > 0
      ? +((totals.distance_km * 1000 / (totals.moving_min * 60)) * 2.23694).toFixed(1)
      : null,
  },
  stage_breakdown: perStage.map(({ i, stats }) => ({ stage: i, ...stats })),
  media: opts.media ? mediaCounts : null,
};
writeFileSync(join(opts.out, 'stats.json'), JSON.stringify(summary, null, 2));

// -------- console summary --------
console.log('');
console.log(`  ${opts.name}`);
console.log(`  ${summary.totals.distance_mi} mi / ${summary.totals.distance_km} km`);
console.log(`  moving ${fmtDur(totals.moving_min)}  /  wall ${fmtDur(totals.duration_min)}`);
console.log(`  max ${summary.totals.max_speed_mph} mph  · avg moving ${summary.totals.avg_moving_mph ?? '—'} mph`);
console.log(`  +${summary.totals.ele_gain_m}m / -${summary.totals.ele_loss_m}m`);
console.log('');
console.log(`  wrote to ${opts.out}`);
console.log(`    all.geojson`);
if (opts.split === 'day' || opts.split === 'all') console.log(`    days/ (${dayCount})`);
if (opts.split === 'hour' || opts.split === 'all') console.log(`    hours/ (${hourCount})`);
if (opts.split === 'stage' || opts.split === 'all') console.log(`    stages/ (${perStage.length})`);
if (opts.media) console.log(`    media.geojson (${mediaFeatures.length} pts: ${mediaCounts.photos} photo, ${mediaCounts.videos} video)`);
console.log(`    stats.json`);
