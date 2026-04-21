/**
 * svg.js — SVG preview generator: map view, elevation profile, speed profile.
 *
 * Role in the pipeline: runs at the very end of a moto-gpx invocation, after
 * all geojson and enrichment writes. Reads places.geojson / toots.geojson off
 * disk if present, renders six SVGs total (light + dark per preview), writes
 * them into the output folder, and returns their relative paths so the
 * orchestrator can log them.
 *
 * Contract: fail-soft. Renders what it can from the data it has; bails on any
 * individual preview that doesn't have enough points, returns what succeeded.
 * Pure writes — no network, no external binaries.
 *
 * External dependencies: d3 (v7) — geoMercator / geoConicConformal / geoPath
 * for projection, scaleLinear for chart axes, line/area for filled profiles,
 * extent/ticks for nice axis labels. This is the only src/ module with a
 * runtime dep; all others are stdlib only.
 *
 * Projection strategy: pick Lambert conformal conic for trips whose bbox
 * fits inside 40° lon × 25° lat (essentially state-plane-grade fidelity with
 * parallels auto-fitted to the trip extent), fall back to Mercator for
 * continental / antimeridian crossings. See pickProjection() for the details.
 *
 * Theme: SVGs loaded via <img> don't inherit prefers-color-scheme from the
 * embedding page, so we emit two concrete palettes (light + dark) and let
 * <picture> + media-conditional <source> do the switching.
 *
 * Exports:
 *   renderMapSvg         — single map preview SVG
 *   renderElevationSvg   — single elevation-profile SVG
 *   renderSpeedSvg       — single speed-profile SVG (5s-smoothed mph)
 *   writeSvgPreviews     — orchestrator: writes both variants of all three
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as d3 from 'd3';
import { haversine, simplifyPoints } from './gpx.js';

function esc(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Pick a projection that minimises distortion for this trip's bbox.
// Lambert conformal conic (d3.geoConicConformal) with standard parallels set
// at 1/6 and 5/6 of the latitude span — the same logic SPCS uses — gives
// essentially state-plane-grade fidelity inside the bbox.
// Fall back to Mercator for huge / antimeridian-crossing trips.
function pickProjection(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;

  if (lonSpan > 40 || latSpan > 25 || minLon < -170 || maxLon > 170) {
    return { projection: d3.geoMercator(), name: 'mercator' };
  }

  // LCC with inscribed standard parallels
  const sp1 = minLat + latSpan / 6;
  const sp2 = maxLat - latSpan / 6;
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const projection = d3.geoConicConformal()
    .parallels([sp1, sp2])
    .rotate([-centerLon, 0])
    .center([0, centerLat]);
  return { projection, name: `lambert conformal conic · parallels ${sp1.toFixed(1)}°/${sp2.toFixed(1)}°` };
}

// ---------- theme styles ----------
// SVGs loaded via <img> don't receive the page's prefers-color-scheme — CSS
// media queries inside a standalone SVG evaluate against the SVG's own
// (effectively "light") environment. So: produce two concrete palettes and
// let the embedding page pick via <picture> + media-conditional <source>.
function themeStyle(dark) {
  const c = dark
    ? { fg: '#e8e6e3', muted: '#9aa0a6', frame: '#8a8a8a', fill: '#2b2b2b', peak: '#ff6b6b', trough: '#6bd16b', acc1: '#ffb870', acc2: '#ff6b6b', acc3: '#8aa8ff', toot: '#ff277d', tootText: '#0b0b0b' }
    : { fg: '#111',    muted: '#555',    frame: '#111',    fill: '#ddd',    peak: '#c00',    trough: '#2a7a2a', acc1: '#7a4500', acc2: '#c00',    acc3: '#3a3a9a', toot: '#6364ff', tootText: '#fff' };
  return `
  <style>
    :root {
      --fg: ${c.fg};
      --muted: ${c.muted};
      --frame: ${c.frame};
      --fill: ${c.fill};
      --peak: ${c.peak};
      --trough: ${c.trough};
      --accent-1: ${c.acc1};
      --accent-2: ${c.acc2};
      --accent-3: ${c.acc3};
      --toot: ${c.toot};
      --toot-text: ${c.tootText};
    }
    .mg-bg { fill: none; }
    .mg-fg { fill: var(--fg); }
    .mg-muted { fill: var(--muted); }
    .mg-frame { fill: none; stroke: var(--frame); stroke-width: 0.5; }
    .mg-track { fill: none; stroke: var(--fg); stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
    .mg-dot { fill: var(--fg); }
    .mg-area { fill: var(--fill); stroke: none; }
    .mg-line { fill: none; stroke: var(--fg); stroke-width: 1.2; }
    .mg-axis { stroke: var(--frame); stroke-width: 0.5; fill: none; }
    .mg-label { fill: var(--fg); font-family: Helvetica, Arial, sans-serif; }
    .mg-muted-label { fill: var(--muted); font-family: Helvetica, Arial, sans-serif; }
    .mg-peak { fill: var(--peak); }
    .mg-trough { fill: var(--trough); }
    .mg-peak-label { fill: var(--peak); font-family: Helvetica, Arial, sans-serif; font-weight: bold; }
    .mg-acc-1 { stroke: var(--accent-1); fill: none; }
    .mg-acc-1-label { fill: var(--accent-1); font-family: Helvetica, Arial, sans-serif; font-weight: bold; }
    .mg-acc-2 { stroke: var(--accent-2); fill: none; }
    .mg-acc-2-label { fill: var(--accent-2); font-family: Helvetica, Arial, sans-serif; font-weight: bold; }
    .mg-acc-3 { stroke: var(--accent-3); fill: none; }
    .mg-acc-3-label { fill: var(--accent-3); font-family: Helvetica, Arial, sans-serif; font-weight: bold; }
    .mg-start { fill: var(--trough); stroke: var(--frame); stroke-width: 0.5; }
    .mg-end { fill: var(--peak); stroke: var(--frame); stroke-width: 0.5; }
    .mg-toot { fill: var(--toot); stroke: var(--frame); stroke-width: 0.8; }
    .mg-toot-label { fill: var(--toot-text); font-family: Helvetica, Arial, sans-serif; }
  </style>`;
}

// ---------- map preview ----------
export function renderMapSvg(perStage, deduped, opts, superlatives, places, dark = false, toots = null) {
  if (!deduped.length || !perStage.length) return null;

  const MAX_W = 900;
  const MIN_W = 340;
  const MAX_H = 700;
  const PAD = { top: 60, right: 30, bottom: 50, left: 30 };
  // Breathing room between the track and the frame so endpoints and labels
  // don't get cropped or pressed against the border.
  const INSET = 24;

  const SIMPLIFY_M = 3;
  const trackFc = {
    type: 'FeatureCollection',
    features: perStage.map(({ pts, i }) => ({
      type: 'Feature',
      properties: { stage: i },
      geometry: {
        type: 'LineString',
        coordinates: simplifyPoints(pts, SIMPLIFY_M).map(p => [p.lon, p.lat]),
      },
    })),
  };

  // Pick the right projection for this bbox (LCC for small/medium trips,
  // Mercator as fallback).
  const bounds = d3.geoBounds(trackFc);            // [[minLon,minLat],[maxLon,maxLat]]
  const bbox = [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]];
  const { projection: projBase, name: projName } = pickProjection(bbox);

  const provisionalInnerW = MAX_W - PAD.left - PAD.right - 2 * INSET;
  const provisionalInnerH = MAX_H - PAD.top - PAD.bottom - 2 * INSET;

  // Probe at the provisional extent so we know the track's rendered aspect.
  projBase.fitExtent(
    [[0, 0], [provisionalInnerW, provisionalInnerH]],
    trackFc,
  );
  const probePath = d3.geoPath(projBase);
  const [[bx0, by0], [bx1, by1]] = probePath.bounds(trackFc);
  const renderedW = bx1 - bx0;
  const renderedH = by1 - by0;

  // Frame includes INSET breathing room on all sides; SVG canvas includes PAD
  // outside the frame for title + scale bar + attribution.
  const frameW = renderedW + 2 * INSET;
  const frameH = renderedH + 2 * INSET;
  const W = Math.max(MIN_W, Math.round(frameW + PAD.left + PAD.right));
  const H = Math.round(frameH + PAD.top + PAD.bottom);
  const frameX0 = PAD.left;
  const frameY0 = PAD.top;
  const frameX1 = frameX0 + frameW;
  const frameY1 = frameY0 + frameH;

  // Re-fit the projection into the inset region so the track has breathing
  // room between itself and the frame border.
  const projection = projBase.fitExtent(
    [[frameX0 + INSET, frameY0 + INSET], [frameX1 - INSET, frameY1 - INSET]],
    trackFc,
  );
  const path = d3.geoPath(projection);
  const trackD = path(trackFc);

  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  const [sx, sy] = projection([first.lon, first.lat]);
  const [ex, ey] = projection([last.lon, last.lat]);
  const isLoop = Math.hypot(ex - sx, ey - sy) < 10;

  // town labels with simple collision suppression
  const townMarks = [];
  const MIN_LABEL_DX = 55, MIN_LABEL_DY = 14;
  for (const pl of places || []) {
    const [x, y] = projection([pl.lon, pl.lat]);
    if (townMarks.some(t => Math.abs(t.x - x) < MIN_LABEL_DX && Math.abs(t.y - y) < MIN_LABEL_DY)) continue;
    townMarks.push({ x, y, name: pl.name });
    if (townMarks.length >= 15) break;
  }

  // toot markers — small numbered dots with a pale link-colored ring
  const tootMarks = [];
  if (toots?.features?.length) {
    for (const f of toots.features) {
      if (!f.geometry?.coordinates) continue;
      const [lon, lat] = f.geometry.coordinates;
      const [x, y] = projection([lon, lat]);
      tootMarks.push({ x, y, n: f.properties.index });
    }
  }

  // superlative annotations
  const annotations = [];
  if (superlatives?.highest) {
    const [x, y] = projection([superlatives.highest.lon, superlatives.highest.lat]);
    annotations.push({ x, y, label: `peak ${superlatives.highest.ele_m}m`, cls: 'acc-1' });
  }
  if (superlatives?.performance?.top_speed) {
    const ts = superlatives.performance.top_speed;
    const [x, y] = projection([ts.lon, ts.lat]);
    annotations.push({ x, y, label: `top speed ${ts.mph} mph`, cls: 'acc-2' });
  }
  if (superlatives?.performance?.max_lateral_g) {
    const lg = superlatives.performance.max_lateral_g;
    const [x, y] = projection([lg.lon, lg.lat]);
    annotations.push({ x, y, label: `${lg.g}G @ ${lg.speed_mph}mph`, cls: 'acc-3' });
  }

  // scale bar
  const [pMidLon, pMidLat] = projection.invert([(frameX0 + frameX1) / 2, (frameY0 + frameY1) / 2]);
  const oneKmLon = 1 / (111.320 * Math.cos(pMidLat * Math.PI / 180));
  const [px0] = projection([pMidLon, pMidLat]);
  const [px1] = projection([pMidLon + oneKmLon, pMidLat]);
  const pixelsPerKm = Math.abs(px1 - px0);
  const targetKm = Math.max(1, Math.round(((frameX1 - frameX0) * 0.2) / pixelsPerKm));
  const niceKm = [1, 2, 5, 10, 20, 50, 100].reduce(
    (best, k) => Math.abs(k - targetKm) < Math.abs(best - targetKm) ? k : best, 1,
  );
  const scalePx = niceKm * pixelsPerKm;
  const scaleX = frameX0;
  const scaleY = H - 25;

  const title = esc(opts.name || 'moto-gpx');
  const stats = (() => {
    const t = perStage.reduce(
      (a, s) => ({
        km: a.km + (s.stats.distance_km || 0),
        moving: a.moving + (s.stats.moving_min || 0),
      }),
      { km: 0, moving: 0 },
    );
    const h = Math.floor(t.moving / 60);
    const m = Math.round(t.moving - h * 60);
    return `${t.km.toFixed(1)} km · ${(t.km * 0.621371).toFixed(1)} mi · ${h}h${String(m).padStart(2, '0')} moving`;
  })();

  const titleSvg = `
    <text class="mg-label" x="${frameX0}" y="28" font-size="16" font-weight="bold">${title}</text>
    <text class="mg-muted-label" x="${frameX0}" y="46" font-size="11">${esc(stats)}</text>`;

  const frame = `<rect class="mg-frame" x="${frameX0}" y="${frameY0}" width="${renderedW.toFixed(1)}" height="${renderedH.toFixed(1)}"/>`;
  const track = `<path class="mg-track" d="${trackD}"/>`;

  const startEnd =
    `<polygon class="mg-start" points="${sx.toFixed(1)},${(sy - 5).toFixed(1)} ${(sx - 4.5).toFixed(1)},${(sy + 3).toFixed(1)} ${(sx + 4.5).toFixed(1)},${(sy + 3).toFixed(1)}"/>` +
    (!isLoop ? `<rect class="mg-end" x="${(ex - 4).toFixed(1)}" y="${(ey - 4).toFixed(1)}" width="8" height="8"/>` : '');

  const townSvg = townMarks.map(t =>
    `<circle class="mg-dot" cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="2"/>` +
    `<text class="mg-label" x="${(t.x + 5).toFixed(1)}" y="${(t.y - 4).toFixed(1)}" font-size="10">${esc(t.name)}</text>`
  ).join('\n  ');

  const tootSvg = tootMarks.map(t =>
    `<circle class="mg-toot" cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="7"/>` +
    `<text class="mg-toot-label" x="${t.x.toFixed(1)}" y="${(t.y + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="bold">${t.n}</text>`
  ).join('\n  ');

  const annotationSvg = annotations.map((a, i) => {
    const approxW = a.label.length * 6.5;
    const flipLeft = (a.x + 8 + approxW) > frameX1 - 4;
    const anchor = flipLeft ? 'end' : 'start';
    const dx = flipLeft ? -8 : 8;
    let dy = i % 2 === 0 ? -8 : 14;
    if (a.y + dy < frameY0 + 10) dy = 14;
    if (a.y + dy > frameY1 - 4) dy = -8;
    return `<circle class="mg-${a.cls}" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3.5" stroke-width="1.5"/>` +
      `<text class="mg-${a.cls}-label" x="${(a.x + dx).toFixed(1)}" y="${(a.y + dy).toFixed(1)}" text-anchor="${anchor}" font-size="10">${esc(a.label)}</text>`;
  }).join('\n  ');

  const scaleBar = `
    <line class="mg-axis" x1="${scaleX.toFixed(1)}" y1="${scaleY}" x2="${(scaleX + scalePx).toFixed(1)}" y2="${scaleY}" stroke-width="1.5"/>
    <line class="mg-axis" x1="${scaleX.toFixed(1)}" y1="${(scaleY - 4)}" x2="${scaleX.toFixed(1)}" y2="${(scaleY + 4)}" stroke-width="1.5"/>
    <line class="mg-axis" x1="${(scaleX + scalePx).toFixed(1)}" y1="${(scaleY - 4)}" x2="${(scaleX + scalePx).toFixed(1)}" y2="${(scaleY + 4)}" stroke-width="1.5"/>
    <text class="mg-label" x="${(scaleX + scalePx / 2).toFixed(1)}" y="${(scaleY - 7)}" text-anchor="middle" font-size="10">${niceKm} km</text>`;

  const footer = `<text class="mg-muted-label" x="${frameX1}" y="${(H - 18)}" text-anchor="end" font-size="9">moto-gpx · ${esc(projName)}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
  ${themeStyle(dark)}
  ${titleSvg}
  ${frame}
  ${track}
  ${startEnd}
  ${townSvg}
  ${tootSvg}
  ${annotationSvg}
  ${scaleBar}
  ${footer}
</svg>`;
}

// ---------- profile charts (shared shape) ----------
// data: [{ x, y }] where x is meters, y is the measured value
// peakLabel / troughLabel: e.g. '353m peak', '90 mph top', null to skip
function renderProfile({ title, data, yUnit, xAxisLabel, highlightMax, highlightMin, dark = false }) {
  if (data.length < 3) return null;

  const W = 900;
  const H = 220;
  const PAD = { top: 30, right: 30, bottom: 40, left: 55 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const [xMin, xMax] = d3.extent(data, p => p.x);
  const [yMin, yMax] = d3.extent(data, p => p.y);
  const yPad = (yMax - yMin) * 0.1 || 10;

  // Downsample to ~1 point per rendered pixel.
  const targetPts = 900;
  const stride = Math.max(1, Math.floor(data.length / targetPts));
  const sampled = [];
  for (let i = 0; i < data.length; i += stride) sampled.push(data[i]);
  if (sampled[sampled.length - 1] !== data[data.length - 1]) sampled.push(data[data.length - 1]);

  const x = d3.scaleLinear().domain([xMin, xMax]).range([PAD.left, PAD.left + innerW]);
  const y = d3.scaleLinear().domain([Math.max(0, yMin - yPad), yMax + yPad]).range([PAD.top + innerH, PAD.top]);

  const area = d3.area()
    .x(d => x(d.x))
    .y0(y(y.domain()[0]))
    .y1(d => y(d.y));
  const line = d3.line().x(d => x(d.x)).y(d => y(d.y));

  const areaD = area(sampled);
  const lineD = line(sampled);

  const peak = data.reduce((a, b) => (b.y > a.y ? b : a));
  const trough = data.reduce((a, b) => (b.y < a.y ? b : a));

  const xKm = x.copy().domain([xMin / 1000, xMax / 1000]);
  const ticks = xKm.ticks(6);
  const xTickSvg = ticks.map(k => {
    const px = x(k * 1000);
    return `<line class="mg-axis" x1="${px.toFixed(1)}" y1="${(PAD.top + innerH)}" x2="${px.toFixed(1)}" y2="${(PAD.top + innerH + 4)}"/>` +
      `<text class="mg-label" x="${px.toFixed(1)}" y="${(PAD.top + innerH + 16)}" text-anchor="middle" font-size="10">${k}</text>`;
  }).join('\n  ');

  const yLabelSvg = `
    <text class="mg-label" x="${PAD.left - 8}" y="${(y(yMax) + 4).toFixed(1)}" text-anchor="end" font-size="10">${Math.round(yMax)}${yUnit}</text>
    <text class="mg-label" x="${PAD.left - 8}" y="${(y(yMin) + 4).toFixed(1)}" text-anchor="end" font-size="10">${Math.round(yMin)}${yUnit}</text>`;

  const peakMark = highlightMax
    ? `<circle class="mg-peak" cx="${x(peak.x).toFixed(1)}" cy="${y(peak.y).toFixed(1)}" r="3"/>` +
      `<text class="mg-peak-label" x="${(x(peak.x) + 5).toFixed(1)}" y="${(y(peak.y) - 5).toFixed(1)}" font-size="10">${highlightMax(peak)}</text>`
    : '';
  const troughMark = highlightMin
    ? `<circle class="mg-trough" cx="${x(trough.x).toFixed(1)}" cy="${y(trough.y).toFixed(1)}" r="3"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
  ${themeStyle(dark)}
  <text class="mg-label" x="${PAD.left}" y="20" font-size="13" font-weight="bold">${esc(title)}</text>
  <path class="mg-area" d="${areaD}"/>
  <path class="mg-line" d="${lineD}"/>
  <line class="mg-axis" x1="${PAD.left}" y1="${(PAD.top + innerH)}" x2="${(PAD.left + innerW)}" y2="${(PAD.top + innerH)}"/>
  ${xTickSvg}
  ${yLabelSvg}
  ${peakMark}
  ${troughMark}
  <text class="mg-muted-label" x="${(PAD.left + innerW / 2)}" y="${(H - 6)}" text-anchor="middle" font-size="10">${esc(xAxisLabel)}</text>
</svg>`;
}

// ---------- elevation profile ----------
export function renderElevationSvg(deduped, dark = false) {
  const data = [];
  let cumD = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (i > 0) cumD += haversine(deduped[i - 1], deduped[i]);
    if (deduped[i].ele != null) data.push({ x: cumD, y: deduped[i].ele });
  }
  return renderProfile({
    title: 'elevation profile',
    data,
    yUnit: 'm',
    xAxisLabel: 'kilometers',
    highlightMax: p => `${Math.round(p.y)}m peak`,
    highlightMin: true,
    dark,
  });
}

// ---------- speed profile ----------
// 5-second sliding window smoothing (same as max_speed in stats) so single
// GPS jitter points don't spike the chart.
export function renderSpeedSvg(deduped, dark = false) {
  const SPEED_WINDOW_MS = 5000;
  const data = [];
  let cumD = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (i > 0) cumD += haversine(deduped[i - 1], deduped[i]);
    if (deduped[i].time == null) continue;
    let j = i + 1;
    let winDist = 0;
    while (j < deduped.length) {
      if (deduped[j].time == null) { j++; continue; }
      winDist += haversine(deduped[j - 1], deduped[j]);
      if ((deduped[j].time - deduped[i].time) >= SPEED_WINDOW_MS) break;
      j++;
    }
    if (j >= deduped.length) break;
    const dt = (deduped[j].time - deduped[i].time) / 1000;
    if (dt <= 0) continue;
    const mph = (winDist / dt) * 2.23694;
    if (mph < 200) data.push({ x: cumD, y: mph });
  }
  return renderProfile({
    title: 'speed profile',
    data,
    yUnit: ' mph',
    xAxisLabel: 'kilometers',
    highlightMax: p => `${Math.round(p.y)} mph top`,
    highlightMin: false,
    dark,
  });
}

// ---------- orchestrator ----------
export function writeSvgPreviews(outDir, perStage, deduped, opts, superlatives) {
  let places = null;
  try {
    const placesPath = join(outDir, 'places.geojson');
    if (existsSync(placesPath)) {
      const fc = JSON.parse(readFileSync(placesPath, 'utf8'));
      places = (fc.features || [])
        .map(f => ({
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          name: f.properties.name,
          place_type: f.properties.place_type,
          nearest_time_iso: f.properties.nearest_time_iso,
        }))
        .sort((a, b) => Date.parse(a.nearest_time_iso) - Date.parse(b.nearest_time_iso));
    }
  } catch { /* ignore */ }

  let toots = null;
  try {
    const tootsPath = join(outDir, 'toots.geojson');
    if (existsSync(tootsPath)) toots = JSON.parse(readFileSync(tootsPath, 'utf8'));
  } catch { /* ignore */ }

  const results = {};
  const mapLight = renderMapSvg(perStage, deduped, opts, superlatives, places, false, toots);
  const mapDark = renderMapSvg(perStage, deduped, opts, superlatives, places, true, toots);
  if (mapLight) {
    writeFileSync(join(outDir, 'preview-map.svg'), mapLight);
    writeFileSync(join(outDir, 'preview-map-dark.svg'), mapDark);
    results.map = 'preview-map.svg';
  }
  const eleLight = renderElevationSvg(deduped, false);
  const eleDark = renderElevationSvg(deduped, true);
  if (eleLight) {
    writeFileSync(join(outDir, 'preview-elevation.svg'), eleLight);
    writeFileSync(join(outDir, 'preview-elevation-dark.svg'), eleDark);
    results.elevation = 'preview-elevation.svg';
  }
  const spdLight = renderSpeedSvg(deduped, false);
  const spdDark = renderSpeedSvg(deduped, true);
  if (spdLight) {
    writeFileSync(join(outDir, 'preview-speed.svg'), spdLight);
    writeFileSync(join(outDir, 'preview-speed-dark.svg'), spdDark);
    results.speed = 'preview-speed.svg';
  }
  return results;
}
