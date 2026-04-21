# moto-gpx

Dump a folder of GPX tracks (phone, Garmin, whatever), get back map-ready
GeoJSON split by day, hour, and stage — plus a stats file and optional
photo/video points from a folder of media alongside the trip.

Built for making dope D3 / QGIS / Mapbox maps of multi-day motorcycle trips.

```
moto-gpx ~/Documents/big-sur-trip --media ~/Documents/big-sur-trip --out ./out
```

```
moto-gpx: big-sur-trip
  found 9 gpx files in ~/Documents/big-sur-trip
  merged → 14,328 points (22 dupes removed)
  split on 20min gaps → 17 stages, 14 kept (min 10 pts)
  exiftool scan: ~/Documents/big-sur-trip
    146 media files
    geotagged: 92 direct · 48 interpolated · 6 unlocated

  big-sur-trip
  612.8 mi / 986.2 km
  moving 14h23  /  wall 3d02
  max 94.1 mph  · avg moving 42.6 mph
  +18,240m / -17,930m
```

## Install

Requires Node 18+. Media ingest additionally requires `exiftool`.

```sh
git clone https://github.com/ejfox/moto-gpx.git
cd moto-gpx
npm link          # puts `moto-gpx` on your PATH
```

Or run it directly without linking:

```sh
node ./moto-gpx.js <folder> [options]
```

## What it does

1. Walks a folder recursively for `.gpx` files.
2. Parses every `<trkpt>`, merges into one sorted timeline, dedupes exact
   time+coordinate collisions (handy when you have overlapping logs from
   phone + Garmin).
3. Splits the timeline into **stages** wherever there's a gap bigger than
   `--break` minutes — this is how you get morning / lunch-stop / afternoon
   as separate features without drawing a dotted line across the rest stop.
4. Buckets into **days** and **hours** using your local timezone (or
   `--tz <offset>`).
5. Optionally scans a media folder with exiftool and emits photos/videos as
   Point features — with GPS when present, **interpolated along the track**
   when only a timestamp is present, matched to the containing stage.
6. Writes GeoJSON + a `stats.json` with distance, moving time, elevation
   gain/loss, max speed, and per-stage breakdown.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | `./moto-out` | Output directory |
| `--split <mode>` | `all` | `day` \| `hour` \| `stage` \| `all` |
| `--break <minutes>` | `20` | Gap threshold to start a new stage |
| `--min-points <n>` | `10` | Drop stages with fewer points (kills GPS noise) |
| `--simplify <meters>` | `0` | Douglas-Peucker tolerance, `0` = off |
| `--tz <offset>` | local | Hours from UTC for day/hour bucketing |
| `--name <string>` | folder basename | Trip name, stamped into every feature |
| `--media <dir>` | — | Also ingest JPG/HEIC/MP4/MOV via exiftool |
| `--media-tz <offset>` | same as `--tz` | For naive EXIF timestamps |

## Output

```
out/
├── all.geojson            # every stage as a LineString feature
├── stats.json             # trip totals + per-stage breakdown
├── days/
│   ├── 2025-06-01.geojson
│   └── 2025-06-02.geojson
├── hours/
│   ├── 2025-06-01_14.geojson
│   └── …
├── stages/
│   ├── stage-00.geojson
│   └── …
└── media.geojson          # photos/videos as Point features (when --media set)
```

Each LineString feature's `properties`:

```jsonc
{
  "stage": 2,
  "day": "2025-06-01",
  "trip": "big-sur-trip",
  "points": 1832,
  "start_iso": "2025-06-01T17:30:00.000Z",
  "end_iso":   "2025-06-01T21:47:12.000Z",
  "duration_min": 257.2,
  "moving_min": 224.1,
  "distance_km": 183.4,
  "distance_mi": 113.96,
  "max_speed_mph": 84.7,
  "max_speed_kmh": 136.3,
  "avg_moving_mph": 48.2,
  "ele_gain_m": 1240,
  "ele_loss_m": 1190,
  "bbox": [-74.32, 41.82, -73.91, 42.18]
}
```

Each media Point feature's `properties`:

```jsonc
{
  "file": "helmetcam/IMG_0142.jpg",
  "abs_path": "/Users/you/trip/helmetcam/IMG_0142.jpg",
  "kind": "photo",            // or "video"
  "type": "JPEG",
  "time_iso": "2025-06-01T18:02:00.000Z",
  "day": "2025-06-01",
  "stage": 1,
  "interpolated": true,       // true when location came from the track
  "match_offset_sec": 24,     // seconds from the nearest trkpt
  "duration_s": null,
  "width": 4032,
  "height": 3024,
  "trip": "big-sur-trip"
}
```

## Recipes

**Multi-day trip with photos from the same folder:**

```sh
moto-gpx ~/trips/big-sur --media ~/trips/big-sur --out ./big-sur-out
```

**Separate track folder and photo folder:**

```sh
moto-gpx ~/tracks/jun-trip --media ~/photos/jun-trip --out ./out
```

**Noisy city riding, split anytime you stop for 10+ min:**

```sh
moto-gpx ./trip --break 10 --min-points 30
```

**Shrink file sizes for the web (2 meter tolerance is basically lossless):**

```sh
moto-gpx ./trip --simplify 2
```

**Custom timezone (e.g. logs collected in UTC but you want PT day boundaries):**

```sh
moto-gpx ./trip --tz -7
```

## How media gets located

Three fallback strategies in order:

1. **EXIF GPS + timestamp** → placed directly, matched to the containing
   stage, `match_offset_sec` shows drift from the nearest trkpt.
2. **Timestamp only** → linearly interpolated along the track at that
   instant. Elevation gets interpolated too. `interpolated: true`.
3. **GPS only (no time)** → placed on the map, but `stage`/`day` are null.

Anything with neither is reported but not written out.

## Drawing with D3

```js
const days = await d3.json('./out/days/2025-06-01.geojson');
const media = await d3.json('./out/media.geojson');

const proj = d3.geoMercator().fitSize([W, H], days);
const path = d3.geoPath(proj);

svg.selectAll('path.stage')
  .data(days.features).join('path')
  .attr('class', 'stage')
  .attr('d', path)
  .attr('stroke', (d, i) => d3.interpolateTurbo(i / days.features.length));

svg.selectAll('circle.photo')
  .data(media.features.filter(f => f.properties.day === '2025-06-01'))
  .join('circle')
  .attr('cx', d => proj(d.geometry.coordinates)[0])
  .attr('cy', d => proj(d.geometry.coordinates)[1])
  .attr('r', 3);
```

## Loading into QGIS

- Drag `all.geojson` onto the canvas for the whole trip.
- Drag any `days/*.geojson` for a single day.
- Drag `media.geojson` for the photo markers.
- CRS is plain WGS 84 (EPSG:4326) — no reprojection needed.

Style by the `stage` / `day` properties for categorical colour ramps.

## Known limits

- **Helmet cam MP4s** contribute a single representative point right now
  (the file-level QuickTime location atom). If you want the full embedded
  GPMF telemetry track merged into the timeline, open an issue.
- **DJI `.SRT` sidecars** (per-frame GPS) aren't parsed yet.
- **EXIF timestamps without an embedded offset** are interpreted with
  `--media-tz` (defaults to `--tz`). If your camera writes naive local
  times in a different zone than the GPX logger, set them independently.

## License

MIT
