# Architecture

How moto-gpx is organized, how the pieces fit together, and how to extend it.

---

## Repo layout

```
moto-gpx/
├── moto-gpx.js              CLI entry — arg parsing + orchestration
├── package.json
├── README.md
├── LICENSE
├── CHANGELOG.md
├── data/
│   └── states.geojson       Natural Earth 50m US+CA+MX, simplified (~300KB)
├── src/
│   ├── gpx.js               GPX parsing, geo helpers, stage splitting, stats
│   ├── media.js             exiftool ingestion + interpolation
│   ├── layers.js             QGIS-prep layers: stops, speedbins, markers, days-merged
│   ├── dem.js               AWS Terrain Tiles + GDAL wrangling
│   ├── qml.js               QGIS .qml style generation
│   └── enrich/
│       ├── weather.js       Open-Meteo historical archive
│       ├── osm.js           Overpass roads / places / POIs
│       ├── routes.js        OSRM suggested-route comparison
│       ├── crossings.js     State/province transitions (ray-cast PIP)
│       └── sun.js           Sun altitude/azimuth (NOAA formulas)
└── docs/
    ├── LAYERS.md
    ├── QGIS.md
    ├── TROUBLESHOOTING.md
    └── ARCHITECTURE.md      (this file)
```

---

## Data flow

```
   .gpx files                   photos/videos           optional APIs
       │                              │                       │
       ▼                              ▼                       ▼
   src/gpx.js                    src/media.js       src/enrich/{weather,osm,
       │                              │              routes,crossings,sun}
       │                              │                       │
  parse → sort → dedupe          exiftool → interp            │
       │                              │                       │
       └─────────┬────────────────────┴───────────────────────┘
                 │
                 ▼
          moto-gpx.js (orchestrator)
                 │
         ┌───────┴─────────────────────────┐
         │                                 │
    src/layers.js                     src/dem.js (optional)
         │                                 │
    stops, speedbins,                 tiles → VRT →
    markers, days-merged              hillshade, contours
         │                                 │
         └────────┬────────────────────────┘
                  │
                  ▼
             src/qml.js
         (sibling .qml files)
                  │
                  ▼
            output folder
                  │
                  ▼
                QGIS
```

All mutations on `perStage` stage objects happen synchronously in
`moto-gpx.js`. Enrichment modules mutate `stage.stats.weather`,
`stage.stats.roads`, etc. in place; this is why the order of operations
matters — enrichments run *before* `stats.json` is written.

---

## Module contracts

### `src/gpx.js`

Pure functions. No I/O, no side effects. The core primitives.

| Export | Signature | Notes |
|---|---|---|
| `parseGpx(xml)` | `(string) → point[]` | Tolerant regex parser, handles both self-closing and block `<trkpt>` |
| `haversine(a, b)` | `({lat,lon}, {lat,lon}) → meters` | |
| `bearing(a, b)` | `({lat,lon}, {lat,lon}) → degrees` | Initial bearing, 0=N, CW |
| `bboxOf(points)` | `(point[]) → [minLon, minLat, maxLon, maxLat] \| null` | |
| `simplifyPoints(pts, tol)` | `(point[], meters) → point[]` | Douglas-Peucker in local equirect meters |
| `splitStages(pts, gapMs)` | `(point[], ms) → point[][]` | Splits on time gaps |
| `segmentStats(pts)` | `(point[]) → stats` | Distance, moving time, speed, elevation gain/loss, bbox |
| `toLineFeature(pts, props)` | helper | LineString feature with optional Z |
| `dayKey(time, tzH)` | `(ms, hours) → "YYYY-MM-DD"` | |
| `hourKey(time, tzH)` | `(ms, hours) → "YYYY-MM-DD_HH"` | |

**point shape:** `{ lat: number, lon: number, ele: number|null, time: number|null }` where `time` is ms since epoch.

### `src/media.js`

Shells to `exiftool` and builds on `src/gpx.js` helpers.

| Export | Signature | Notes |
|---|---|---|
| `parseExifTime(str, tzFallbackH)` | `(string, hours) → ms \| null` | Handles `"YYYY:MM:DD HH:MM:SS"` ± offset |
| `ingestMedia(dir, tzH)` | `(path, hours) → MediaItem[]` | Recursive scan via `exiftool -r` |
| `nearestTrkptIndex(pts, t)` | binary search | |
| `interpolateAt(pts, t)` | linear interp between bracketing trkpts | Returns `{interpolated: true}` when synthesized |

### `src/layers.js`

QGIS-prep helpers. All return arrays of GeoJSON features.

| Export | Signature | Output |
|---|---|---|
| `detectStops(pts, gapMs, tzH, trip)` | | `Point[]` — one per break |
| `speedBinSegments(pts, stageIdx, day, trip)` | | `LineString[]` — ~60s chunks with `speed_bin` |
| `startEndMarkers(perStage, tzH, trip)` | | `Point[]` — 4 per stage+day |
| `mergedDayLines(deduped, tzH, trip, simplify)` | | `LineString[]` — one per day |

### `src/dem.js`

External: `fetch` (tiles), `execFileSync` (GDAL).

| Export | Signature | Notes |
|---|---|---|
| `fetchDEM(bbox, outDir, opts)` | `async → info \| null` | Caches tiles, skips missing ones, degrades gracefully without GDAL |

### `src/qml.js`

No I/O beyond writes. Template strings for QGIS XML.

| Export | Signature | Notes |
|---|---|---|
| `writeStarterStyles(outDir)` | `(path) → void` | Writes `styles/*.qml` + auto-distributes sibling `.qml` next to matching `.geojson` |

### `src/enrich/*`

All follow the same pattern: async function, takes `perStage` + other
trip data, mutates `perStage[].stats` in place and/or writes a sidecar
GeoJSON/JSON file. All are fail-soft — they log and skip on error.

| Module | Export |
|---|---|
| `enrich/weather.js` | `fetchWeatherForStages(perStage, outDir)` |
| `enrich/osm.js` | `fetchOSM(bbox, points, perStage, outDir, trip)` |
| `enrich/routes.js` | `fetchOSRMRoutes(perStage, outDir, trip)` |
| `enrich/crossings.js` | `computeCrossings(points, tzH, trip)` |
| `enrich/sun.js` | `attachSunPosition(features)` |

---

## Extending

### Adding a new enrichment

1. Create `src/enrich/<name>.js` exporting an `async` function that takes
   what it needs from `perStage` / `points` / `bbox`.
2. Mutate `perStage[].stats.<name>` in place if the data is per-stage,
   or write a `<name>.geojson` / `<name>.json` to `outDir`.
3. Import in `moto-gpx.js` and add an `opts.enrich.has('<name>')` branch.
4. Add `<name>` to the `--enrich all` expansion in arg parsing.
5. Add a QML style in `src/qml.js` if the enrichment emits a new GeoJSON.
6. Document in `docs/LAYERS.md`.

Keep to the fail-soft convention: `try { await work(); } catch (e) { console.error(...); }` — don't throw and kill the whole run because one
API was flaky.

### Adding a new external data source

If you need a fixed dataset (like `data/states.geojson`):

1. Fetch once, simplify to under ~500KB, commit to `data/`.
2. Load at module-top with `fileURLToPath(new URL('../../data/<file>', import.meta.url))`.
3. Precompute per-feature indexes (bboxes) at load time for fast lookups.

### Adding a new output layer (derived from existing data)

If it's something like "POIs within 500m, but clustered" — a derivation of
existing layers:

1. Add a function to `src/layers.js`.
2. Wire a `--<name>` flag in `moto-gpx.js` args (on by default, with a
   `--no-<name>` counterpart following the existing convention).
3. Add a QML template in `src/qml.js`.

### Parsing a new upstream format (DJI SRT, GPMF, etc)

These belong as standalone modules in `src/`. The clean path:

1. Create `src/<format>.js` that parses files and returns the same
   `point[]` shape that `src/gpx.js` emits.
2. In `moto-gpx.js`, after the `.gpx` walk, also walk for the new
   extension and concatenate the parsed points into the same timeline.
3. Sort + dedupe already handles the merged stream — no other changes
   needed downstream.

---

## Design principles

1. **Zero runtime deps.** No `npm install` required to run. Stdlib + `fetch` only.
2. **Everything is opt-in except the tracks.** `--enrich`, `--media`, `--dem` all explicit. Default run hits zero external APIs.
3. **Fail soft on network.** One API's outage never aborts the whole run. Log + skip.
4. **Cache what's expensive.** DEM tiles cached in `dem/tiles/`. Re-runs on the same bbox are free.
5. **WGS 84 throughout.** No CRS surprises; drop into QGIS and go.
6. **QGIS-native output.** `.qml` siblings auto-load on drag. No "now go configure symbology" step.
7. **Stateless, one-shot.** The CLI is invoke-and-exit. No daemons, no server, no config file. Every behavior is a flag.

---

## Testing / smoke

There's no formal test suite. The pattern:

1. Keep `/tmp/moto-fixture/*.gpx` as a 3-file, 36-point, 2-day fixture.
2. After any change, run:

   ```sh
   cd ~/code/moto-gpx
   rm -rf /tmp/moto-out
   node moto-gpx.js /tmp/moto-fixture --out /tmp/moto-out --tz -4 --media /tmp/moto-media --enrich crossings,sun
   ```

3. Eyeball the console summary + `jq` inspect the critical outputs:

   ```sh
   jq '.features | length' /tmp/moto-out/{stops,speedbins,markers}.geojson
   jq '.stage_breakdown[0]' /tmp/moto-out/stats.json
   ```

Network enrichments are stamp-expensive — run them manually against a
real trip folder when wiring something new.
