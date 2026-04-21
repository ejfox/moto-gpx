/**
 * media.js — Photo/video metadata ingestion and time-based track matching.
 *
 * Role in the pipeline: bridge between a directory of media files and the
 * parsed GPX track. `ingestMedia` shells out to `exiftool` to harvest EXIF /
 * QuickTime tags; `parseExifTime` converts exiftool's timestamps to
 * ms-since-epoch; `nearestTrkptIndex` and `interpolateAt` then locate each
 * media item on the track. Consumed by `moto-gpx.js` (ingestion pipeline)
 * and by `src/enrich/mastodon.js` (toot geolocation).
 *
 * Contract:
 *   - `parseExifTime`, `nearestTrkptIndex`, and `interpolateAt` are pure.
 *   - `ingestMedia` is the only I/O in this module: it spawns `exiftool`
 *     and reads its stdout. On failure (exiftool missing or non-zero exit)
 *     it logs a diagnostic and returns `[]` — never throws.
 *   - Trackpoint inputs to `nearestTrkptIndex` / `interpolateAt` MUST be
 *     sorted ascending by `time` and all have finite `time` values.
 *
 * External dependencies:
 *   - `exiftool` binary on PATH (Phil Harvey's ExifTool). Install via
 *     `brew install exiftool` / `apt install libimage-exiftool-perl`.
 *   - Node's `child_process.execFileSync` (stdlib).
 *
 * Exports:
 *   parseExifTime(s, tzFallbackH)   — EXIF timestamp → ms since epoch
 *   ingestMedia(dir, tzH)           — scan directory, return MediaItem[]
 *   nearestTrkptIndex(points, t)    — binary-search closest-by-time index
 *   interpolateAt(points, t)        — linear interpolate a virtual trackpoint
 */

import { execFileSync } from 'node:child_process';

/**
 * @typedef {Object} MediaItem
 * @property {string} file        - absolute or input-relative path from exiftool
 * @property {'photo'|'video'} kind
 * @property {string|null} type   - FileType (e.g. 'JPEG', 'MP4')
 * @property {number|null} lat    - GPS latitude if present, else null
 * @property {number|null} lon    - GPS longitude if present, else null
 * @property {number|null} ele    - GPSAltitude meters, else null
 * @property {number|null} time   - capture time, ms since epoch, or null
 * @property {number|null} duration_s
 * @property {number|null} width
 * @property {number|null} height
 */

// ═══ constants ═══

// exiftool's stdout JSON can be large for hundreds of hi-res files. 256 MiB
// is generous; the alternative is streaming stdout, which would change the
// function's shape and its failure-mode semantics.
const EXIFTOOL_MAXBUFFER = 1024 * 1024 * 256;

// Tags exiftool extracts. Kept here so the list is visible without scrolling
// through the command array. `-j` = JSON, `-n` = numeric (no deg/min/sec
// formatting), `-r` = recurse into subdirs, `-q` = quiet (suppress progress).
const EXIFTOOL_FLAGS = ['-j', '-n', '-r', '-q'];
const EXIFTOOL_TAGS = [
  '-GPSLatitude', '-GPSLongitude', '-GPSAltitude',
  '-DateTimeOriginal', '-CreateDate', '-GPSDateTime', '-SubSecDateTimeOriginal',
  '-FileType', '-MIMEType', '-Duration', '-ImageWidth', '-ImageHeight',
  '-SourceFile',
];

// ═══ time parsing ═══

/**
 * Parse an EXIF-ish timestamp string into ms-since-epoch.
 *
 * Accepted shapes (all seen in the wild across camera/phone/action-cam EXIF):
 *   "2025:06:01 14:23:45"
 *   "2025:06:01 14:23:45-04:00"
 *   "2025:06:01 14:23:45.123Z"
 *   "2025:06:01T14:23:45+0400"     (compact offset)
 *
 * If the string carries an explicit offset (`Z` or `±HH:MM` / `±HHMM`), that
 * offset wins. Otherwise `tzFallbackH` — the ride's assumed local UTC offset —
 * is applied, which is how photos from cameras that don't record a TZ still
 * line up with a timezone-aware GPS track.
 *
 * @param {string|null|undefined} s
 * @param {number} tzFallbackH - UTC offset in hours to apply when none is embedded
 * @returns {number|null} ms since epoch, or null if the string is unparseable
 * @example
 *   parseExifTime('2025:06:01 14:23:45', -4); // ms for 14:23:45 at UTC-4
 */
export function parseExifTime(s, tzFallbackH) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se, tz] = m;
  const base = `${Y}-${Mo}-${D}T${h}:${mi}:${se}`;
  if (tz) {
    // Normalize "+0400" → "+04:00" for Date.parse's ISO-8601 dialect.
    const norm = tz === 'Z' ? 'Z' : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
    const t = Date.parse(base + norm);
    return Number.isFinite(t) ? t : null;
  }
  // Build a synthetic offset suffix from tzFallbackH. Handles fractional
  // offsets (e.g. India = +05:30, Nepal = +05:45) by splitting into hours
  // and minute-thirds. Sign is captured separately so the padStart math
  // operates on the absolute magnitude.
  const sign = tzFallbackH >= 0 ? '+' : '-';
  const abs = Math.abs(tzFallbackH);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String(Math.round((abs % 1) * 60)).padStart(2, '0');
  const t = Date.parse(`${base}${sign}${hh}:${mm}`);
  return Number.isFinite(t) ? t : null;
}

// ═══ exiftool ingest ═══

/**
 * Scan a directory (recursively) for media files and return normalized records.
 *
 * Shells to `exiftool` once for the whole directory — much faster than one
 * call per file. The function is defensive: if exiftool isn't installed,
 * fails to run, or returns unparseable JSON, we log a hint and return `[]`
 * so the rest of the pipeline still completes. GPS coordinates exactly at
 * `(0, 0)` (exiftool's sentinel for "no GPS fix") are dropped to null.
 *
 * @param {string} dir - directory to scan (recursed)
 * @param {number} tzH - UTC offset in hours, used as fallback for any EXIF
 *   timestamps that lack an embedded zone
 * @returns {MediaItem[]} one record per file exiftool recognized; empty on error
 * @example
 *   const media = ingestMedia('/Users/ej/rides/2025-06-01', -4);
 */
export function ingestMedia(dir, tzH) {
  let stdout;
  try {
    stdout = execFileSync('exiftool', [
      ...EXIFTOOL_FLAGS,
      ...EXIFTOOL_TAGS,
      dir,
    ], { maxBuffer: EXIFTOOL_MAXBUFFER, encoding: 'utf8' });
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
    // (0, 0) is exiftool's "no GPS fix" sentinel, not a real location.
    const hasGps = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
    // Preference order: GPSDateTime (most authoritative, UTC) → subsec
    // original → DateTimeOriginal → CreateDate. Picking the best available
    // minimizes drift between the photo and the trackpoint we match it to.
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

// ═══ track matching ═══

/**
 * Binary-search the index of the trackpoint whose time is closest to `t`.
 *
 * Assumes `points` is sorted ascending by `.time` and every point has a
 * finite `.time` (that's the invariant for the time-indexed track the
 * orchestrator hands to matching code). Returns `-1` only when `points` is
 * empty — otherwise always returns a valid index into the array.
 *
 * @param {{time: number}[]} points
 * @param {number} t - target time in ms since epoch
 * @returns {number} index in points, or -1 if empty
 */
export function nearestTrkptIndex(points, t) {
  if (!points.length) return -1;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  // Nudge back one if the predecessor is strictly closer in time.
  if (lo > 0 && Math.abs(points[lo - 1].time - t) < Math.abs(points[lo].time - t)) lo -= 1;
  return lo;
}

/**
 * Interpolate a virtual trackpoint at an arbitrary time `t`.
 *
 * Linearly interpolates lat, lon, and ele between the two bracketing
 * trackpoints. When `t` falls outside the track's time range, returns the
 * clamped endpoint tagged with `edge: 'before' | 'after'` and
 * `interpolated: false`. For times inside the range, returns a fresh object
 * with `interpolated: true` and no `edge` key. Returns `null` only for an
 * empty input.
 *
 * @param {{lat: number, lon: number, ele: number|null, time: number}[]} points
 * @param {number} t - query time in ms since epoch
 * @returns {({lat: number, lon: number, ele: number|null, time: number,
 *            interpolated: boolean, edge?: 'before'|'after'})|null}
 * @example
 *   const virt = interpolateAt(trackpoints, photo.time);
 *   // → { lat, lon, ele, time: photo.time, interpolated: true }
 */
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
