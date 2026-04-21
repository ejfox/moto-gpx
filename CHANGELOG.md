# Changelog

## [0.3.1] — 2026-04-21

Bug fixes surfaced by testing against a real Garmin file (5689-point Hudson
Valley loop ride, Sept 2021).

### Fixed

- **`max_speed_mph` false spikes from GPS jitter.** Adjacent 1s-interval GPS samples with a 50m coordinate hiccup were reporting as 100+ mph. Now computed over a 5-second sliding window so single-point jitter gets averaged across 3–5 real samples. Real sustained peaks (e.g. a brief highway pass) still register.
- **OSRM routes on loop rides.** A 56-mile ride that starts and ends in the same driveway was routing start → end via 13 meters, producing `extra_distance_pct: 707752`. Now: when start/end are within 200m we route via the trkpt farthest from start as a waypoint. New feature properties: `is_loop: bool`, `waypoint: [lon, lat] | null`.
- **Misleading DEM summary.** Summary previously printed `dem/ (N tiles, vrt)` even when `gdalbuildvrt` failed. Now only includes components that actually built.
- **Empty media folders no longer produce empty `media.geojson`.** If `--media <dir>` contains no locatable files, we skip the file and print a friendly notice.

## [0.3.0] — 2026-04-21

Big jump. Full "mise en place" workflow for hand-making motorcycle trip maps
in QGIS.

### Added

- **QGIS-prep layers (on by default):**
  - `stops.geojson` — rest stops and overnights as labeled Points, categorized by duration (short-rest / rest / long-rest / overnight)
  - `speedbins.geojson` — LineString chunks (~60s each) tagged by speed bucket (slow / moderate / fast / highway) for Categorized symbology
  - `markers.geojson` — stage + day start/end Points with pre-written labels like `"Day 2 start — 09:14"`
  - `days-merged/*.geojson` — one unbroken LineString per day (overview view, distinct from stage-split per-day layer)
  - `styles/*.qml` — QGIS style templates auto-distributed as `<layer>.qml` sibling files for drag-drop auto-load
- **DEM subsystem (`--dem`, requires GDAL):**
  - Fetches 1° SRTM tiles from AWS Terrain Tiles (free, no auth, global)
  - Caches tiles in `out/dem/tiles/` across runs
  - Stitches via `gdalbuildvrt` into a seamless `trip.vrt`
  - Optional `trip-hillshade.tif` via `gdaldem hillshade -s 111120` (WGS 84-correct scale)
  - Optional `trip-contours.geojson` via `gdal_contour` at configurable interval
- **Opt-in enrichments (`--enrich <list>` or `--enrich all`):**
  - `weather` — Open-Meteo historical archive, per-stage temp/humidity/wind/precip/conditions + full hourly `weather_timeline.json`
  - `osm` — Overpass for roads/places/POIs, with per-stage road name and highway-class attribution
  - `routes` — OSRM public endpoint for "what a car would've done" LineString per stage, with `extra_distance_pct`
  - `crossings` — state/province transition Points vs Natural Earth 50m (US/CA/MX bundled in `data/states.geojson`)
  - `sun` — sun altitude/azimuth/is_golden_hour annotation on media features (NOAA formulas, inline)
- **Module refactor** — code split from one file into `src/gpx.js`, `src/media.js`, `src/layers.js`, `src/dem.js`, `src/qml.js`, and `src/enrich/{weather,osm,routes,crossings,sun}.js`
- **`data/states.geojson`** — bundled Natural Earth 50m US/CA/MX admin-1 polygons, simplified to ~300KB
- **`--name`** — explicit trip name flag (falls back to folder basename)
- **`--no-<layer>`** — skip any default-on layer
- **Docs** — `docs/LAYERS.md` (full schema reference), `docs/QGIS.md` (step-by-step workflow), `docs/TROUBLESHOOTING.md`, `docs/ARCHITECTURE.md`, this CHANGELOG

### Changed

- Moving-time filter no longer rejects 5-minute GPS sample intervals (stage splitting already handles break gaps, so any in-stage dt is valid movement).
- `stats.json` structure now includes per-stage enrichment data inline (`stage.weather`, `stage.roads`) plus a `media` counts object and `enrichments` section.

### External dependencies

Zero runtime deps preserved. External binaries are optional:

- `exiftool` — needed only for `--media`
- GDAL (`gdalbuildvrt`, `gdaldem`, `gdal_contour`) — needed only for `--dem`

Both degrade gracefully when missing.

---

## [0.2.0] — 2026-04-20

### Added

- **Media ingest (`--media <dir>`)** via `exiftool`:
  - JPG/HEIC/PNG/MP4/MOV all supported (anything exiftool reads)
  - Three placement strategies: direct EXIF GPS, track-interpolated from timestamp, or GPS-only
  - Each feature tagged with stage/day context, `match_offset_sec` to nearest trkpt
- **`--media-tz <offset>`** for naive EXIF timestamps

---

## [0.1.0] — 2026-04-20

Initial release.

### Added

- Walk a folder for `.gpx` files
- Parse, merge, sort, dedupe by time
- Split into stages on break-gap (default 20min)
- Emit `all.geojson`, `stages/`, `days/`, `hours/`, `stats.json`
- Per-stage stats: distance, duration, moving time, max/avg speed, elevation gain/loss
- Options: `--split`, `--break`, `--min-points`, `--simplify`, `--tz`, `--out`, `--name`
