// GPX parsing, geo helpers, stage splitting, stats.

export function parseGpx(xml) {
  const points = [];
  const re = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/g;
  const latRe = /\blat\s*=\s*"([^"]+)"/;
  const lonRe = /\blon\s*=\s*"([^"]+)"/;
  const eleRe = /<ele>\s*([^<]+?)\s*<\/ele>/;
  const timeRe = /<time>\s*([^<]+?)\s*<\/time>/;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const lat = Number((attrs.match(latRe) || [])[1]);
    const lon = Number((attrs.match(lonRe) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleM = body.match(eleRe);
    const timeM = body.match(timeRe);
    const ele = eleM ? Number(eleM[1]) : null;
    const time = timeM ? Date.parse(timeM[1]) : null;
    points.push({
      lat, lon,
      ele: Number.isFinite(ele) ? ele : null,
      time: Number.isFinite(time) ? time : null,
    });
  }
  return points;
}

export function haversine(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing in degrees from a to b (0 = north, clockwise).
export function bearing(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function bboxOf(points) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (p.lon < b[0]) b[0] = p.lon;
    if (p.lat < b[1]) b[1] = p.lat;
    if (p.lon > b[2]) b[2] = p.lon;
    if (p.lat > b[3]) b[3] = p.lat;
  }
  return b[0] === Infinity ? null : b;
}

// Douglas-Peucker in local equirectangular meters.
export function simplifyPoints(points, tolerance) {
  if (tolerance <= 0 || points.length < 3) return points;
  const lat0 = (points[0].lat * Math.PI) / 180;
  const mx = 111320 * Math.cos(lat0);
  const my = 110540;
  const xs = points.map(p => p.lon * mx);
  const ys = points.map(p => p.lat * my);
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD2 = 0;
    let idx = -1;
    const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = xs[i] - ax;
      const py = ys[i] - ay;
      let d2;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const qx = t * dx - px;
        const qy = t * dy - py;
        d2 = qx * qx + qy * qy;
      }
      if (d2 > maxD2) { maxD2 = d2; idx = i; }
    }
    if (maxD2 > tol2 && idx > -1) {
      keep[idx] = 1;
      stack.push([a, idx]);
      stack.push([idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export function splitStages(points, gapMs) {
  const stages = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (prev && p.time != null && prev.time != null && (p.time - prev.time) > gapMs) {
      if (cur.length) stages.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) stages.push(cur);
  return stages;
}

export function segmentStats(points) {
  let distance = 0;
  let maxSpeed = 0;
  let movingSec = 0;
  for (let i = 1; i < points.length; i++) {
    const d = haversine(points[i - 1], points[i]);
    distance += d;
    const t0 = points[i - 1].time;
    const t1 = points[i].time;
    if (t0 != null && t1 != null) {
      const dt = (t1 - t0) / 1000;
      if (dt > 0) {
        const speed = d / dt;
        if (speed > 0.5) movingSec += dt;
      }
    }
  }

  // Max speed computed over a 5-second sliding window so a single GPS jitter
  // (e.g. 50m hop between adjacent 1s samples → 112 mph phantom) doesn't
  // dominate. Still sanity-clamped to <300 mph.
  const SPEED_WINDOW_MS = 5000;
  for (let i = 0; i < points.length; i++) {
    if (points[i].time == null) continue;
    let j = i + 1;
    let winDist = 0;
    while (j < points.length) {
      if (points[j].time == null) { j++; continue; }
      winDist += haversine(points[j - 1], points[j]);
      if ((points[j].time - points[i].time) >= SPEED_WINDOW_MS) break;
      j++;
    }
    if (j >= points.length) break;
    const dt = (points[j].time - points[i].time) / 1000;
    if (dt <= 0) continue;
    const speed = winDist / dt;
    if (speed < 134 && speed > maxSpeed) maxSpeed = speed;
  }
  let gain = 0, loss = 0;
  let prevEle = null;
  for (const p of points) {
    if (p.ele == null) continue;
    if (prevEle != null) {
      const dz = p.ele - prevEle;
      if (dz > 0) gain += dz;
      else loss += -dz;
    }
    prevEle = p.ele;
  }
  const firstT = points.find(p => p.time != null)?.time ?? null;
  const lastT = [...points].reverse().find(p => p.time != null)?.time ?? null;
  return {
    points: points.length,
    start_iso: firstT != null ? new Date(firstT).toISOString() : null,
    end_iso: lastT != null ? new Date(lastT).toISOString() : null,
    duration_min: firstT != null && lastT != null ? (lastT - firstT) / 60000 : null,
    moving_min: movingSec / 60,
    distance_km: +(distance / 1000).toFixed(3),
    distance_mi: +(distance / 1609.344).toFixed(3),
    max_speed_mph: +(maxSpeed * 2.23694).toFixed(1),
    max_speed_kmh: +(maxSpeed * 3.6).toFixed(1),
    avg_moving_mph: movingSec > 0 ? +((distance / movingSec) * 2.23694).toFixed(1) : null,
    ele_gain_m: Math.round(gain),
    ele_loss_m: Math.round(loss),
    bbox: bboxOf(points),
  };
}

export function toLineFeature(points, props) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'LineString',
      coordinates: points.map(p => p.ele != null ? [p.lon, p.lat, p.ele] : [p.lon, p.lat]),
    },
  };
}

export function dayKey(time, tzH) {
  return new Date(time + tzH * 3600000).toISOString().slice(0, 10);
}

export function hourKey(time, tzH) {
  return new Date(time + tzH * 3600000).toISOString().slice(0, 13).replace('T', '_');
}
