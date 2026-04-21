/**
 * qml.js — emit QGIS .qml style files so GeoJSON layers self-style on drag-drop.
 *
 * Role in the pipeline: final step after geometry/enrichment. Writes a per-
 * layer .qml alongside each .geojson the main pipeline produced, plus a
 * styles/ folder containing all templates for users to Load-style later.
 *
 * Contract: pure filesystem writes. No network. Silently skips when a
 * target .geojson doesn't exist (e.g. the user didn't enable that enrichment).
 * No return value — if writing a style fails, Node throws, which is correct
 * here because the output directory must be writable for anything else to
 * have worked.
 *
 * External: QGIS 3.28+ (the .qml XML schema version is pinned in HEADER
 * below). QGIS 3.x has been stable in its QML parser since ~3.10; the format
 * remains forward-compatible in recent 3.x releases.
 *
 * Exports:
 *   - writeStarterStyles(outDir) — write every style + attach siblings.
 */

// ═══ QGIS auto-load convention ═══
//
// When QGIS loads a vector file (drag-drop, add-layer, etc.) it looks for a
// sibling file with the same basename and the extension `.qml`. If found,
// it auto-applies the symbology, labeling, etc. described inside. This is
// the magic that makes `all.geojson` render with the right colors without
// the user having to touch Properties > Style > Load Style.
//
// The .qml format is QGIS's native XML serialization of a style. Top-level
// schema:
//   <qgis styleCategories="...">         // which categories this file covers
//     <renderer-v2 type="...">           // the actual symbology
//       <categories>...</categories>     // (categorized only) value→symbol map
//       <symbols>...</symbols>           // one <symbol> per category
//       <source-symbol>...</source-symbol>
//     </renderer-v2>
//     <labeling type="simple">...</labeling>  // optional text labels
//   </qgis>
//
// Renderer types we use:
//   singleSymbol     — all features share one symbol
//   categorizedSymbol— split by a property value, one symbol per bucket
//
// Symbol types:
//   line             — SimpleLine layer (color, width, cap/join)
//   marker           — SimpleMarker layer (shape, size, fill, stroke)
//
// The `version="3.28-moto-gpx"` attribute in HEADER is informational — QGIS
// reads it but accepts any reasonable value and falls back to the current
// schema. We pin 3.28 as the minimum tested QGIS version (LTS line, 2022+).

import { mkdirSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// ═══ constants ═══
const HEADER = `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis styleCategories="Symbology|Labeling" version="3.28-moto-gpx">`;

// ═══ symbol primitives ═══
// Colors are QGIS's standard "r,g,b,a" string (each 0-255). Widths/sizes in
// millimeters so they're print-scale-independent (MM unit).
function lineSymbol(name, color, widthMM = 0.8) {
  return `<symbol alpha="1" type="line" name="${name}" clip_to_extent="1">
    <layer class="SimpleLine" locked="0" pass="0">
      <prop k="line_color" v="${color}"/>
      <prop k="line_width" v="${widthMM}"/>
      <prop k="line_width_unit" v="MM"/>
      <prop k="capstyle" v="round"/>
      <prop k="joinstyle" v="round"/>
    </layer>
  </symbol>`;
}

function markerSymbol(name, color, sizeMM = 3, shape = 'circle', strokeColor = '0,0,0,180') {
  return `<symbol alpha="1" type="marker" name="${name}" clip_to_extent="1">
    <layer class="SimpleMarker" locked="0" pass="0">
      <prop k="color" v="${color}"/>
      <prop k="name" v="${shape}"/>
      <prop k="size" v="${sizeMM}"/>
      <prop k="size_unit" v="MM"/>
      <prop k="outline_color" v="${strokeColor}"/>
      <prop k="outline_width" v="0.2"/>
      <prop k="outline_width_unit" v="MM"/>
    </layer>
  </symbol>`;
}

// ═══ renderers ═══
// Categorized renderers split features by `attr`'s value. `cats` is an array
// of {value, label, color, width|size, shape?} — one bucket each. A default
// "source-symbol" (gray) covers any unmatched value.
function categorizedLine(attr, cats) {
  return `<renderer-v2 type="categorizedSymbol" attr="${attr}" symbollevels="0">
    <categories>
      ${cats.map((c, i) => `<category render="true" symbol="${i}" value="${c.value}" label="${c.label}"/>`).join('\n      ')}
    </categories>
    <symbols>
      ${cats.map((c, i) => lineSymbol(String(i), c.color, c.width ?? 0.8)).join('\n      ')}
    </symbols>
    <source-symbol>${lineSymbol('0', '120,120,120,255')}</source-symbol>
  </renderer-v2>`;
}

function categorizedMarker(attr, cats) {
  return `<renderer-v2 type="categorizedSymbol" attr="${attr}" symbollevels="0">
    <categories>
      ${cats.map((c, i) => `<category render="true" symbol="${i}" value="${c.value}" label="${c.label}"/>`).join('\n      ')}
    </categories>
    <symbols>
      ${cats.map((c, i) => markerSymbol(String(i), c.color, c.size ?? 3, c.shape ?? 'circle', c.stroke ?? '0,0,0,180')).join('\n      ')}
    </symbols>
    <source-symbol>${markerSymbol('0', '120,120,120,255')}</source-symbol>
  </renderer-v2>`;
}

function singleSymbolLine(color, widthMM = 1.2) {
  return `<renderer-v2 type="singleSymbol" symbollevels="0">
    ${lineSymbol('0', color, widthMM)}
  </renderer-v2>`;
}

function singleSymbolMarker(color, sizeMM = 3, shape = 'circle') {
  return `<renderer-v2 type="singleSymbol" symbollevels="0">
    ${markerSymbol('0', color, sizeMM, shape)}
  </renderer-v2>`;
}

// ═══ labeling ═══
// `expression` is usually just a field name; `isExpression=0` tells QGIS to
// treat it as a literal column rather than a computed expression. Labels get
// a white halo ("text-buffer") so they're readable over any basemap.
function labeling(expression) {
  return `<labeling type="simple">
    <settings calloutType="simple">
      <text-style fontSize="9" fontFamily="Helvetica" fontWeight="50" textColor="20,20,20,255" textOpacity="1">
        <text-buffer bufferSize="0.8" bufferColor="255,255,255,255" bufferOpacity="0.9"/>
      </text-style>
      <text-format/>
      <placement placement="6" offsetType="0" dist="2"/>
      <rendering obstacle="1"/>
      <dd_properties/>
    </settings>
    <fieldName>${expression}</fieldName>
    <isExpression>0</isExpression>
  </labeling>`;
}

function qml(inner, label) {
  return `${HEADER}
  ${inner}
  ${label || ''}
</qgis>`;
}

// ═══ style definitions per layer ═══
// One entry per layer the pipeline can produce. Keys match the geojson
// basename (or subdir name for per-stage layers). If a new output layer is
// added to the pipeline, register a style for it here.
function stylesByLayer() {
  return {
    // speedbins: slow→highway, yellow→deep red
    speedbins: qml(categorizedLine('speed_bin', [
      { value: 'slow', label: 'slow (<35 mph)', color: '254,224,144,240', width: 0.6 },
      { value: 'moderate', label: 'moderate (35-55)', color: '253,141,60,240', width: 1.0 },
      { value: 'fast', label: 'fast (55-75)', color: '227,26,28,240', width: 1.4 },
      { value: 'highway', label: 'highway (75+)', color: '128,0,38,240', width: 1.8 },
    ])),

    // stops: overnight big, rest small
    stops: qml(categorizedMarker('kind', [
      { value: 'short-rest', label: 'short rest (<20min)', color: '158,202,225,220', size: 3, shape: 'circle' },
      { value: 'rest', label: 'rest (20-60min)', color: '107,174,214,220', size: 4.5, shape: 'circle' },
      { value: 'long-rest', label: 'long rest (1-6h)', color: '33,113,181,220', size: 6, shape: 'circle' },
      { value: 'overnight', label: 'overnight', color: '8,48,107,240', size: 8, shape: 'star' },
    ]), labeling('kind')),

    // markers: day vs stage, start vs end
    markers: qml(categorizedMarker('kind', [
      { value: 'stage_start', label: 'stage start', color: '49,163,84,220', size: 3, shape: 'triangle' },
      { value: 'stage_end', label: 'stage end', color: '239,59,44,220', size: 3, shape: 'square' },
      { value: 'day_start', label: 'day start', color: '35,139,69,255', size: 5, shape: 'triangle' },
      { value: 'day_end', label: 'day end', color: '165,15,21,255', size: 5, shape: 'square' },
    ]), labeling('label')),

    // media: golden hour vs day vs night, video gets larger
    media: qml(categorizedMarker('is_golden_hour', [
      { value: 'true', label: 'golden hour', color: '255,180,40,230', size: 4.5, shape: 'star' },
      { value: 'false', label: 'daylight / other', color: '100,100,100,200', size: 3, shape: 'circle' },
    ])),

    // crossings: bold labeled dots
    crossings: qml(singleSymbolMarker('140,45,200,220', 4, 'diamond'), labeling('to_state')),

    // places: small circles labeled by name
    places: qml(singleSymbolMarker('50,50,50,200', 2, 'circle'), labeling('name')),

    // pois: categorized by kind
    pois: qml(categorizedMarker('kind', [
      { value: 'viewpoint', label: 'viewpoint', color: '0,150,200,220', size: 3.5, shape: 'triangle' },
      { value: 'peak', label: 'peak', color: '100,50,0,220', size: 3.5, shape: 'triangle' },
      { value: 'historic', label: 'historic', color: '180,120,0,220', size: 3, shape: 'pentagon' },
      { value: 'fuel', label: 'fuel', color: '40,40,40,200', size: 2.5, shape: 'square' },
    ])),

    // roads: categorized by highway class
    roads: qml(categorizedLine('highway', [
      { value: 'motorway', label: 'motorway', color: '40,40,40,220', width: 1.6 },
      { value: 'trunk', label: 'trunk', color: '70,70,70,220', width: 1.3 },
      { value: 'primary', label: 'primary', color: '120,120,120,220', width: 1.0 },
      { value: 'secondary', label: 'secondary', color: '160,160,160,220', width: 0.8 },
      { value: 'tertiary', label: 'tertiary', color: '190,190,190,200', width: 0.6 },
      { value: 'unclassified', label: 'unclassified', color: '210,210,210,180', width: 0.4 },
      { value: 'residential', label: 'residential', color: '225,225,225,180', width: 0.3 },
    ])),

    // optimal_routes: subtle gray so actual route pops on top
    optimal_routes: qml(singleSymbolLine('120,120,120,180', 0.6)),

    // toots: bold purple circles, labeled with the numeric index
    toots: qml(singleSymbolMarker('99,100,255,240', 4.5, 'circle'), labeling('index')),

    // all / stages / days: single-symbol default. Users will typically re-style by stage or day.
    all: qml(singleSymbolLine('31,120,180,230', 1.2)),
    stages: qml(singleSymbolLine('31,120,180,230', 1.2)),
    'days-merged': qml(singleSymbolLine('31,120,180,230', 1.4)),
  };
}

// ═══ filesystem helpers ═══
function writeIf(path, content) {
  writeFileSync(path, content);
}

// Drop a .qml next to <geojsonBase>.geojson only if that geojson exists —
// i.e. the user actually produced that layer. Avoids orphan .qml files.
function maybeAttach(template, outDir, geojsonBase) {
  const gj = join(outDir, `${geojsonBase}.geojson`);
  if (!existsSync(gj)) return false;
  writeIf(join(outDir, `${geojsonBase}.qml`), template);
  return true;
}

// Per-stage / per-day layers live in subdirectories with one .geojson per
// stage. Write the same template alongside each so QGIS styles every file
// identically on drag-drop.
function distributeToDir(template, outDir, subdir) {
  const d = join(outDir, subdir);
  if (!existsSync(d)) return 0;
  let n = 0;
  for (const f of readdirSync(d)) {
    if (extname(f).toLowerCase() !== '.geojson') continue;
    const base = basename(f, '.geojson');
    writeIf(join(d, `${base}.qml`), template);
    n++;
  }
  return n;
}

// ═══ public API ═══

/**
 * Write every starter .qml into `outDir` (and its stage subdirectories) so
 * QGIS applies symbology automatically when the user drags the GeoJSONs in.
 *
 * Effects:
 *   - writes `<outDir>/styles/*.qml` — full catalog for later Load-style.
 *   - for each top-level pipeline layer whose .geojson exists, drops a
 *     sibling `.qml` next to it.
 *   - distributes per-stage style into each .geojson under
 *     stages/, days/, hours/, days-merged/.
 *   - writes a short README.txt inside styles/ explaining the convention.
 *
 * Idempotent: existing .qml files are overwritten with the current defaults.
 * Callers who hand-tuned a style should save it outside of outDir.
 *
 * @param {string} outDir  absolute path to the pipeline's output directory
 * @returns {void}
 */
export function writeStarterStyles(outDir) {
  const tpl = stylesByLayer();
  const stylesDir = join(outDir, 'styles');
  mkdirSync(stylesDir, { recursive: true });
  for (const [name, content] of Object.entries(tpl)) {
    writeIf(join(stylesDir, `${name}.qml`), content);
  }

  // Attach directly to sibling geojson files so QGIS auto-loads on drag.
  maybeAttach(tpl.all, outDir, 'all');
  maybeAttach(tpl.stops, outDir, 'stops');
  maybeAttach(tpl.speedbins, outDir, 'speedbins');
  maybeAttach(tpl.markers, outDir, 'markers');
  maybeAttach(tpl.media, outDir, 'media');
  maybeAttach(tpl.crossings, outDir, 'crossings');
  maybeAttach(tpl.places, outDir, 'places');
  maybeAttach(tpl.pois, outDir, 'pois');
  maybeAttach(tpl.roads, outDir, 'roads');
  maybeAttach(tpl.optimal_routes, outDir, 'optimal_routes');
  maybeAttach(tpl.toots, outDir, 'toots');

  // Directory-based layers: one .qml per .geojson.
  distributeToDir(tpl.stages, outDir, 'stages');
  distributeToDir(tpl.stages, outDir, 'days');
  distributeToDir(tpl.stages, outDir, 'hours');
  distributeToDir(tpl['days-merged'], outDir, 'days-merged');

  // Quick README so future-you knows what to click.
  writeIf(join(stylesDir, 'README.txt'),
`moto-gpx starter styles
-----------------------
These .qml files are QGIS style definitions. Any GeoJSON file in this output
with a sibling .qml of the same basename is auto-styled by QGIS on drag-drop.

If you want to swap a style: right-click layer > Properties > Style > Load style,
and pick one from this styles/ folder.

Tuned attributes:
  speedbins    Categorized by 'speed_bin'  (slow/moderate/fast/highway)
  stops        Categorized by 'kind'       (rest tiers + overnight star)
  markers      Categorized by 'kind'       (stage/day start/end + labels)
  media        Categorized by 'is_golden_hour'
  crossings    Single symbol, label from 'to_state'
  places       Single symbol, label from 'name'
  pois         Categorized by 'kind'
  roads        Categorized by 'highway'
  optimal_routes  Subtle gray so your actual track pops on top.

To re-style per-stage or per-day layers by stage/day, open Properties > Style
> Categorized > Column: stage (or day).
`);
}
