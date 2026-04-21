# Layer reference

Every layer moto-gpx emits, its geometry type, every property on each feature,
and an example. CRS is **WGS 84 (EPSG:4326)** throughout. All times are
ISO 8601 UTC unless a field name ends in `_local`.

**Always emitted:** `all.geojson`, `stages/`, `days/`, `hours/`, `stats.json`

**Default-on, skip with `--no-<name>`:** `stops`, `speedbins`, `markers`, `days-merged`, `styles`

**Opt-in:** `media` (`--media`), `crossings` / `places` / `roads` / `pois` / `optimal_routes` / `weather_timeline` (`--enrich ...`), `dem/` (`--dem`)

---

## Table of contents

- [Track layers](#track-layers) — `all`, `stages`, `days`, `days-merged`, `hours`
- [QGIS prep layers](#qgis-prep-layers) — `stops`, `speedbins`, `markers`
- [Media](#media) — `media.geojson`
- [Enrichment layers](#enrichment-layers) — `crossings`, `places`, `roads`, `pois`, `optimal_routes`, `weather_timeline`
- [DEM](#dem) — `dem/*`
- [stats.json](#statsjson)
- [Property reference cheat sheet](#property-reference-cheat-sheet)

---

## Track layers

All track layers are **LineString** features. The geometry coordinates are
`[lon, lat]` or `[lon, lat, ele]` — if every trkpt on the stage has elevation
data, it's included.

### `all.geojson`

Every stage as a single LineString feature. The summary layer for a trip
overview.

```jsonc
{
  "type": "FeatureCollection",
  "properties": { "trip": "big-sur" },
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "LineString", "coordinates": [[-74.0, 41.7, 100], ...] },
      "properties": {
        "stage": 0,                         // integer index, chronological
        "day": "2025-06-01",                // local date of stage start
        "trip": "big-sur",
        "points": 1832,                     // trkpt count
        "start_iso": "2025-06-01T13:14:22Z",
        "end_iso":   "2025-06-01T16:47:03Z",
        "duration_min": 212.7,              // wall time first → last trkpt
        "moving_min": 178.4,                // time spent at >0.5 m/s
        "distance_km": 142.31,
        "distance_mi": 88.43,
        "max_speed_mph": 78.2,
        "max_speed_kmh": 125.9,
        "avg_moving_mph": 47.8,
        "ele_gain_m": 1240,                 // cumulative +dz
        "ele_loss_m": 1190,                 // cumulative -dz
        "bbox": [-74.52, 41.48, -73.91, 42.18],
        // if --enrich weather was used:
        "weather": {
          "temp_f": 72, "humidity_pct": 61, "precipitation_mm": 0,
          "weather_code": 2, "wind_mph": 8.4, "wind_deg": 210,
          "pressure_mb": 1015.3, "conditions": "partly cloudy",
          "cell": { "lat": 41.81, "lon": -74.11, "date": "2025-06-01" }
        },
        // if --enrich osm was used:
        "roads": {
          "names": ["Storm King Highway", "US-9W", "NY-218"],
          "refs": ["US-9W", "NY-218"],
          "highway_classes": { "primary": 0.62, "secondary": 0.30, "tertiary": 0.08 }
        }
      }
    },
    // ... more stages
  ]
}
```

### `stages/stage-NN.geojson`

One file per stage, same feature shape as `all.geojson`. Useful when you want
to load one stage at a time or style each separately.

### `days/YYYY-MM-DD.geojson`

One file per calendar day (in `--tz`). Contains every stage that *started*
on that day, as separate LineString features. Same per-feature shape.

### `days-merged/YYYY-MM-DD.geojson`

**One unbroken LineString per day.** Merges all trkpts for the day into a
single geometry regardless of stage breaks. Use this when you want one clean
line per day for an overview map.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [...] },
  "properties": {
    "day": "2025-06-01",
    "trip": "big-sur",
    "points": 3412,
    "distance_km": 278.51,
    // ... same stats fields as stages
  }
}
```

### `hours/YYYY-MM-DD_HH.geojson`

Per-hour slices. Rarely useful for map-making; handy for analysis. Skip with
`--no-hours` or `--split day` / `--split stage`.

---

## QGIS prep layers

### `stops.geojson` (Points)

One Point per break-gap ≥ `--break` minutes, placed at the **point just before
the gap** (where the rider actually stopped).

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-74.12, 41.83, 215] },
  "properties": {
    "trip": "big-sur",
    "kind": "overnight",                    // see table below
    "duration_min": 1115.0,                 // minutes stopped
    "arrival_iso":   "2025-06-01T22:47:00Z",
    "departure_iso": "2025-06-02T17:22:00Z",
    "arrival_day":   "2025-06-01",          // local date of arrival
    "departure_day": "2025-06-02",          // local date of departure
    "bbox": [...]
  }
}
```

**`kind` classification:**

| kind | duration | styled as |
|---|---|---|
| `short-rest` | < 20 min | small circle (only possible if you set `--break < 20`) |
| `rest` | 20–60 min | medium circle |
| `long-rest` | 1–6 h | large circle |
| `overnight` | ≥ 6 h **OR** crosses a calendar day boundary (in `--tz`) | star |

### `speedbins.geojson` (LineStrings)

Each stage chopped into ~60-second sub-segments. Each segment carries a
`speed_bin` attribute for Categorized symbology. **This is how you get the
"line colored by speed" motorcycle map look.**

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [...] },
  "properties": {
    "stage": 0,
    "day": "2025-06-01",
    "trip": "big-sur",
    "speed_mph": 47.3,
    "speed_bin": "moderate",                // slow | moderate | fast | highway
    "distance_m": 1271.8,
    "start_iso": "2025-06-01T14:12:00Z",
    "end_iso":   "2025-06-01T14:13:00Z"
  }
}
```

**`speed_bin` thresholds:**

| bin | speed |
|---|---|
| `slow` | < 35 mph |
| `moderate` | 35–55 mph |
| `fast` | 55–75 mph |
| `highway` | 75+ mph |

### `markers.geojson` (Points)

Pre-labeled Points for every stage and day boundary. Ready to label directly
from the `label` property — no expression-writing needed in QGIS.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-74.03, 41.71, 110] },
  "properties": {
    "kind": "day_start",                    // see table below
    "stage": null,                          // null for day_*; integer for stage_*
    "day": "2025-06-01",
    "time_iso": "2025-06-01T13:14:22Z",
    "trip": "big-sur",
    "label": "Day 1 start — 09:14"          // already formatted in local time
  }
}
```

**`kind` values:**

| kind | what it marks |
|---|---|
| `stage_start` | First trkpt of a stage |
| `stage_end` | Last trkpt of a stage |
| `day_start` | First trkpt of a calendar day |
| `day_end` | Last trkpt of a calendar day |

---

## Media

### `media.geojson` (Points) — requires `--media <dir>`

One Point per photo/video that could be placed. Placement strategy falls
back in order:

1. **EXIF GPS + timestamp** — placed directly; `interpolated: false`
2. **Timestamp only** — linearly interpolated along the track at that instant (elevation too); `interpolated: true`
3. **GPS only, no time** — placed on map, but `stage`/`day` are `null`

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-74.08, 41.79, 175] },
  "properties": {
    "file": "helmetcam/IMG_0142.jpg",       // relative to --media dir
    "abs_path": "/Users/you/trip/helmetcam/IMG_0142.jpg",
    "kind": "photo",                        // "photo" | "video"
    "type": "JPEG",                         // exiftool FileType
    "time_iso": "2025-06-01T14:37:00Z",
    "day": "2025-06-01",
    "stage": 0,
    "interpolated": false,
    "match_offset_sec": 24,                 // seconds from the nearest trkpt
    "duration_s": null,                     // video length, if applicable
    "width": 4032,
    "height": 3024,
    "trip": "big-sur",
    // if --enrich sun was used:
    "sun_altitude_deg": 62.14,              // above horizon
    "sun_azimuth_deg": 182.37,              // clockwise from north
    "is_daylight": true,
    "is_golden_hour": false,                // altitude 0–6°
    "is_blue_hour": false                   // altitude -6 to 0°
  }
}
```

---

## Enrichment layers

### `crossings.geojson` (Points) — requires `--enrich crossings`

One Point per state/province transition, placed at the first trkpt in the
new state. Plus one terminal `end_state` marker at the last trkpt.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-73.49, 42.01] },
  "properties": {
    "kind": "crossing",                     // "crossing" | "end_state"
    "trip": "big-sur",
    "from_state": "New York",
    "to_state": "Massachusetts",
    "from_country": "United States of America",
    "to_country": "United States of America",
    "from_iso": "US-NY",
    "to_iso": "US-MA",
    "time_iso": "2025-06-01T18:22:00Z",
    "day": "2025-06-01",
    "mile_into_trip": 87.214,
    "km_into_trip": 140.342
  }
}
```

`end_state` features have `state`/`country`/`iso` instead of `from_`/`to_`.

**Coverage:** US states, Canadian provinces, Mexican states ship in
`data/states.geojson` (Natural Earth 50m, simplified to ~300KB).
Trips outside North America will emit only `end_state: null` markers.

### `places.geojson` (Points) — requires `--enrich osm`

OSM `place=city|town|village|hamlet` nodes within **2km** of any trkpt,
sorted chronologically by when you passed nearest.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-74.007, 41.812] },
  "properties": {
    "name": "New Paltz",
    "place_type": "town",                   // city | town | village | hamlet
    "population": 7324,
    "trip": "big-sur",
    "nearest_km": 0.412,                    // closest approach to the track
    "nearest_time_iso": "2025-06-01T15:42:00Z"
  }
}
```

### `roads.geojson` (LineStrings) — requires `--enrich osm`

OSM highway ways that had at least one node within **100m** of a trkpt
(filters out the zillion side streets in any bbox).

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [...] },
  "properties": {
    "osm_id": 12345678,
    "name": "Storm King Highway",
    "ref": "US-9W",
    "highway": "primary",                   // motorway|trunk|primary|secondary|tertiary|unclassified|residential
    "surface": "asphalt",                   // often null; OSM is inconsistent
    "maxspeed": "55 mph",                   // often null
    "trip": "big-sur"
  }
}
```

### `pois.geojson` (Points) — requires `--enrich osm`

Interesting points within **1km** of the route.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [-74.22, 41.73] },
  "properties": {
    "name": "Sam's Point Preserve",
    "kind": "viewpoint",                    // viewpoint | peak | historic | fuel
    "nearest_km": 0.184,
    "trip": "big-sur"
  }
}
```

### `optimal_routes.geojson` (LineStrings) — requires `--enrich routes`

One feature per stage — what OSRM's driving profile would have routed you
between the stage's first and last trkpt. Compare to the actual track to see
how scenic vs. shortest you went.

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [...] },   // OSRM's route
  "properties": {
    "stage": 2,
    "day": "2025-06-01",
    "trip": "big-sur",
    "actual_distance_km": 183.4,
    "actual_distance_mi": 113.96,
    "suggested_distance_km": 142.1,
    "suggested_distance_mi": 88.30,
    "suggested_duration_min": 141.3,
    "extra_distance_pct": 29.1,             // (actual - suggested) / suggested * 100
    "endpoints": [[-74.0, 41.7], [-74.11, 41.81]]
  }
}
```

Positive `extra_distance_pct` = you took the scenic way. Negative means the
OSRM route would've been longer (rare; usually happens when you cut through
a park or other area OSRM's profile doesn't love).

### `weather_timeline.json` — requires `--enrich weather`

Not GeoJSON — a plain JSON map from cell key → hourly weather data. Useful
for side-panel charts or detailed lookup. Per-stage weather summaries are on
each stage feature's `properties.weather` directly.

```jsonc
{
  "41.81|-74.11|2025-06-01": {
    "lat": 41.81,
    "lon": -74.11,
    "date": "2025-06-01",
    "hourly": {
      "time": ["2025-06-01T00:00", ...],
      "temperature_2m": [58, 57, ...],
      "wind_speed_10m": [4.2, 3.8, ...],
      "wind_direction_10m": [200, 210, ...],
      "weather_code": [2, 2, ...],
      "precipitation": [0, 0, ...],
      "pressure_msl": [1015.3, 1015.1, ...],
      "relative_humidity_2m": [65, 68, ...]
    }
  }
}
```

Cell key format: `lat|lon|date` where lat/lon are rounded to 2 decimals
(~1km granularity). Stages near each other on the same day share a cell.

---

## DEM

### `dem/tiles/<NlatElon>.hgt` — requires `--dem`

Raw SRTM elevation tiles from AWS Terrain Tiles. 1° × 1° each, ~25–50MB
uncompressed. Cached across runs — delete the folder to refetch.

### `dem/trip.vrt` — requires `--dem` + GDAL

**This is the file you drag into QGIS.** A GDAL virtual raster that stitches
every downloaded tile into one seamless layer without copying data. Drops
straight in at the bottom of your map.

### `dem/trip-hillshade.tif` — requires `--dem --dem-hillshade` (default) + GDAL

Pre-rendered shaded relief GeoTIFF. Rendered with `-z 1.5 -s 111120` so it
displays correctly in WGS 84 without reprojection. Drop under your vector
layers and set Multiply blend mode for instant pretty terrain.

### `dem/trip-contours.geojson` — requires `--dem --dem-contour <m>` + GDAL

Contour lines every N meters as a vector layer. Each feature:

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [...] },
  "properties": { "elevation_m": 500 }
}
```

Label by `elevation_m` in QGIS to get a topographic-map look.

---

## stats.json

Not GeoJSON — a single summary file. Useful for automation and as the
"did the run work" receipt.

```jsonc
{
  "trip": "big-sur",
  "generated": "2026-04-21T14:22:11Z",
  "options": { /* every flag value you ran with */ },
  "source_files": 9,
  "total_points": 14328,
  "stages": 14,
  "bbox": [-122.41, 36.28, -121.58, 37.01],
  "totals": {
    "distance_km": 986.24,
    "distance_mi": 612.83,
    "duration_hours": 74.3,
    "moving_hours": 14.38,
    "ele_gain_m": 18240,
    "ele_loss_m": 17930,
    "max_speed_mph": 94.1,
    "avg_moving_mph": 42.6
  },
  "stage_breakdown": [
    { "stage": 0, "day": "2025-06-01", "points": 1832, /* ...all stats fields, plus weather + roads if enriched... */ },
    ...
  ],
  "media": { "total": 146, "with_gps": 92, "interpolated": 48, "unlocated": 6, "photos": 140, "videos": 6 },
  "enrichments": { "weather": {...}, "osm": {...}, "routes": {...}, "crossings": 7 },
  "dem": { "bbox": [...], "padded_bbox": [...], "tiles": 12, "vrt": "...", "hillshade": "...", "contours": "..." }
}
```

---

## Property reference cheat sheet

Fields that show up on many features:

| Property | Meaning |
|---|---|
| `trip` | Trip name — `--name` or folder basename |
| `stage` | Integer stage index, 0-based, chronological |
| `day` | Local date `YYYY-MM-DD` (in `--tz`) |
| `time_iso` | ISO 8601 UTC timestamp |
| `start_iso`, `end_iso` | ISO 8601 UTC first/last trkpt times |
| `*_km`, `*_mi` | Distance in kilometers / miles |
| `*_min` | Duration in minutes |
| `*_mph`, `*_kmh` | Speed |
| `*_m` | Elevation / short distance in meters |
| `bbox` | `[minLon, minLat, maxLon, maxLat]` |
| `points` | trkpt count |

Style columns for QGIS Categorized symbology:

| Layer | Column to categorize by |
|---|---|
| `speedbins` | `speed_bin` |
| `stops` | `kind` |
| `markers` | `kind` |
| `media` | `is_golden_hour` (or `kind`) |
| `roads` | `highway` |
| `pois` | `kind` |
| `crossings` | *(single symbol, label by `to_state`)* |
| `places` | *(single symbol, label by `name`)* |
| `stages`/`days`/`days-merged` | `stage` or `day` |
