/** 위경도/미터 변환 및 기본 기하 유틸 */

export type LngLat = [number, number]; // [경도, 위도]

export const EARTH_M_PER_DEG_LAT = 110574;

export function mPerDegLon(lat: number) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/** 두 좌표 사이 거리(m) — 짧은 거리용 평면 근사 */
export function distMeters(a: LngLat, b: LngLat) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * EARTH_M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** 방위각(도, 북=0 시계방향)과 거리(m)만큼 이동한 좌표 */
export function moveByBearing(p: LngLat, bearingDeg: number, meters: number): LngLat {
  const rad = (bearingDeg * Math.PI) / 180;
  const dxM = Math.sin(rad) * meters;
  const dyM = Math.cos(rad) * meters;
  return [p[0] + dxM / mPerDegLon(p[1]), p[1] + dyM / EARTH_M_PER_DEG_LAT];
}

/** a→b 방위각(도, 북=0 시계방향) */
export function bearingOf(a: LngLat, b: LngLat) {
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * mPerDegLon(lat);
  const dy = (b[1] - a[1]) * EARTH_M_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

export type BBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

export function bboxOfPoints(pts: LngLat[]): BBox {
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of pts) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** bbox를 미터 단위로 확장 */
export function padBBox(b: BBox, meters: number): BBox {
  const lat = (b.minLat + b.maxLat) / 2;
  const dLat = meters / EARTH_M_PER_DEG_LAT;
  const dLng = meters / mPerDegLon(lat);
  return {
    minLng: b.minLng - dLng,
    minLat: b.minLat - dLat,
    maxLng: b.maxLng + dLng,
    maxLat: b.maxLat + dLat,
  };
}

export function bboxIntersects(a: BBox, b: BBox) {
  return !(a.maxLng < b.minLng || a.minLng > b.maxLng || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

export function bboxContains(a: BBox, p: LngLat) {
  return p[0] >= a.minLng && p[0] <= a.maxLng && p[1] >= a.minLat && p[1] <= a.maxLat;
}

/** Overpass용 bbox 문자열: south,west,north,east */
export function toOverpassBBox(b: BBox) {
  return `${b.minLat.toFixed(6)},${b.minLng.toFixed(6)},${b.maxLat.toFixed(6)},${b.maxLng.toFixed(6)}`;
}

/** 폴리곤 링 내부 판정 (ray casting) */
export function pointInRing(p: LngLat, ring: LngLat[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 볼록 껍질 (Andrew's monotone chain) */
export function convexHull(points: LngLat[]): LngLat[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: LngLat, a: LngLat, b: LngLat) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: LngLat[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: LngLat[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 폴리라인 총 길이(m) */
export function pathLength(path: LngLat[]) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) sum += distMeters(path[i - 1], path[i]);
  return sum;
}

/** 폴리라인을 일정 간격(m)으로 리샘플링 */
export function resample(path: LngLat[], stepM: number): LngLat[] {
  if (path.length < 2) return path.slice();
  const out: LngLat[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = distMeters(a, b);
    if (seg <= 1e-9) continue;
    let t = stepM - carry;
    while (t <= seg) {
      const r = t / seg;
      out.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r]);
      t += stepM;
    }
    carry = (carry + seg) % stepM;
  }
  const last = path[path.length - 1];
  if (distMeters(out[out.length - 1], last) > 0.5) out.push(last);
  return out;
}

/**
 * 점과 선분 사이 거리(m). 몇 km 안에서 쓰는 값이라 평면 근사로 충분하다.
 * (선로 판정·노선 형상 맞추기처럼 좁은 범위에서만 쓴다)
 */
export function distToSegment(p: LngLat, a: LngLat, b: LngLat) {
  const kx = mPerDegLon((a[1] + b[1]) / 2);
  const px = (p[0] - a[0]) * kx;
  const py = (p[1] - a[1]) * EARTH_M_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * EARTH_M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
  return Math.hypot(px - bx * t, py - by * t);
}

/**
 * 모양을 유지한 채 점을 줄인다 (Douglas–Peucker).
 * 노선 형상은 2~5m 간격으로 오는데, 지도에 그리는 데는 그만큼 촘촘할 필요가 없다.
 */
export function simplifyPath(points: LngLat[], toleranceM: number): LngLat[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let farD = toleranceM;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(points[i], points[a], points[b]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return points.filter((_, i) => keep[i] === 1);
}
