# moto-gpx

Dump a folder of GPX tracks (phone, Garmin, whatever), get back a stack of
layered GeoJSON ready to drag into QGIS for hand-cartography — tracks, rest
stops, speed-binned segments, per-day lines, photos, weather, OSM roads and
places, state crossings, sun position, an OSRM "what the car would've done"
comparison, and SRTM elevation data. All you do in QGIS is style.

Built for making dope maps of multi-day motorcycle trips.

```
moto-gpx ~/trips/big-sur --media ~/trips/big-sur --enrich all --dem --out ./out
```

```
moto-gpx: big-sur
  found 9 gpx files in ~/trips/big-sur
  merged → 14,328 points (22 dupes removed)
  split on 20min gaps → 17 stages, 14 kept (min 10 pts)
  exiftool scan: ~/trips/big-sur
    146 media files
    geotagged: 92 direct · 48 interpolated · 6 unlocated
  ☼ sun position on 146 media points
  ☁ weather: open-meteo per stage
  ◉ osm: overpass for roads, places, POIs
  ↣ routes: osrm suggested vs actual
  ⊢ state crossings
  ◬ DEM: AWS Terrain Tiles, buffer 20%

  big-sur
  612.8 mi / 986.2 km
  moving 14h23  /  wall 3d02
  max 94.1 mph  · avg moving 42.6 mph
  +18,240m / -17,930m
```

## Install

Node 18+ required. Optional externals: `exiftool` (media ingest), `gdal` (DEM).

```sh
git clone https://github.com/ejfox/moto-gpx.git
cd moto-gpx
npm link                         # puts `moto-gpx` on your PATH
brew install exiftool gdal       # optional, for --media and --dem
```

## What gets written

```
out/
├── all.geojson              every stage as a LineString (summary layer)
├── stages/                  one LineString per stage (break-delimited)
├── days/                    one file per day, all stages within
├── days-merged/             ONE LineString per day (unbroken, for overviews)
├── hours/                   per-hour slices
├── stops.geojson            Point per rest stop / overnight (labeled by kind)
├── speedbins.geojson        LineString per ~60s chunk, color by speed bucket
├── markers.geojson          stage/day start & end Points, pre-labeled
├── media.geojson            photos & videos placed directly, interpolated, or GPS-only
├── crossings.geojson        state/province Point at each transition
├── places.geojson           towns crossed, labeled by name       (--enrich osm)
├── roads.geojson            OSM ways you rode, by highway class  (--enrich osm)
├── pois.geojson             viewpoints, peaks, fuel, historic    (--enrich osm)
├── optimal_routes.geojson   what OSRM would've routed you         (--enrich routes)
├── weather_timeline.json    hourly weather per stage region       (--enrich weather)
├── dem/
│   ├── tiles/               cached SRTM .hgt files (reused across runs)
│   ├── trip.vrt             seamless virtual raster — drag into QGIS
│   ├── trip-hillshade.tif   pre-rendered shaded relief
│   └── trip-contours.geojson  (optional) elevation lines as vector
├── styles/                  QGIS .qml style templates for each layer
└── stats.json               trip totals, per-stage breakdown, per-stage enrichments
```

Every `.geojson` also gets a sibling `.qml` — drag onto QGIS and the symbology
auto-loads. CRS is plain WGS 84 (EPSG:4326), no reprojection.

## Options

### Core

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | `./moto-out` | Output directory |
| `--split <mode>` | `all` | `day` / `hour` / `stage` / `all` |
| `--break <minutes>` | `20` | Gap threshold to start a new stage |
| `--min-points <n>` | `10` | Drop stages with fewer points |
| `--simplify <meters>` | `0` | Douglas-Peucker tolerance, 0 = off |
| `--tz <offset>` | local | Hours from UTC for day/hour bucketing |
| `--name <string>` | folder basename | Trip name, stamped into every feature |

### QGIS prep layers (on by default, `--no-<name>` to skip)

| Flag | What you get |
|---|---|
| `--stops` | Rest stops as labeled Points (rest / long-rest / overnight) |
| `--speedbins` | Line chunks tagged `slow/moderate/fast/highway` — categorized color |
| `--markers` | Stage + day start/end Points with pre-written labels like "Day 2 start — 09:14" |
| `--days-merged` | ONE unbroken LineString per day |
| `--styles` | Drop-in `.qml` style files next to every layer |

### Media

| Flag | Default | Meaning |
|---|---|---|
| `--media <dir>` | — | Ingest JPG/HEIC/MP4/MOV via exiftool |
| `--media-tz <offset>` | same as `--tz` | For naive EXIF timestamps |

### DEM (needs GDAL)

| Flag | Default | Meaning |
|---|---|---|
| `--dem` | off | Fetch AWS Terrain Tiles, stitch into seamless VRT |
| `--dem-buffer <pct>` | `20` | Bbox padding percent |
| `--dem-hillshade` | on with `--dem` | Pre-render shaded relief TIFF |
| `--dem-contour <m>` | `0` (off) | Emit contour lines every N meters as GeoJSON |

### Enrichments (opt-in, network)

```sh
--enrich weather,osm,routes,crossings,sun
--enrich all
```

| Token | API | What lands |
|---|---|---|
| `weather` | Open-Meteo historical | `stage.weather` (temp, wind, conditions) + `weather_timeline.json` |
| `osm` | Overpass | `roads.geojson`, `places.geojson`, `pois.geojson`, `stage.roads` |
| `routes` | OSRM public | `optimal_routes.geojson` — "how you should've gone" per stage |
| `crossings` | local (Natural Earth data) | `crossings.geojson` — state/province transition Points |
| `sun` | local math | mutates `media.geojson` with altitude, azimuth, `is_golden_hour` |

All enrichments are zero-auth. Weather, OSM, and routes retry once on rate-limit and degrade to "skip this stage" rather than abort the whole run.

## Recipes

**Multi-day trip, everything on:**

```sh
moto-gpx ~/trips/big-sur --media ~/trips/big-sur --enrich all --dem --dem-contour 100 --out ./out
```

**Just the tracks, no network, for a quick QGIS glance:**

```sh
moto-gpx ./trip --out ./out
```

**City riding, tighter break detection:**

```sh
moto-gpx ./trip --break 10 --min-points 30 --enrich osm,weather
```

**Smaller files for the web:**

```sh
moto-gpx ./trip --simplify 2 --no-days-merged --no-hours
```

## QGIS workflow

1. Run moto-gpx.
2. Open QGIS, drag `out/` onto the canvas (or load layer-by-layer).
3. Styles auto-load from the sibling `.qml` files. Rearrange layers, hand-tune colors.
4. Drag `out/dem/trip-hillshade.tif` in as the bottom layer, lower its opacity.
5. Drag `out/dem/trip-contours.geojson` above the hillshade if you want labeled elevations.
6. Label `stops.geojson` by `kind`, `crossings.geojson` by `to_state`, `places.geojson` by `name`.
7. Compose & export.

## Media placement strategies

Three fallbacks in order:

1. **EXIF GPS + timestamp** → placed directly, matched to the containing stage.
2. **Timestamp only** → linearly interpolated along the track at that instant. Elevation too.
3. **GPS only (no time)** → placed on the map, but `stage`/`day` are null.

Anything with neither is reported but not emitted.

## Known limits

- Helmet cam MP4s contribute one representative point per file (QuickTime location atom).
  Full GPMF telemetry-track merging is not yet implemented.
- DJI `.SRT` per-frame sidecars aren't parsed yet.
- EXIF timestamps without an embedded offset are interpreted with `--media-tz` (defaults to `--tz`).
- OSRM public endpoint is rate-limited on huge trips; `--enrich routes` can be slow if you have 50+ stages.
- States layer ships US / CA / MX from Natural Earth 50m. Europe / elsewhere would need an expansion to the asset.

## Design

- Zero runtime dependencies. Everything is Node stdlib + `fetch`. `exiftool` and GDAL are the only external binaries, and only when you opt into the features that need them.
- Modules under `src/` so each subsystem is independent and swappable. `src/enrich/*.js` are all opt-in and safe to skip.
- CRS is WGS 84 throughout. Hillshade is rendered in degrees with `-s 111120` so QGIS renders it correctly without projecting.

## License

MIT
