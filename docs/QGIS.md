# QGIS workflow

Step-by-step for hand-making a multi-day motorcycle trip map from a
moto-gpx output folder. QGIS 3.28+.

---

## 0. Generate the data

```sh
moto-gpx ~/trips/big-sur \
  --media ~/trips/big-sur \
  --enrich all \
  --dem --dem-contour 100 \
  --out ~/maps/big-sur-out
```

This is a one-time ~2-minute run (DEM downloads + enrichment API calls
dominate; subsequent runs cache DEM tiles).

---

## 1. Open a new QGIS project

```
QGIS → New Empty Project
```

Set project CRS to **EPSG:4326 WGS 84** (Project → Properties → CRS). The
tool outputs WGS 84; matching the project CRS avoids an "on-the-fly
reprojection" warning and makes extents behave predictably.

You may want to switch to an equal-area or Web Mercator projection later for
the final layout — do that at export time, not up front.

---

## 2. Drop the DEM as the bottom layer

Browser panel → navigate to `~/maps/big-sur-out/dem/` → drag **`trip.vrt`**
onto the canvas. This is the raw elevation as a grayscale raster; you
normally *don't* leave it visible.

- Right-click the layer → **Properties → Symbology**
- Change **Render type** to **Singleband gray**
- Set **Opacity** to 30–50% if you want it visible at all — otherwise hide it (the hillshade carries the visual).

Then drag **`dem/trip-hillshade.tif`** onto the canvas, above `trip.vrt`:

- Properties → Symbology → **Blending mode: Multiply**
- Opacity: 60–80%
- (Optional) Color → **Color ramp** → single-band pseudocolor with a warm-to-cool ramp if you want colorized elevation instead of gray shading.

Result: a beautiful shaded-relief base layer that reads like a topo map.

---

## 3. Drop the contours (optional but tasty)

Drag **`dem/trip-contours.geojson`** onto the canvas.

- Properties → Symbology → single symbol, thin line, color `#555` at 40% opacity, width 0.2mm.
- Properties → **Labels** → **Single labels** → Value: `elevation_m` → font 7pt, color `#333`, halo white 0.5mm, only show at large scales (Rendering → Scale-dependent visibility: 1:100,000 and closer).

Result: labeled elevation contours that come in when the user zooms in. Very
classy.

---

## 4. The trip track — speed-binned

Drag **`speedbins.geojson`** onto the canvas. The sibling `speedbins.qml`
auto-loads and you get yellow → orange → red → dark-red line segments by
speed bucket.

Tweak:
- Properties → Symbology → adjust line widths per category. Highway
  segments read better as slightly thicker so the "fastest stretches" pop.
- Consider enabling **Symbol levels** (Properties → Symbology → Advanced →
  Symbol levels): set higher speeds to render on top so a slow-moderate
  overlap reads correctly.

---

## 5. Alternative: per-day merged line

If your map is "one trip line per day" rather than "colored by speed":

- Hide `speedbins.geojson`
- Drag `days-merged/` → the QGIS Browser will let you add each day's
  GeoJSON as a separate layer
- Each gets the auto-loaded style (blue single line). Right-click each
  layer → Properties → Symbology → change the color.
- Or: drag them all in, then use **Processing → Merge vector layers** to
  combine, then categorize the merged layer by `day` with a qualitative
  color scheme.

---

## 6. Stops — where you paused

Drag **`stops.geojson`**. Auto-styled as blue circles (small / medium /
large) with overnights as stars.

Pre-labeling:

- Properties → **Labels** → Expression:
  ```
  CASE
    WHEN "kind" = 'overnight' THEN concat("departure_day", ' · ', round("duration_min"/60, 1), 'h')
    ELSE concat(round("duration_min", 0), ' min')
  END
  ```
- Placement → around point with offset, so labels don't sit on the dot

Overnights become labeled mile markers for your multi-day trip map.

---

## 7. Stage / day boundary markers

Drag **`markers.geojson`**. Auto-styled with triangles (starts) and squares
(ends), larger for day boundaries.

Labels: set **Value** to the `label` attribute — it's already formatted as
`"Day 1 start — 09:14"`.

If you only want day-level markers (stage markers get noisy):

- Properties → Source → **Provider feature filter**:
  ```
  "kind" IN ('day_start', 'day_end')
  ```

---

## 8. State / province crossings

Drag **`crossings.geojson`**. Purple diamonds; labeled by `to_state` by
default.

Consider filtering out the `end_state` marker (it's useful data but often
duplicates a `day_end` visually):

- Source → Provider feature filter: `"kind" = 'crossing'`

---

## 9. Media markers

Drag **`media.geojson`**. Golden-hour photos are orange stars; the rest are
gray dots.

- Properties → **Symbology** → you can graduate by `sun_altitude_deg` for a
  fade from high-noon gray to golden-amber.
- Labels → use `"file"` (or the expression `right("file", 10)`) to show
  just the filename.
- For clickable image preview: Properties → **Display** → HTML Map Tip:
  ```html
  <h3>[% "file" %]</h3>
  <img src="file://[% "abs_path" %]" width="400"/>
  <p>[% "time_iso" %] · stage [% "stage" %]</p>
  ```
  Then Project Properties → **Map Tips** → enabled.

---

## 10. Places + POIs (if OSM enrichment was run)

Drag **`places.geojson`**. Small dots with `name` labels.

- Filter to meaningful places: `"place_type" IN ('city', 'town')` — hamlets
  are often too dense.

Drag **`pois.geojson`**. Categorized by `kind`.

- Viewpoints get the map-icon treatment; peaks get a triangle; fuel stops
  get a gas pump (use a custom SVG).
- Label viewpoints only: Labels → Rule-based → `"kind" = 'viewpoint'`.

---

## 11. Roads (if OSM enrichment was run)

Drag **`roads.geojson`**. Auto-categorized by `highway` class, with motorway
being thickest/darkest.

Often useful to **put this layer behind** your speedbins/merged lines — it
gives context for where your track runs without dominating.

Pre-labeling: `"ref"` (e.g. "US-9W") or `"name"` (e.g. "Storm King Highway").
Rule-based labeling to show only primary+ roads:

```
"highway" IN ('motorway', 'trunk', 'primary')
```

---

## 12. Optimal route comparison

If you ran `--enrich routes`, drag **`optimal_routes.geojson`**. Thin gray
lines showing what OSRM would have routed you. Usually you'll style this:

- Dashed light gray, 0.3mm width, 50% opacity.
- Put *underneath* your actual track so your scenic route pops on top.

Label expression for a call-out: `concat('+', "extra_distance_pct", '% scenic')`.

---

## 13. Labeling and composing

QGIS labels work best when:

- **Halo / buffer** is always on: 0.8mm white buffer at ~80% opacity.
- **Rule-based** at varying zoom levels. Day labels bigger and visible from
  far out; stop labels only when zoomed close.
- **Placement: Around point** with a pixel offset for points; **Curved**
  for long LineStrings like roads.

Then → **Project → New Print Layout** → drop a map frame, legend, scale bar,
and a title. Export to PNG/PDF/SVG.

---

## 14. Save the project

File → Save As → `big-sur.qgz` **inside** your output directory. The `.qgz`
stores relative paths so you can move the whole folder without breaking
anything.

---

## Shortcut: just style the speedbins

For a quick "line colored by speed" map with nothing else:

1. New QGIS project, CRS 4326
2. Drag `dem/trip-hillshade.tif` (Multiply blend, 70% opacity)
3. Drag `speedbins.geojson` (auto-styles)
4. Drag `markers.geojson`, filter to `"kind" IN ('day_start', 'day_end')`

Five drops. Done.

---

## Troubleshooting QGIS

- **"Style failed to load"** — check that the `.qml` is in the same
  directory as the `.geojson` with the same basename (`stops.qml` next to
  `stops.geojson`). If you moved files, re-apply manually via right-click
  → Properties → Style → Load Style.
- **Hillshade looks flat / wrong scale** — the `-s 111120` scale factor
  makes hillshade render correctly in WGS 84. If you reprojected the DEM
  to e.g. a UTM CRS, re-run `gdaldem hillshade` *without* `-s` since the
  projected CRS is already in meters.
- **DEM tiles missing over ocean** — this is expected. AWS Terrain Tiles
  don't have tiles where there's no land data. moto-gpx skips 403/404s.
- **Performance on huge tracks** — enable **Simplify on the fly** per
  layer (Properties → Rendering → Simplify geometry), or pre-simplify at
  `moto-gpx` time with `--simplify 2`.

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for CLI-side issues.
