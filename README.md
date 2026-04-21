# moto-gpx

**A zero-dependency Node.js CLI that turns a folder of GPX files into a stack
of map-ready GeoJSON layers for hand-making dope QGIS maps of multi-day
motorcycle trips.**

```
moto-gpx ~/trips/big-sur --media ~/trips/big-sur --enrich all --dem --out ./out
```

Does all the data prep for you — tracks, rest stops, speed-binned segments,
photo markers, weather per stage, OSM road names, state crossings, SRTM
hillshade — so when you open QGIS, everything you need is already a layer
with pre-loaded symbology. You just style.

---

## Table of contents

- [Quick start](#quick-start)
- [Install](#install)
- [What it does](#what-it-does)
- [CLI reference](#cli-reference)
- [Output structure](#output-structure)
- [Docs](#docs)
- [Design](#design)
- [License](#license)

---

## Quick start

```sh
# Install (one-time)
git clone https://github.com/ejfox/moto-gpx.git
cd moto-gpx && npm link

# Run on a trip folder
moto-gpx ~/trips/bigsur --media ~/trips/bigsur --out ./bigsur-out

# Everything on, DEM included
moto-gpx ~/trips/bigsur --media ~/trips/bigsur --enrich all --dem --dem-contour 100 --out ./bigsur-out
```

Then open QGIS and drag `bigsur-out/` onto the canvas. Styles auto-load from
the sibling `.qml` files. See [docs/QGIS.md](./docs/QGIS.md) for the full
hand-cartography workflow.

---

## Install

Needs **Node 18+**. Nothing to npm-install — the tool is zero-runtime-dep.

```sh
git clone https://github.com/ejfox/moto-gpx.git
cd moto-gpx
npm link
```

Optional external binaries, each only used when you opt in to its feature:

| Binary | When you need it | Install |
|---|---|---|
| `exiftool` | `--media` flag | `brew install exiftool` |
| GDAL (`gdalbuildvrt`, `gdaldem`, `gdal_contour`) | `--dem` flag | `brew install gdal` |

See [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) if GDAL gives you a
`libpoppler` error (common Homebrew issue).

---

## What it does

Given a folder of `.gpx` files (with optional sibling photos/videos):

1. **Walks** the folder recursively for `.gpx` files
2. **Parses** every `<trkpt>`, merges them into one sorted timeline
3. **Dedupes** identical `(time, lat, lon)` triples — you can have overlapping logs from phone + Garmin and it Just Works
4. **Splits into stages** wherever there's a time gap bigger than `--break` minutes (default 20) — this is how morning / lunch / afternoon become separate features, no dotted lines across rest stops
5. **Buckets** into days, hours, and per-stage views
6. **Emits QGIS-prep layers:** stops (labeled by duration class), speed-binned line chunks, stage + day start/end markers with pre-written labels, one-line-per-day merged view
7. **Optionally ingests** photos/videos via `exiftool`, placing each on the map by GPS when present or interpolated from the track by timestamp when not
8. **Optionally enriches** with weather, OSM road/place/POI data, state-border crossings, sun position per photo, and OSRM "what you should've done" route comparisons
9. **Optionally fetches** SRTM elevation tiles from AWS and stitches them into a seamless QGIS-ready VRT + hillshade + contour lines
10. **Drops QGIS `.qml` style files** next to every layer so symbology auto-loads on drag-drop

Everything is opt-in except the core track layers. Nothing calls out to the
network unless you pass `--enrich`.

---

## CLI reference

### Core flags

| Flag | Default | Meaning |
|---|---|---|
| `<folder>` | *required* | Folder containing `.gpx` files (recursively walked) |
| `--out <dir>` | `./moto-out` | Output directory |
| `--split <mode>` | `all` | `day` \| `hour` \| `stage` \| `all` |
| `--break <minutes>` | `20` | Gap threshold to start a new stage |
| `--min-points <n>` | `10` | Drop stages with fewer points (kills GPS noise) |
| `--simplify <meters>` | `0` | Douglas-Peucker tolerance, 0 = off |
| `--tz <offset>` | local | Hours from UTC for day/hour bucketing |
| `--name <string>` | folder basename | Trip name, stamped into every feature |
| `-h`, `--help` | — | Show help |

### QGIS prep layers (on by default, `--no-<name>` to skip)

| Flag | What you get |
|---|---|
| `--stops` | `stops.geojson` — rest-stop + overnight Points |
| `--speedbins` | `speedbins.geojson` — line chunks tagged `slow/moderate/fast/highway` |
| `--markers` | `markers.geojson` — stage + day start/end Points with pre-written labels |
| `--days-merged` | `days-merged/*.geojson` — one unbroken LineString per day |
| `--styles` | `<layer>.qml` next to each GeoJSON for auto-styling in QGIS |

### Media

| Flag | Default | Meaning |
|---|---|---|
| `--media <dir>` | off | Ingest JPG/HEIC/MP4/MOV via `exiftool` |
| `--media-tz <offset>` | same as `--tz` | For naive EXIF timestamps without embedded offset |

### DEM (requires GDAL)

| Flag | Default | Meaning |
|---|---|---|
| `--dem` | off | Fetch AWS Terrain Tiles, stitch into seamless `trip.vrt` |
| `--dem-buffer <pct>` | `20` | Bbox padding percent |
| `--dem-hillshade` | on with `--dem` | Pre-render shaded relief GeoTIFF |
| `--no-dem-hillshade` | — | Skip the hillshade step |
| `--dem-contour <m>` | `0` (off) | Emit contour lines every N meters as GeoJSON |

### Enrichments (opt-in, network)

```
--enrich <comma-list>
```

| Token | What lands | API |
|---|---|---|
| `weather` | per-stage weather on `stage.stats` + `weather_timeline.json` | Open-Meteo historical |
| `osm` | `roads.geojson`, `places.geojson`, `pois.geojson` + per-stage road summary | Overpass |
| `routes` | `optimal_routes.geojson` with `extra_distance_pct` per stage | OSRM public |
| `crossings` | `crossings.geojson` — state/province transitions | local (Natural Earth data bundled) |
| `sun` | mutates `media.geojson` with altitude/azimuth/is_golden_hour | local math |
| `all` | shorthand for all of the above | — |

All enrichments retry once on rate-limit and degrade to "skip" on persistent
failure — the run never aborts because one API is down.

### Recipes

**Multi-day trip, everything on:**
```sh
moto-gpx ~/trips/big-sur --media ~/trips/big-sur --enrich all --dem --dem-contour 100 --out ./out
```

**Just the tracks, no network — quick QGIS glance:**
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

**Custom timezone (e.g. logs in UTC but you want PT day boundaries):**
```sh
moto-gpx ./trip --tz -7
```

---

## Output structure

```
out/
├── all.geojson              every stage as a LineString (summary layer)
├── stats.json               trip totals + per-stage breakdown + enrichments
├── stages/                  one LineString per stage (break-delimited)
├── days/                    one file per day, all stages within
├── days-merged/             ONE unbroken LineString per day (overview view)
├── hours/                   per-hour slices (rarely needed; skip with --no-hours)
├── stops.geojson            rest / long-rest / overnight Points at each break
├── speedbins.geojson        ~60s LineString chunks, tagged by speed bucket
├── markers.geojson          stage + day start/end Points, pre-labeled
├── media.geojson            photos + videos placed on the map
├── crossings.geojson        state/province transition Points       (--enrich crossings)
├── places.geojson           towns along the route                  (--enrich osm)
├── roads.geojson            OSM ways you rode, by highway class    (--enrich osm)
├── pois.geojson             viewpoints, peaks, fuel, historic      (--enrich osm)
├── optimal_routes.geojson   OSRM "what you should've done"         (--enrich routes)
├── weather_timeline.json    hourly weather per stage region        (--enrich weather)
├── dem/
│   ├── tiles/               cached SRTM .hgt (reused across runs)  (--dem)
│   ├── trip.vrt             seamless virtual raster — drag into QGIS
│   ├── trip-hillshade.tif   pre-rendered shaded relief
│   └── trip-contours.geojson  (with --dem-contour)
└── styles/                  full QGIS .qml templates + a README
```

Every `.geojson` also gets a sibling `.qml` — drag onto QGIS and the
symbology auto-loads. CRS is plain **WGS 84 (EPSG:4326)** throughout, no
reprojection needed.

Every run also ends with a **superlatives** banner — fastest mile, biggest
climb, peak cornering G, time above 60 mph, towns you passed, how many
Empire State Buildings worth of climbing. Also stashed in
`stats.json.superlatives` for later. Pass `--no-superlatives` to skip.

See [docs/LAYERS.md](./docs/LAYERS.md) for the exact property schema of every
layer and what each field means.

---

## Docs

Deeper references in [`docs/`](./docs):

| File | Contents |
|---|---|
| [LAYERS.md](./docs/LAYERS.md) | Every layer, every property, with example feature JSON |
| [QGIS.md](./docs/QGIS.md) | Step-by-step workflow for hand-making a trip map |
| [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | Common issues (GDAL, exiftool, rate limits) and fixes |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the modules fit together; how to extend |
| [CHANGELOG.md](./CHANGELOG.md) | Version history |

---

## Design

- **Zero runtime dependencies.** Everything is Node stdlib + global `fetch`. `exiftool` and GDAL are the only external binaries, and only when you opt in to the features that need them. No `npm install` needed to run.
- **Modular.** Each subsystem under `src/` is independent and swappable. If you don't like the Open-Meteo wiring, swap `src/enrich/weather.js`.
- **WGS 84 throughout.** No reprojection required on either end.
- **Fail soft.** Network enrichments retry once and then degrade to "skip this stage." Missing GDAL degrades to "keep the raw tiles, skip the VRT." Missing exiftool is caught early with a friendly `brew install` hint.

---

## License

MIT — see [LICENSE](./LICENSE).
