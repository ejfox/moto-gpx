// Media (photos/videos) ingestion via exiftool + time/space matching helpers.

import { execFileSync } from 'node:child_process';

// Parse an EXIF-ish timestamp. Formats seen:
//   "2025:06:01 14:23:45"
//   "2025:06:01 14:23:45-04:00"
//   "2025:06:01 14:23:45.123Z"
// tzFallbackH is applied only when no offset is embedded.
export function parseExifTime(s, tzFallbackH) {
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

export function ingestMedia(dir, tzH) {
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

export function nearestTrkptIndex(points, t) {
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

export function interpolateAt(points, t) {
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
