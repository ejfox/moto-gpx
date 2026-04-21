// SVG preview generator — map view + elevation profile.
// Uses d3-geo for projection/fit and d3-scale/d3-shape for the elevation chart.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as d3 from 'd3';
import { haversine, simplifyPoints } from './gpx.js';

function esc(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ---------- map preview ----------
export function renderMapSvg(perStage, deduped, opts, superlatives, places) {
  if (!deduped.length || !perStage.length) return null;

  const MAX_W = 900;
  // Title is ~240px wide at 16px Helvetica; ensure the viewport is wide enough
  // for the header + scale bar + attribution without clipping.
  const MIN_W = 340;
  const MAX_H = 700;
  const PAD = { top: 60, right: 30, bottom: 50, left: 30 };

  // Douglas-Peucker simplify each stage — ~1 point per 3m is well below visible
  // detail at our rendered scale and drops file size 80–90%.
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

  // First pass: fit to a provisional box, then compute final H from the
  // bounds d3 actually renders, so the frame hugs the geography on both axes.
  const provisionalInnerW = MAX_W - PAD.left - PAD.right;
  const provisionalInnerH = MAX_H - PAD.top - PAD.bottom;

  const projectionProbe = d3.geoMercator()
    .fitExtent(
      [[PAD.left, PAD.top], [PAD.left + provisionalInnerW, PAD.top + provisionalInnerH]],
      trackFc,
    );
  const probePath = d3.geoPath(projectionProbe);
  const [[bx0, by0], [bx1, by1]] = probePath.bounds(trackFc);
  const renderedW = bx1 - bx0;
  const renderedH = by1 - by0;

  // Final viewport: tight around the track at its rendered scale, with a
  // minimum width so the header/attribution have room to breathe.
  const W = Math.max(MIN_W, Math.round(renderedW + PAD.left + PAD.right));
  const H = Math.round(renderedH + PAD.top + PAD.bottom);
  const frameX0 = PAD.left;
  const frameY0 = PAD.top;
  const frameX1 = PAD.left + renderedW;
  const frameY1 = PAD.top + renderedH;

  const projection = d3.geoMercator()
    .fitExtent([[frameX0, frameY0], [frameX1, frameY1]], trackFc);
  const path = d3.geoPath(projection);

  // --- track path ---
  const trackD = path(trackFc);

  // --- start/end markers ---
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  const [sx, sy] = projection([first.lon, first.lat]);
  const [ex, ey] = projection([last.lon, last.lat]);
  const isLoop = Math.hypot(ex - sx, ey - sy) < 10;

  // --- town labels (chronological, with simple overlap suppression) ---
  const townMarks = [];
  const MIN_LABEL_DX = 55;  // horizontal spread threshold
  const MIN_LABEL_DY = 14;  // vertical spread threshold
  for (const pl of places || []) {
    const [x, y] = projection([pl.lon, pl.lat]);
    const clash = townMarks.some(t =>
      Math.abs(t.x - x) < MIN_LABEL_DX && Math.abs(t.y - y) < MIN_LABEL_DY,
    );
    if (clash) continue;
    townMarks.push({ x, y, name: pl.name });
    if (townMarks.length >= 15) break;
  }

  // --- superlative annotations ---
  const annotations = [];
  if (superlatives?.highest) {
    const [x, y] = projection([superlatives.highest.lon, superlatives.highest.lat]);
    annotations.push({ x, y, label: `peak ${superlatives.highest.ele_m}m`, color: '#7a4500' });
  }
  if (superlatives?.performance?.top_speed) {
    const ts = superlatives.performance.top_speed;
    const [x, y] = projection([ts.lon, ts.lat]);
    annotations.push({ x, y, label: `top speed ${ts.mph} mph`, color: '#c00' });
  }
  if (superlatives?.performance?.max_lateral_g) {
    const lg = superlatives.performance.max_lateral_g;
    const [x, y] = projection([lg.lon, lg.lat]);
    annotations.push({ x, y, label: `${lg.g}G @ ${lg.speed_mph}mph`, color: '#3a3a9a' });
  }

  // --- scale bar ---
  // Compute projected pixels per km by projecting two points 1km apart in longitude at the map center lat.
  const midLat = ((projection.invert([frameX0, frameY0])[1] + projection.invert([frameX1, frameY1])[1]) / 2);
  const midLon = ((projection.invert([frameX0, frameY0])[0] + projection.invert([frameX1, frameY1])[0]) / 2);
  const oneKmLon = 1 / (111.320 * Math.cos(midLat * Math.PI / 180));
  const [px0] = projection([midLon, midLat]);
  const [px1] = projection([midLon + oneKmLon, midLat]);
  const pixelsPerKm = Math.abs(px1 - px0);
  const targetKm = Math.max(1, Math.round(((frameX1 - frameX0) * 0.2) / pixelsPerKm));
  const niceKm = [1, 2, 5, 10, 20, 50, 100].reduce(
    (best, k) => Math.abs(k - targetKm) < Math.abs(best - targetKm) ? k : best, 1
  );
  const scalePx = niceKm * pixelsPerKm;
  const scaleX = frameX0;
  const scaleY = H - 25;

  // --- header ---
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

  // --- compose SVG ---
  const bg = `<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>`;
  const titleSvg = `
    <text x="${frameX0}" y="28" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="bold" fill="#111">${title}</text>
    <text x="${frameX0}" y="46" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#555">${esc(stats)}</text>`;
  const frame = `<rect x="${frameX0}" y="${frameY0}" width="${renderedW.toFixed(1)}" height="${renderedH.toFixed(1)}" fill="none" stroke="#111" stroke-width="0.5"/>`;
  const track = `<path d="${trackD}" fill="none" stroke="#111" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  const startEnd =
    `<polygon points="${sx.toFixed(1)},${(sy - 5).toFixed(1)} ${(sx - 4.5).toFixed(1)},${(sy + 3).toFixed(1)} ${(sx + 4.5).toFixed(1)},${(sy + 3).toFixed(1)}" fill="#2a7a2a" stroke="#111" stroke-width="0.5"/>` +
    (!isLoop
      ? `<rect x="${(ex - 4).toFixed(1)}" y="${(ey - 4).toFixed(1)}" width="8" height="8" fill="#b33a3a" stroke="#111" stroke-width="0.5"/>`
      : '');

  const townSvg = townMarks.map(t => {
    return `<circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="2" fill="#111"/>` +
      `<text x="${(t.x + 5).toFixed(1)}" y="${(t.y - 4).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#111">${esc(t.name)}</text>`;
  }).join('\n  ');

  const annotationSvg = annotations.map((a, i) => {
    const approxW = a.label.length * 6.5;
    const flipLeft = (a.x + 8 + approxW) > frameX1 - 4;
    const anchor = flipLeft ? 'end' : 'start';
    const dx = flipLeft ? -8 : 8;
    let dy = i % 2 === 0 ? -8 : 14;
    if (a.y + dy < frameY0 + 10) dy = 14;
    if (a.y + dy > frameY1 - 4) dy = -8;
    return `<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="3.5" fill="none" stroke="${a.color}" stroke-width="1.5"/>` +
      `<text x="${(a.x + dx).toFixed(1)}" y="${(a.y + dy).toFixed(1)}" text-anchor="${anchor}" font-family="Helvetica, Arial, sans-serif" font-size="10" font-weight="bold" fill="${a.color}">${esc(a.label)}</text>`;
  }).join('\n  ');

  const scaleBar = `
    <line x1="${scaleX.toFixed(1)}" y1="${scaleY}" x2="${(scaleX + scalePx).toFixed(1)}" y2="${scaleY}" stroke="#111" stroke-width="1.5"/>
    <line x1="${scaleX.toFixed(1)}" y1="${(scaleY - 4)}" x2="${scaleX.toFixed(1)}" y2="${(scaleY + 4)}" stroke="#111" stroke-width="1.5"/>
    <line x1="${(scaleX + scalePx).toFixed(1)}" y1="${(scaleY - 4)}" x2="${(scaleX + scalePx).toFixed(1)}" y2="${(scaleY + 4)}" stroke="#111" stroke-width="1.5"/>
    <text x="${(scaleX + scalePx / 2).toFixed(1)}" y="${(scaleY - 7)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#111">${niceKm} km</text>`;

  const footer = `<text x="${frameX1}" y="${(H - 18)}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="9" fill="#888">moto-gpx · mercator</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
  ${bg}
  ${titleSvg}
  ${frame}
  ${track}
  ${startEnd}
  ${townSvg}
  ${annotationSvg}
  ${scaleBar}
  ${footer}
</svg>`;
}

// ---------- elevation profile ----------
export function renderElevationSvg(deduped /* perStage unused but kept for symmetry */) {
  const elePoints = [];
  let cumD = 0;
  for (let i = 0; i < deduped.length; i++) {
    if (i > 0) cumD += haversine(deduped[i - 1], deduped[i]);
    if (deduped[i].ele != null) {
      elePoints.push({ x: cumD, y: deduped[i].ele });
    }
  }
  if (elePoints.length < 3) return null;

  const W = 900;
  const H = 220;
  const PAD = { top: 30, right: 30, bottom: 40, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const [xMin, xMax] = d3.extent(elePoints, p => p.x);
  const [yMin, yMax] = d3.extent(elePoints, p => p.y);
  const yPad = (yMax - yMin) * 0.1 || 10;

  // Downsample to ~1 point per rendered pixel. Saves 90% of bytes, visually identical.
  const targetPts = 900;
  const stride = Math.max(1, Math.floor(elePoints.length / targetPts));
  const sampled = [];
  for (let i = 0; i < elePoints.length; i += stride) sampled.push(elePoints[i]);
  if (sampled[sampled.length - 1] !== elePoints[elePoints.length - 1]) sampled.push(elePoints[elePoints.length - 1]);

  const x = d3.scaleLinear().domain([xMin, xMax]).range([PAD.left, PAD.left + innerW]);
  const y = d3.scaleLinear().domain([yMin - yPad, yMax + yPad]).range([PAD.top + innerH, PAD.top]);

  const area = d3.area()
    .x(d => x(d.x))
    .y0(y(yMin - yPad))
    .y1(d => y(d.y));
  const line = d3.line()
    .x(d => x(d.x))
    .y(d => y(d.y));

  const areaD = area(sampled);
  const lineD = line(sampled);

  const peak = elePoints.reduce((a, b) => (b.y > a.y ? b : a));
  const trough = elePoints.reduce((a, b) => (b.y < a.y ? b : a));

  // X ticks at nice km intervals via d3
  const xKm = x.copy().domain([xMin / 1000, xMax / 1000]);
  const ticks = xKm.ticks(6);
  const xTickSvg = ticks.map(k => {
    const px = x(k * 1000);
    return `<line x1="${px.toFixed(1)}" y1="${(PAD.top + innerH)}" x2="${px.toFixed(1)}" y2="${(PAD.top + innerH + 4)}" stroke="#111" stroke-width="0.5"/>` +
      `<text x="${px.toFixed(1)}" y="${(PAD.top + innerH + 16)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#111">${k}</text>`;
  }).join('\n  ');

  const yLabelSvg = `
    <text x="${PAD.left - 8}" y="${(y(yMax) + 4).toFixed(1)}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#111">${Math.round(yMax)}m</text>
    <text x="${PAD.left - 8}" y="${(y(yMin) + 4).toFixed(1)}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#111">${Math.round(yMin)}m</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
  <rect x="0" y="0" width="${W}" height="${H}" fill="white"/>
  <text x="${PAD.left}" y="20" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="bold" fill="#111">elevation profile</text>
  <path d="${areaD}" fill="#ddd" stroke="none"/>
  <path d="${lineD}" fill="none" stroke="#111" stroke-width="1.2"/>
  <line x1="${PAD.left}" y1="${(PAD.top + innerH)}" x2="${(PAD.left + innerW)}" y2="${(PAD.top + innerH)}" stroke="#111" stroke-width="0.5"/>
  ${xTickSvg}
  ${yLabelSvg}
  <circle cx="${x(peak.x).toFixed(1)}" cy="${y(peak.y).toFixed(1)}" r="3" fill="#c00" stroke="#111" stroke-width="0.5"/>
  <text x="${(x(peak.x) + 5).toFixed(1)}" y="${(y(peak.y) - 5).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="10" font-weight="bold" fill="#c00">${Math.round(peak.y)}m peak</text>
  <circle cx="${x(trough.x).toFixed(1)}" cy="${y(trough.y).toFixed(1)}" r="3" fill="#2a7a2a" stroke="#111" stroke-width="0.5"/>
  <text x="${(PAD.left + innerW / 2)}" y="${(H - 6)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="10" fill="#555">kilometers</text>
</svg>`;
}

// ---------- orchestrator ----------
export function writeSvgPreviews(outDir, perStage, deduped, opts, superlatives) {
  // Read places.geojson if --enrich osm already wrote it.
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

  const results = {};
  const map = renderMapSvg(perStage, deduped, opts, superlatives, places);
  if (map) {
    writeFileSync(join(outDir, 'preview-map.svg'), map);
    results.map = 'preview-map.svg';
  }
  const ele = renderElevationSvg(deduped);
  if (ele) {
    writeFileSync(join(outDir, 'preview-elevation.svg'), ele);
    results.elevation = 'preview-elevation.svg';
  }
  return results;
}
