/**
 * dem.js — fetch elevation tiles for the trip's bbox and produce QGIS-ready rasters.
 *
 * Role in the pipeline: optional add-on invoked when the caller passes --dem.
 * Consumes the track's bbox, downloads the 1°×1° Skadi tiles that cover it,
 * stitches them into a GDAL VRT, and optionally derives a hillshade GeoTIFF
 * and a contour-line GeoJSON. Outputs are dropped into outDir for QGIS to
 * load alongside the track layers.
 *
 * Contract: fail-soft everywhere. A missing tile (ocean / gap) or unreachable
 * S3 is logged and skipped — the run continues. If GDAL is not on PATH we
 * return the tile manifest without the derived products. Throws only on
 * programmer error (bad args). The returned object always has the same
 * shape so callers can blindly key into it.
 *
 * External:
 *   - AWS Terrain Tiles (Skadi/HGT format). Open data, no auth.
 *   - GDAL CLI: gdalbuildvrt, gdaldem, gdal_contour (optional — skip if absent).
 *
 * Exports:
 *   - fetchDEM(bbox, outDir, opts) — the only entry point.
 */

// ═══ AWS Terrain Tiles (Skadi) dataset ═══
//
// Endpoint: https://s3.amazonaws.com/elevation-tiles-prod/skadi/<BAND>/<TILE>.hgt.gz
// Open dataset hosted by Mapzen / AWS Open Data. No API key, no auth, no
// rate-limit that we've ever hit (S3 direct).
//
// Tile naming is the classic SRTM Skadi scheme:
//   <lat hemisphere><|lat|2-digit><lon hemisphere><|lon|3-digit>
//   e.g. N41W074 covers 41°N..42°N, 74°W..73°W (1° × 1° square).
//   Each tile is a gzipped SRTMHGT raster at ~30 m (1 arc-second) resolution
//   globally, 3 arc-second in a few gaps. 3601×3601 int16 samples per tile.
//
// Band directory is the lat prefix (e.g. N41) — so the full URL for N41W074
// becomes .../skadi/N41/N41W074.hgt.gz.
//
// Expected failure modes:
//   - HTTP 403 / 404 => tile is entirely ocean or otherwise absent. Expected.
//     We log and skip; the VRT happily builds from the remaining tiles.
//   - Network error => also skipped; user can rerun and the on-disk cache
//     (under tiles/) lets us resume without re-downloading.
//
// We assemble with `gdalbuildvrt` rather than `gdal_merge`/`gdalwarp` because
// a VRT is a zero-copy XML pointer: no pixels get rewritten, mosaic is
// seamless on the fly, and edits to the source tiles propagate automatically.

import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

// ═══ constants ═══
const AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
const CONCURRENCY = 6; // polite parallelism for S3; empirically no throttling.

// ═══ tile naming ═══
// Skadi encodes the SW corner of the 1° tile. floor(lat)/floor(lon) gives
// that corner even for negative coordinates (e.g. lat = -0.2 → floor = -1
// → 'S01'). Zero-padding: 2 digits for lat (max 90), 3 for lon (max 180).
function latStr(lat) {
  const f = Math.floor(lat);
  const h = f >= 0 ? 'N' : 'S';
  const n = Math.abs(f);
  return h + String(n).padStart(2, '0');
}
function lonStr(lon) {
  const f = Math.floor(lon);
  const h = f >= 0 ? 'E' : 'W';
  const n = Math.abs(f);
  return h + String(n).padStart(3, '0');
}
function tileName(lat, lon) { return latStr(lat) + lonStr(lon); }

// ═══ bbox math ═══
// Pad the bbox outwards by `pct` percent of its span so the resulting raster
// extends a bit past the track — nicer-looking hillshade around the edges,
// and contour lines that don't stop right at the last waypoint.
function padBbox(bbox, pct) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const dLon = (maxLon - minLon) * (pct / 100);
  const dLat = (maxLat - minLat) * (pct / 100);
  return [minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat];
}

function tilesForBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lat0 = Math.floor(minLat);
  const lat1 = Math.floor(maxLat);
  const lon0 = Math.floor(minLon);
  const lon1 = Math.floor(maxLon);
  const tiles = [];
  for (let la = lat0; la <= lat1; la++) {
    for (let lo = lon0; lo <= lon1; lo++) {
      tiles.push({ lat: la, lon: lo, name: tileName(la, lo) });
    }
  }
  return tiles;
}

// ═══ concurrency semaphore ═══
// Tiny promise-based limiter: at most `max` fn() are in-flight at once.
// Preserves the order results are resolved in, not the order jobs started.
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(
      v => { active--; resolve(v); next(); },
      e => { active--; reject(e); next(); },
    );
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

// ═══ pretty size ═══
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ═══ single tile fetch ═══
// Downloads one .hgt.gz from S3, gunzips to disk. Cached by local file name;
// a rerun re-uses any existing .hgt with non-zero size. Returns null on any
// failure mode (network, 403/404, corrupt gzip) — callers filter those out.
async function fetchTile(tile, tilesDir) {
  const band = latStr(tile.lat);               // e.g. 'N41'
  const url = `${AWS_BASE}/${band}/${tile.name}.hgt.gz`;
  const localPath = join(tilesDir, `${tile.name}.hgt`);

  // cache hit?
  if (existsSync(localPath)) {
    try {
      const s = statSync(localPath);
      if (s.size > 0) {
        console.log(`    · ${tile.name} ... cached (${fmtBytes(s.size)})`);
        return { tile, path: localPath, bytes: s.size, cached: true };
      }
    } catch { /* fallthrough to refetch */ }
  }

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.log(`    · ${tile.name} ... network error (${e.message}) — skipped`);
    return null;
  }

  // 403 and 404 are the expected "this tile doesn't exist" responses from S3;
  // both typically mean ocean or an SRTM gap. Not an error condition.
  if (res.status === 403 || res.status === 404) {
    console.log(`    · ${tile.name} ... ${res.status} (ocean/missing) — skipped`);
    return null;
  }
  if (!res.ok) {
    console.log(`    · ${tile.name} ... HTTP ${res.status} — skipped`);
    return null;
  }

  const gzBuf = Buffer.from(await res.arrayBuffer());
  let hgtBuf;
  try {
    hgtBuf = gunzipSync(gzBuf);
  } catch (e) {
    console.log(`    · ${tile.name} ... gunzip failed (${e.message}) — skipped`);
    return null;
  }

  writeFileSync(localPath, hgtBuf);
  console.log(`    · ${tile.name} ... ${fmtBytes(hgtBuf.length)}`);
  return { tile, path: localPath, bytes: hgtBuf.length, cached: false };
}

// ═══ GDAL runners ═══
// Wraps execFileSync. `{ ok: true }` on success; `{ ok: false, missing: true }`
// if the binary isn't on PATH so the main flow can print a helpful install hint
// instead of a raw stack trace.
function runGdal(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false, err: e };
  }
}

// ═══ public API ═══

/**
 * Fetch a DEM mosaic (and optional derived rasters) covering a bbox.
 *
 * Workflow:
 *   1. Pad the bbox outward by `bufferPct` (default 20%).
 *   2. Enumerate every 1° Skadi tile that intersects the padded bbox.
 *   3. Download each tile in parallel (cap `CONCURRENCY`), using the local
 *      cache under `<outDir>/tiles/` when present.
 *   4. `gdalbuildvrt` the tiles into `<outDir>/trip.vrt`. The VRT is a zero-
 *      copy virtual mosaic — QGIS reads it as one seamless raster.
 *   5. If `hillshade`, run `gdaldem hillshade` (z=1.5, s=111120 for degrees).
 *   6. If `contourMeters > 0`, run `gdal_contour -i <m>` to produce a
 *      polylines GeoJSON of contour lines every `contourMeters` meters.
 *
 * Fail-soft: any tile that 403/404s is skipped; GDAL missing degrades
 * gracefully to "just the raw tiles"; an empty / invalid bbox returns null.
 *
 * @param {[number,number,number,number]} bbox  [minLon, minLat, maxLon, maxLat]
 * @param {string} outDir  absolute path; will be created if missing
 * @param {object} [opts]
 * @param {number} [opts.bufferPct=20]    % of bbox span to pad outwards
 * @param {boolean} [opts.hillshade=false] produce trip-hillshade.tif
 * @param {number} [opts.contourMeters=0]  >0 => produce trip-contours.geojson
 * @returns {Promise<{bbox:number[], padded_bbox:number[], tiles:number, vrt:string|null, tile_list:string[], hillshade?:string, contours?:string}|null>}
 *   null only when bbox is invalid; otherwise always the manifest (possibly
 *   with `vrt: null` when GDAL is missing).
 */
export async function fetchDEM(bbox, outDir, opts = {}) {
  if (!bbox || bbox.length !== 4 ||
      !Number.isFinite(bbox[0]) || !Number.isFinite(bbox[1]) ||
      !Number.isFinite(bbox[2]) || !Number.isFinite(bbox[3]) ||
      bbox[0] === bbox[2] || bbox[1] === bbox[3]) {
    console.log('    ! empty or invalid bbox — DEM skipped');
    return null;
  }

  const bufferPct = opts.bufferPct ?? 20;
  const wantHillshade = !!opts.hillshade;
  const contourMeters = Number(opts.contourMeters) || 0;

  const padded = padBbox(bbox, bufferPct);
  const tiles = tilesForBbox(padded);
  console.log(`    padded bbox: [${padded.map(v => v.toFixed(3)).join(', ')}]`);
  console.log(`    ${tiles.length} tile${tiles.length === 1 ? '' : 's'} to fetch (concurrency ${CONCURRENCY})`);

  mkdirSync(outDir, { recursive: true });
  const tilesDir = join(outDir, 'tiles');
  mkdirSync(tilesDir, { recursive: true });

  // parallel fetch with semaphore
  const limit = makeLimiter(CONCURRENCY);
  const results = await Promise.all(tiles.map(t => limit(() => fetchTile(t, tilesDir))));
  const ok = results.filter(r => r != null);
  const totalBytes = ok.reduce((a, r) => a + r.bytes, 0);
  const cached = ok.filter(r => r.cached).length;
  const downloaded = ok.length - cached;
  console.log(`    tiles: ${ok.length}/${tiles.length} ok · ${downloaded} downloaded · ${cached} cached · ${fmtBytes(totalBytes)}`);

  const tileList = ok.map(r => r.path);

  if (tileList.length === 0) {
    console.log('    ! no tiles fetched (all missing or failed)');
    return {
      bbox,
      padded_bbox: padded,
      tiles: 0,
      vrt: null,
      tile_list: [],
    };
  }

  // Build the VRT. `gdalbuildvrt` authors an XML file that declares each
  // input tile as a source — no pixel data is written, and the resulting
  // .vrt is tiny. QGIS opens it as one continuous raster.
  const vrtPath = join(outDir, 'trip.vrt');
  const vrtRes = runGdal('gdalbuildvrt', [vrtPath, ...tileList]);
  if (!vrtRes.ok) {
    if (vrtRes.missing) {
      console.log("    ! GDAL not found — install with 'brew install gdal' then rerun --dem");
    } else {
      console.log(`    ! gdalbuildvrt failed: ${vrtRes.err?.message || 'unknown'}`);
    }
    return {
      bbox,
      padded_bbox: padded,
      tiles: tileList.length,
      vrt: null,
      tile_list: tileList,
    };
  }
  console.log(`    vrt: ${vrtPath}`);

  const info = {
    bbox,
    padded_bbox: padded,
    tiles: tileList.length,
    vrt: vrtPath,
    tile_list: tileList,
  };

  // hillshade
  //   -compute_edges      smooth values at the mosaic seams
  //   -z 1.5              exaggerate vertical relief 1.5× for legibility
  //   -s 111120           lat/lon scale (meters per degree ~ 111120); this
  //                       matches the Skadi data's EPSG:4326 coords so slopes
  //                       come out correctly without having to reproject.
  if (wantHillshade) {
    const hsPath = join(outDir, 'trip-hillshade.tif');
    const hsRes = runGdal('gdaldem', [
      'hillshade', '-compute_edges', '-z', '1.5', '-s', '111120',
      vrtPath, hsPath,
    ]);
    if (hsRes.ok) {
      console.log(`    hillshade: ${hsPath}`);
      info.hillshade = hsPath;
    } else {
      console.log(`    ! hillshade failed${hsRes.missing ? ' (gdaldem missing)' : `: ${hsRes.err?.message || ''}`}`);
    }
  }

  // contours
  //   -a elevation_m          attribute name on each line
  //   -i <N>                  interval in raster units (meters for SRTM)
  //   -f GeoJSON              driver
  if (contourMeters > 0) {
    const cPath = join(outDir, 'trip-contours.geojson');
    const cRes = runGdal('gdal_contour', [
      '-a', 'elevation_m', '-i', String(contourMeters), '-f', 'GeoJSON',
      vrtPath, cPath,
    ]);
    if (cRes.ok) {
      console.log(`    contours: ${cPath} (every ${contourMeters}m)`);
      info.contours = cPath;
    } else {
      console.log(`    ! contours failed${cRes.missing ? ' (gdal_contour missing)' : `: ${cRes.err?.message || ''}`}`);
    }
  }

  return info;
}
