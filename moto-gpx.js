#!/usr/bin/env node
// moto-gpx — dump a folder of GPX, get dope QGIS-ready GeoJSON.
// Zero runtime deps. Node 18+. Optional: exiftool (for --media), GDAL (for --dem).

import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, basename, extname, resolve, relative } from 'node:path';

import {
  parseGpx, haversine, bboxOf, simplifyPoints, splitStages,
  segmentStats, toLineFeature, dayKey, hourKey,
} from './src/gpx.js';
import { ingestMedia, parseExifTime, interpolateAt, nearestTrkptIndex } from './src/media.js';
import {
  detectStops, speedBinSegments, startEndMarkers, mergedDayLines,
} from './src/layers.js';
import { fetchDEM } from './src/dem.js';
import { fetchWeatherForStages } from './src/enrich/weather.js';
import { fetchOSM } from './src/enrich/osm.js';
import { fetchOSRMRoutes } from './src/enrich/routes.js';
import { computeCrossings } from './src/enrich/crossings.js';
import { attachSunPosition } from './src/enrich/sun.js';
import { fetchMastodonPosts } from './src/enrich/mastodon.js';
import { writeStarterStyles } from './src/qml.js';
import { computeSuperlatives, printSuperlatives } from './src/superlatives.js';
import { writeSvgPreviews } from './src/svg.js';

// -------- args --------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  console.log(`moto-gpx <folder> [options]

Recursively reads GPX files, merges & sorts by time, splits on break gaps,
emits layered GeoJSON ready for QGIS hand-cartography.

Core:
  --out <dir>          Output directory (default: ./moto-out)
  --split <mode>       day | hour | stage | all  (default: all)
  --break <minutes>    Gap threshold to start a new stage (default: 20)
  --min-points <n>     Drop stages with fewer points (default: 10)
  --simplify <meters>  Douglas-Peucker tolerance, 0 = off (default: 0)
  --tz <offset>        Hours from UTC for day/hour bucketing (default: local)
  --name <string>      Trip name (default: folder name)

QGIS layer add-ons (all default ON; pass --no-<name> to skip):
  --stops              Rest stops and overnights as Point features
  --speedbins          Line segments binned by speed bucket
  --markers            Start/end Point markers per stage and per day
  --days-merged        Single LineString per day (one unbroken line)
  --styles             Write starter .qml style files

Media:
  --media <dir>        Ingest JPG/HEIC/MP4/MOV via exiftool
  --media-tz <offset>  Override tz for naive EXIF timestamps (default: --tz)

DEM (needs GDAL: brew install gdal):
  --dem                Fetch AWS Terrain Tiles for the trip bbox, build VRT
  --dem-buffer <pct>   Bbox padding percent (default: 20)
  --dem-hillshade      Also pre-render hillshade GeoTIFF (default: on with --dem)
  --dem-contour <m>    Emit contour lines every N meters (default: 0 = off)

Enrichments (opt-in; require network):
  --enrich <list>      Comma list: weather, osm, routes, crossings, sun, all
                       e.g. --enrich weather,osm,sun
  --mastodon <handle>  Fetch your public toots during the ride and place each
                       one on the map at the GPS position you were at when
                       you posted. Handle: @user@instance.social (or full URL)

Superlatives (GPS-derived fun stats, on by default):
  --no-superlatives    Skip the post-run banner

SVG previews (on by default):
  --no-svg             Skip writing preview-map.svg + preview-elevation.svg

Examples:
  moto-gpx ~/trips/big-sur --media ~/trips/big-sur --out ./bs-out
  moto-gpx ./trip --dem --enrich weather,osm,sun
  moto-gpx ./trip --enrich all --dem --dem-contour 100 --simplify 2
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
  stops: true,
  speedbins: true,
  markers: true,
  daysMerged: true,
  styles: true,
  dem: false,
  demBuffer: 20,
  demHillshade: true,
  demContour: 0,
  enrich: new Set(),
  superlatives: true,
  svg: true,
  mastodon: null,
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
  else if (a === '--stops') opts.stops = true;
  else if (a === '--no-stops') opts.stops = false;
  else if (a === '--speedbins') opts.speedbins = true;
  else if (a === '--no-speedbins') opts.speedbins = false;
  else if (a === '--markers') opts.markers = true;
  else if (a === '--no-markers') opts.markers = false;
  else if (a === '--days-merged') opts.daysMerged = true;
  else if (a === '--no-days-merged') opts.daysMerged = false;
  else if (a === '--styles') opts.styles = true;
  else if (a === '--no-styles') opts.styles = false;
  else if (a === '--dem') opts.dem = true;
  else if (a === '--dem-buffer') opts.demBuffer = Number(argv[++i]);
  else if (a === '--dem-hillshade') opts.demHillshade = true;
  else if (a === '--no-dem-hillshade') opts.demHillshade = false;
  else if (a === '--dem-contour') opts.demContour = Number(argv[++i]);
  else if (a === '--superlatives') opts.superlatives = true;
  else if (a === '--no-superlatives') opts.superlatives = false;
  else if (a === '--svg') opts.svg = true;
  else if (a === '--no-svg') opts.svg = false;
  else if (a === '--mastodon') opts.mastodon = argv[++i];
  else if (a === '--enrich') {
    const list = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    if (list.includes('all')) {
      for (const k of ['weather', 'osm', 'routes', 'crossings', 'sun']) opts.enrich.add(k);
    } else {
      for (const k of list) opts.enrich.add(k);
    }
  }
}
if (opts.mediaTz == null) opts.mediaTz = opts.tz;
opts.out = resolve(opts.out);

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

// -------- util --------
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtDur(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min - h * 60);
  return h ? `${h}h${pad(m)}` : `${m}m`;
}
function writeFc(path, features, properties = {}) {
  writeFileSync(path, JSON.stringify({
    type: 'FeatureCollection', properties, features,
  }));
}

// -------- main --------
async function main() {
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

  mkdirSync(opts.out, { recursive: true });

  const perStage = stages.map((pts, i) => {
    const stats = segmentStats(pts);
    const simplified = opts.simplify > 0 ? simplifyPoints(pts, opts.simplify) : pts;
    const day = stats.start_iso ? dayKey(Date.parse(stats.start_iso), opts.tz) : null;
    return { i, pts, simplified, stats, day };
  });

  // all.geojson
  writeFc(
    join(opts.out, 'all.geojson'),
    perStage.map(({ i, simplified, stats, day }) =>
      toLineFeature(simplified, { stage: i, day, trip: opts.name, ...stats })),
    { trip: opts.name },
  );

  // per-stage files
  if (opts.split === 'stage' || opts.split === 'all') {
    mkdirSync(join(opts.out, 'stages'), { recursive: true });
    for (const { i, simplified, stats, day } of perStage) {
      writeFc(
        join(opts.out, 'stages', `stage-${pad(i, 2)}.geojson`),
        [toLineFeature(simplified, { stage: i, day, trip: opts.name, ...stats })],
      );
    }
  }

  // per-day files
  let dayCount = 0;
  if (opts.split === 'day' || opts.split === 'all') {
    const byDay = new Map();
    for (const { i, simplified, stats, day } of perStage) {
      if (day == null) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ i, simplified, stats });
    }
    mkdirSync(join(opts.out, 'days'), { recursive: true });
    for (const [day, items] of byDay) {
      writeFc(
        join(opts.out, 'days', `${day}.geojson`),
        items.map(({ i, simplified, stats }) =>
          toLineFeature(simplified, { stage: i, day, trip: opts.name, ...stats })),
        { day, trip: opts.name },
      );
      dayCount++;
    }
  }

  // per-hour files
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
      writeFc(
        join(opts.out, 'hours', `${hour}.geojson`),
        [toLineFeature(simp, { hour, trip: opts.name, ...stats })],
        { hour, trip: opts.name },
      );
      hourCount++;
    }
  }

  // -------- QGIS-prep layers --------
  let stopsCount = 0, speedbinCount = 0, markerCount = 0, mergedDays = 0;

  if (opts.stops) {
    const stops = detectStops(deduped, gapMs, opts.tz, opts.name);
    if (stops.length) {
      writeFc(join(opts.out, 'stops.geojson'), stops, { trip: opts.name });
      stopsCount = stops.length;
    }
  }

  if (opts.speedbins) {
    const bins = [];
    for (const { i, pts, day } of perStage) bins.push(...speedBinSegments(pts, i, day, opts.name));
    if (bins.length) {
      writeFc(join(opts.out, 'speedbins.geojson'), bins, { trip: opts.name });
      speedbinCount = bins.length;
    }
  }

  if (opts.markers) {
    const markers = startEndMarkers(perStage, opts.tz, opts.name);
    if (markers.length) {
      writeFc(join(opts.out, 'markers.geojson'), markers, { trip: opts.name });
      markerCount = markers.length;
    }
  }

  if (opts.daysMerged) {
    const dayLines = mergedDayLines(deduped, opts.tz, opts.name, opts.simplify);
    if (dayLines.length) {
      mkdirSync(join(opts.out, 'days-merged'), { recursive: true });
      for (const feat of dayLines) {
        writeFc(
          join(opts.out, 'days-merged', `${feat.properties.day}.geojson`),
          [feat],
          { day: feat.properties.day, trip: opts.name },
        );
      }
      mergedDays = dayLines.length;
    }
  }

  // -------- media ingestion --------
  let mediaFeatures = [];
  let mediaCounts = { total: 0, with_gps: 0, interpolated: 0, unlocated: 0, photos: 0, videos: 0 };
  if (opts.media) {
    console.log(`  exiftool scan: ${opts.media}`);
    const items = ingestMedia(opts.media, opts.mediaTz);
    console.log(`    ${items.length} media file${items.length === 1 ? '' : 's'}`);

    const stageRanges = perStage.map(({ i, pts }) => {
      const first = pts.find(p => p.time != null)?.time ?? null;
      const last = [...pts].reverse().find(p => p.time != null)?.time ?? null;
      return { i, first, last };
    });
    function stageForTime(t) {
      if (t == null) return null;
      for (const r of stageRanges) {
        if (r.first != null && r.last != null && t >= r.first && t <= r.last) return r.i;
      }
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

    console.log(`    geotagged: ${mediaCounts.with_gps} direct · ${mediaCounts.interpolated} interpolated · ${mediaCounts.unlocated} unlocated`);
  }

  // -------- enrichments (opt-in, network) --------
  const enrichResults = {};

  if (opts.enrich.has('sun') && mediaFeatures.length) {
    console.log(`  ☼ sun position on ${mediaFeatures.length} media points`);
    attachSunPosition(mediaFeatures);
  }

  if (opts.enrich.has('weather') && perStage.length) {
    console.log(`  ☁ weather: open-meteo per stage`);
    try {
      const wx = await fetchWeatherForStages(perStage, opts.out);
      enrichResults.weather = wx;
    } catch (e) { console.error(`    weather failed: ${e.message}`); }
  }

  if (opts.enrich.has('osm') && deduped.length) {
    console.log(`  ◉ osm: overpass for roads, places, POIs`);
    try {
      const bbox = bboxOf(deduped);
      const osm = await fetchOSM(bbox, deduped, perStage, opts.out, opts.name);
      enrichResults.osm = osm;
    } catch (e) { console.error(`    osm failed: ${e.message}`); }
  }

  if (opts.enrich.has('routes') && perStage.length) {
    console.log(`  ↣ routes: osrm suggested vs actual`);
    try {
      const routes = await fetchOSRMRoutes(perStage, opts.out, opts.name);
      enrichResults.routes = routes;
    } catch (e) { console.error(`    routes failed: ${e.message}`); }
  }

  if (opts.enrich.has('crossings') && deduped.length) {
    console.log(`  ⊢ state crossings`);
    try {
      const xings = computeCrossings(deduped, opts.tz, opts.name);
      if (xings.length) {
        writeFc(join(opts.out, 'crossings.geojson'), xings, { trip: opts.name });
        enrichResults.crossings = xings.length;
      }
    } catch (e) { console.error(`    crossings failed: ${e.message}`); }
  }

  let mastodonResult = null;
  if (opts.mastodon && deduped.length) {
    console.log(`  ✎ mastodon: ${opts.mastodon}`);
    try {
      mastodonResult = await fetchMastodonPosts(opts.mastodon, perStage, deduped, opts.out, opts.name);
      if (mastodonResult) enrichResults.mastodon = { count: mastodonResult.count, account: mastodonResult.account };
    } catch (e) { console.error(`    mastodon failed: ${e.message}`); }
  }

  // -------- DEM --------
  let demInfo = null;
  if (opts.dem) {
    console.log(`  ◬ DEM: AWS Terrain Tiles, buffer ${opts.demBuffer}%`);
    try {
      const bbox = bboxOf(deduped);
      demInfo = await fetchDEM(bbox, join(opts.out, 'dem'), {
        bufferPct: opts.demBuffer,
        hillshade: opts.demHillshade,
        contourMeters: opts.demContour,
      });
    } catch (e) { console.error(`    dem failed: ${e.message}`); }
  }

  // -------- media.geojson --------
  if (opts.media && mediaFeatures.length > 0) {
    writeFc(join(opts.out, 'media.geojson'), mediaFeatures, { trip: opts.name, count: mediaFeatures.length });
  }

  // -------- styles --------
  if (opts.styles) {
    writeStarterStyles(opts.out);
  }

  // -------- stats.json --------
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
    { distance_km: 0, moving_min: 0, duration_min: 0, ele_gain_m: 0, ele_loss_m: 0, max_speed_mph: 0 },
  );

  const computedTotals = {
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
  };

  const superlatives = opts.superlatives
    ? computeSuperlatives(deduped, perStage, opts, computedTotals)
    : null;

  let svgOut = null;
  if (opts.svg) {
    svgOut = writeSvgPreviews(opts.out, perStage, deduped, opts, superlatives);
  }

  const summary = {
    trip: opts.name,
    generated: new Date().toISOString(),
    options: { ...opts, enrich: [...opts.enrich] },
    source_files: files.length,
    total_points: deduped.length,
    stages: perStage.length,
    bbox: bboxOf(deduped),
    totals: computedTotals,
    stage_breakdown: perStage.map(({ i, stats, day }) => ({ stage: i, day, ...stats })),
    media: opts.media ? mediaCounts : null,
    enrichments: Object.keys(enrichResults).length ? enrichResults : null,
    dem: demInfo,
    superlatives,
  };
  writeFileSync(join(opts.out, 'stats.json'), JSON.stringify(summary, null, 2));

  // -------- console --------
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
  if (stopsCount) console.log(`    stops.geojson (${stopsCount})`);
  if (speedbinCount) console.log(`    speedbins.geojson (${speedbinCount})`);
  if (markerCount) console.log(`    markers.geojson (${markerCount})`);
  if (mergedDays) console.log(`    days-merged/ (${mergedDays})`);
  if (opts.media && mediaFeatures.length > 0) console.log(`    media.geojson (${mediaFeatures.length} pts: ${mediaCounts.photos} photo, ${mediaCounts.videos} video)`);
  else if (opts.media) console.log(`    (no locatable media in ${opts.media})`);
  if (enrichResults.crossings) console.log(`    crossings.geojson (${enrichResults.crossings})`);
  if (enrichResults.osm) console.log(`    osm layers (${Object.keys(enrichResults.osm).join(', ')})`);
  if (enrichResults.routes) console.log(`    optimal_routes.geojson (${enrichResults.routes.count ?? '?'} stages routed)`);
  if (enrichResults.weather) console.log(`    weather_timeline.json (${enrichResults.weather.stages ?? '?'} stages)`);
  if (enrichResults.mastodon) console.log(`    toots.geojson (${enrichResults.mastodon.count} posts from ${enrichResults.mastodon.account})`);
  if (demInfo) {
    const parts = [`${demInfo.tiles ?? '?'} tiles`];
    if (demInfo.vrt) parts.push('vrt');
    if (demInfo.hillshade) parts.push('hillshade');
    if (demInfo.contours) parts.push('contours');
    console.log(`    dem/ (${parts.join(', ')})`);
  }
  if (opts.styles) console.log(`    styles/ (.qml QGIS styles)`);
  console.log(`    stats.json`);
  if (svgOut?.map) console.log(`    preview-map.svg`);
  if (svgOut?.elevation) console.log(`    preview-elevation.svg`);
  if (svgOut?.speed) console.log(`    preview-speed.svg`);

  if (superlatives) printSuperlatives(superlatives, opts);
}

main().catch(e => { console.error(e); process.exit(1); });
