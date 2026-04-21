// DEM subsystem — AWS Terrain Tiles (Skadi / SRTM 30m) → VRT + optional hillshade + contours.
// Zero deps; node:* only. Node 18+ (global fetch).

import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const AWS_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
const CONCURRENCY = 6;

// --- tile naming ---------------------------------------------------------
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

// --- bbox math -----------------------------------------------------------
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

// --- concurrency semaphore ----------------------------------------------
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

// --- pretty size ---------------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// --- single tile fetch ---------------------------------------------------
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

// --- GDAL runners --------------------------------------------------------
function runGdal(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false, err: e };
  }
}

// --- main ----------------------------------------------------------------
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

  // build VRT
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
