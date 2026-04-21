/**
 * sun.js — annotate media features with solar altitude / azimuth at the
 * exact time and place each photo / video was taken.
 *
 * Role in the pipeline: opt-in enrichment (`--enrich sun`). Mutates each Point
 * Feature in `media.geojson` in place by adding: `sun_altitude_deg`,
 * `sun_azimuth_deg`, `is_daylight` (altitude > 0), `is_golden_hour` (altitude
 * 0–6°), `is_blue_hour` (altitude -6–0°). Useful for filtering photos by
 * "golden hour" or coloring them by sun position on a gallery map.
 *
 * Contract: pure. No I/O, no network. Mutates the passed-in feature array.
 *
 * External dependencies: none. The solar position formulas are inlined from
 * the NOAA low-precision algorithm (https://gml.noaa.gov/grad/solcalc/) —
 * accurate to ~0.01° from 2000–2099, which is overkill for photograph tagging.
 *
 * Exports:
 *   attachSunPosition(features) — mutates in place, returns nothing
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const epsilon = (23.439 - 0.0000004 * n) * RAD;

  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));

  const T = n / 36525;
  const gmstHours = 6.697374558 + 0.06570982441908 * n
    + 1.00273790935 * ((date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600))
    + 0.000026 * T * T;
  const gmst = ((gmstHours % 24) + 24) % 24;
  const lst = (gmst * 15 + lon) * RAD;
  const H = lst - ra;

  const latR = lat * RAD;
  const alt = Math.asin(Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(
    -Math.sin(H),
    Math.tan(dec) * Math.cos(latR) - Math.sin(latR) * Math.cos(H),
  );

  return {
    altitude: alt * DEG,
    azimuth: ((az * DEG) + 360) % 360,
  };
}

export function attachSunPosition(features) {
  for (const f of features) {
    const t = f?.properties?.time_iso;
    const coords = f?.geometry?.coordinates;
    if (!t || !Array.isArray(coords) || coords.length < 2) continue;
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    const [lon, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const { altitude, azimuth } = sunPosition(new Date(ms), lat, lon);
    f.properties.sun_altitude_deg = +altitude.toFixed(2);
    f.properties.sun_azimuth_deg = +azimuth.toFixed(2);
    f.properties.is_daylight = altitude > 0;
    f.properties.is_golden_hour = altitude >= 0 && altitude <= 6;
    f.properties.is_blue_hour = altitude >= -6 && altitude < 0;
  }
}
