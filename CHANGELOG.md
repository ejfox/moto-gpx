# Changelog

## [0.5.0] — 2026-04-21

Built-for-decades pass. Every module under `src/` now has:

- A module-level JSDoc contract header describing its role in the pipeline, its invariants, its external dependencies, and a roster of exports.
- `@typedef` declarations for the recurring data shapes (`Trkpt`, `Stage`, `MediaItem`, `BBox`) so the JSDoc types compose cleanly across files.
- Section banners (`═══ constants ═══`, `═══ private helpers ═══`, `═══ public API ═══`) to make each file scannable at a glance.
- Named constants for every magic threshold — with a comment explaining the "why" (e.g. `MAX_PLAUSIBLE_SPEED_MPS = 134`, `STRAIGHT_BEARING_TOL_DEG = 8`, `OVERNIGHT_MS = 6 hours`), so a future reader never wonders "why this exact number?"
- JSDoc on every exported function: summary, longer context for non-trivial functions, params, returns, and an example where useful.
- Algorithm-level comments on the trickier bits (fastest-mile two-pointer sliding window, biggest-climb max-minus-running-min, lateral-G from 3-point curvature, speed-window smoothing, etc.) explaining the math and the reason for each choice.
- For HTTP-based enrichments (weather / osm / routes / mastodon), an inline comment at the top of each file documenting the exact external API contract we depend on — so if that API breaks or moves in year 7, the future maintainer knows exactly what we expected.

### Added (features, not just docs)

- `--mastodon @user@instance.social` flag and `MOTO_GPX_MASTODON` environment variable — writes `toots.geojson` with each public toot placed at the interpolated GPS position you were at when you posted. Shows up as numbered circles on the preview map and as a chronological list in the superlatives banner.

## [0.4.1] — 2026-04-21

### Added

- **`--svg` flag (default on):** every run now writes `preview-map.svg` and `preview-elevation.svg` to the output folder. Map includes the track, stage start/end markers, town labels (from places.geojson if OSM enrichment ran), scale bar, and annotated markers for peak elevation, top speed, and peak cornering G. Elevation profile shows the full distance-vs-elevation curve with peak/trough labeled.
- New dep: **`d3`** (v7) — used by `src/svg.js` for Mercator projection with `fitExtent`, and scales/shapes for the elevation profile. First runtime dep in the tool — the tradeoff was worth it for correct projection math.

### Fixed

- **`biggest_climb` / `biggest_descent` / `highest_point` / `lowest_point` in superlatives** were reporting the first trkpt's elevation as both extremes due to an object-property shadowing bug (`p.ele > high.ele` where the stored key was `ele_m`). Now correctly tracks true extremes.
- **`longest_descent`** was accumulating descents across multiple peaks for a single reported drop. Renamed to `biggest_descent` and computed symmetrically to `biggest_climb` (max drop from running max).

## [0.4.0] — 2026-04-21

Every run now ends with a "superlatives" banner — the fun facts you'd want in
a year-in-review, printed to console and stashed in `stats.json.superlatives`.

### Added

- **`src/superlatives.js`** — GPS-derived fun stats computed at the end of every run:
  - `fastest_mile` — best 1-mile split with pace and coordinates
  - `longest_nonstop` — longest continuous moving streak (minutes + miles)
  - `highest_point` / `lowest_point` — elevation extremes with lat/lon/time
  - `biggest_climb` / `biggest_descent` — biggest single climb and drop with start/peak + avg grade
  - `steepest_grade` — steepest ~200m segment
  - `longest_straight` — longest run where cumulative heading change < 8°
  - `total_turning_deg` / `turns_per_mile` — twistiness index
  - `compass_extremes` — furthest N/S/E/W points with timestamps
  - `speed_bucket_pct` — % of time in slow/moderate/fast/highway
  - `time_of_day_pct` — morning/afternoon/evening/night distribution
  - `performance` telemetry block: top speed (with lat/lon/time), 0-60 time, time above 60 mph, peak cornering G (v²/r via 3-point curvature), hardest braking G, biggest launch G, smoothness score 1-10
  - `weather` superlatives (hottest/coldest/windiest stage) when `--enrich weather` ran
  - `places_traversed` — chronological "town signs you passed" list from `places.geojson` when `--enrich osm` ran
  - `equivalent_to` — distance in football fields, marathons, Empire State Buildings climbed, Eiffel Towers, Kilimanjaros
- `--no-superlatives` to skip the banner/stat computation.

### Fixed

- Unified max-speed smoothing window between core stats (`src/gpx.js`) and telemetry (`src/superlatives.js`) — both now use a 5-second sliding window, so the summary's "max X mph" matches `superlatives.performance.top_speed`.

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
