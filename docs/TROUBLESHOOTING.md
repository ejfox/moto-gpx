# Troubleshooting

Common issues and fixes.

---

## GDAL

### `libpoppler.154.dylib` not found (macOS / Homebrew)

```
dyld[...]: Library not loaded: /opt/homebrew/opt/poppler/lib/libpoppler.154.dylib
```

Homebrew's `poppler` updated and `gdal`'s ABI link broke. Fix:

```sh
brew reinstall gdal poppler
```

If that doesn't work, `brew update && brew upgrade` first. The DEM module
catches the missing-GDAL case and degrades gracefully — raw tiles will
still be cached in `out/dem/tiles/`, and you can build the VRT by hand
later with:

```sh
cd out/dem && gdalbuildvrt trip.vrt tiles/*.hgt
```

### `gdalbuildvrt: command not found`

Install GDAL:

```sh
brew install gdal         # macOS
sudo apt install gdal-bin # Debian/Ubuntu
```

Verify:

```sh
gdalinfo --version
```

### DEM tiles fetched but no VRT was built

Check the log. If you see `GDAL not found — install with 'brew install gdal'`,
GDAL isn't on your PATH. If you see `gdalbuildvrt failed: ...`, run it by
hand to see the full error:

```sh
cd out/dem
gdalbuildvrt trip.vrt tiles/*.hgt
```

### Only some tiles downloaded

Some ocean/edge tiles don't exist in AWS Terrain Tiles and return 403/404.
This is expected and the tool logs them as skipped. Your VRT will still
cover everything that does have land data.

---

## exiftool

### `exiftool not found`

```sh
brew install exiftool         # macOS
sudo apt install exiftool     # Debian/Ubuntu
```

### Photos have no GPS in EXIF

Photos from phones generally do. Photos from DSLRs generally don't unless
you explicitly enabled GPS or manually geotagged. moto-gpx will
**interpolate** a location for any photo with just a timestamp, as long as
that timestamp falls within the trip's GPX time range.

### Photos have wrong timestamps

If your camera's clock was off, the photos will be misplaced on the track.
Options:

1. Fix the EXIF timestamps ahead of time: `exiftool "-DateTimeOriginal+=0:0:0 1:0:0" *.jpg` (adds 1 hour).
2. Use `--media-tz` to shift all naive timestamps.
3. Set the camera clock correctly next time.

### HEIC/HEIF not parsed

exiftool reads HEIC fine. Make sure your exiftool is recent (13+).

---

## Network enrichments

### `weather` / `osm` / `routes` times out or 429s

Public APIs rate-limit. moto-gpx retries once after a 2–5s backoff, then
skips that particular request. Your run will still succeed, just with
partial enrichment.

For huge trips (50+ stages with `--enrich osm,routes`):

- Run enrichments one at a time: `--enrich weather`, then `--enrich osm`, etc.
- Consider self-hosting OSRM / a local Overpass instance.

### Weather numbers look wrong

Open-Meteo is usually spot-on but you should double-check:

- Timezone: moto-gpx requests `timezone=GMT` and matches stage midpoint
  times in UTC. If `--tz` and the actual trip timezone don't match,
  weather lookup could be an hour off.
- Historical dataset: Open-Meteo's historical archive lags 3–5 days behind
  the present. If you just rode today and query today, you'll get nothing.

### OSRM: `extra_distance_pct` is negative

OSRM's driving profile wouldn't always agree with a motorcycle rider.
Negative values happen when OSRM routes through a road it considers
slightly better than yours. Not a bug.

### Overpass returns zero places/roads

Overpass occasionally returns empty when overloaded. Retry. If it keeps
returning empty, check that your bbox is reasonable — extremely narrow
bboxes (<1km²) sometimes get empty responses due to how the query
executes. Pad via a longer trip or try `--enrich osm` on a larger subset.

---

## Stages / breaks

### Too many stages — every traffic light is its own stage

Your `--break` is too low. GPS loggers sometimes pause during stops and
resume minutes later. Bump to `--break 30` or `--break 45`.

### Not enough stages — lunch stop got merged with the afternoon ride

Your `--break` is too high. Try `--break 15`.

### Whole trip is one stage

Your GPX files might not have any time gaps, or the gap data is
inconsistent. Check `stats.json`: `stages` count. If it's 1, the raw
trkpt timeline has no gaps ≥ `--break`. Lower `--break` or check your
recording app's pause behavior.

---

## File organization

### "No .gpx files found"

The tool walks the folder **recursively**. Common issues:

- File extensions are `.GPX` (uppercase) — moto-gpx handles this.
- Files are inside zip archives — unzip first.
- Files are symlinks to nonexistent targets — check.

### Photos folder is separate from GPX folder

Totally fine:

```sh
moto-gpx ~/tracks/trip --media ~/photos/trip --out ./out
```

### Multiple separate trips in one folder

moto-gpx treats everything in the folder as one trip. Split by timestamps:
the break-gap detection will naturally chop them into stages, but the
totals and stats.json treat it as a single trip with many long overnights.
To keep them separate, run the tool once per subfolder.

---

## QGIS

See [QGIS.md § Troubleshooting](./QGIS.md#troubleshooting-qgis) for QGIS-side
issues (style autoload, hillshade scale, performance).

---

## Debugging

- `stats.json` is a useful receipt: every option you ran with, every total,
  per-stage breakdown. Open it first when something seems off.
- All GeoJSON is one-line JSON by default. Pipe through `jq` to inspect:

  ```sh
  jq '.features | length' out/stops.geojson
  jq '.features[0].properties' out/crossings.geojson
  jq '.stage_breakdown[0]' out/stats.json
  ```

- Add `--no-hours` / `--no-days-merged` / `--no-speedbins` during
  debugging to isolate which subsystem is causing an issue.

---

## Still stuck?

Open an issue: https://github.com/ejfox/moto-gpx/issues

Include:
- The exact command you ran
- The full console output
- Node version (`node --version`)
- OS + relevant binary versions (`exiftool -ver`, `gdalinfo --version`)
- A minimal reproducible GPX file if possible
