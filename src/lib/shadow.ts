import {
  BBox,
  LngLat,
  bboxOfPoints,
  convexHull,
  moveByBearing,
  pointInRing,
  EARTH_M_PER_DEG_LAT,
  mPerDegLon,
} from "./geo";
import type { SunState } from "./sun";

export type Building = {
  id: string;
  /** 외곽 링 (닫히지 않아도 됨) */
  ring: LngLat[];
  /** 높이(m) */
  height: number;
};

export type Tree = {
  id: string;
  p: LngLat;
  height: number;
  /** 수관 반경(m) */
  crown: number;
};

export type ShadowPoly = {
  ring: LngLat[];
  bbox: BBox;
  /** 차광 강도 0~1 (건물=1, 가로수=0.65) */
  opacity: number;
  kind: "building" | "tree";
};

/**
 * 건물 그림자 = 바닥면을 태양 반대 방향으로 (높이 × shadowRatio)만큼 밀어낸 뒤
 * 원본과 이동본을 함께 감싸는 볼록 껍질.
 *
 * ㄱ/ㄷ자 같은 오목한 건물은 실제보다 그림자를 조금 넓게 잡는다.
 * (정확한 민코프스키 합 대신 속도를 택한 근사 — 수백 동을 60fps로 다시 그리기 위함)
 */
export function buildingShadow(b: Building, sun: SunState): ShadowPoly | null {
  if (!sun.isDay || b.ring.length < 3) return null;
  const len = Math.min(b.height * sun.shadowRatio, 400); // 400m 상한
  if (len < 1) return null;

  const moved = b.ring.map((p) => moveByBearing(p, sun.shadowBearingDeg, len));
  const ring = convexHull([...b.ring, ...moved]);
  if (ring.length < 3) return null;
  return { ring, bbox: bboxOfPoints(ring), opacity: 1, kind: "building" };
}

/** 가로수 그림자 = 수관 원을 태양 반대 방향으로 밀어낸 타원형(원 근사) */
export function treeShadow(t: Tree, sun: SunState): ShadowPoly | null {
  if (!sun.isDay) return null;
  const len = Math.min(t.height * sun.shadowRatio, 120);
  if (len < 1) return null;
  const center = moveByBearing(t.p, sun.shadowBearingDeg, len);
  const ring: LngLat[] = [];
  const SEG = 10;
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    ring.push([
      center[0] + (Math.cos(a) * t.crown) / mPerDegLon(center[1]),
      center[1] + (Math.sin(a) * t.crown) / EARTH_M_PER_DEG_LAT,
    ]);
  }
  return { ring, bbox: bboxOfPoints(ring), opacity: 0.65, kind: "tree" };
}

export function buildShadows(buildings: Building[], trees: Tree[], sun: SunState): ShadowPoly[] {
  const out: ShadowPoly[] = [];
  for (const b of buildings) {
    const s = buildingShadow(b, sun);
    if (s) out.push(s);
  }
  for (const t of trees) {
    const s = treeShadow(t, sun);
    if (s) out.push(s);
  }
  return out;
}

/** 그림자 폴리곤들의 격자 공간 인덱스. 점 하나의 차광도를 O(1)에 가깝게 조회한다. */
export class ShadeIndex {
  private cells = new Map<string, ShadowPoly[]>();
  private cellLng: number;
  private cellLat: number;
  readonly polys: ShadowPoly[];

  constructor(polys: ShadowPoly[], refLat = 37.5, cellMeters = 60) {
    this.polys = polys;
    this.cellLat = cellMeters / EARTH_M_PER_DEG_LAT;
    this.cellLng = cellMeters / mPerDegLon(refLat);

    for (const poly of polys) {
      const x0 = Math.floor(poly.bbox.minLng / this.cellLng);
      const x1 = Math.floor(poly.bbox.maxLng / this.cellLng);
      const y0 = Math.floor(poly.bbox.minLat / this.cellLat);
      const y1 = Math.floor(poly.bbox.maxLat / this.cellLat);
      // 그림자가 지나치게 크면 격자를 과도하게 채우므로 상한을 둔다
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) continue;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = `${x}:${y}`;
          const arr = this.cells.get(k);
          if (arr) arr.push(poly);
          else this.cells.set(k, [poly]);
        }
      }
    }
  }

  /** 해당 지점의 차광도 0(완전 햇빛) ~ 1(완전 그늘) */
  shadeAt(p: LngLat): number {
    const k = `${Math.floor(p[0] / this.cellLng)}:${Math.floor(p[1] / this.cellLat)}`;
    const arr = this.cells.get(k);
    if (!arr) return 0;
    let best = 0;
    for (const poly of arr) {
      if (poly.opacity <= best) continue;
      const b = poly.bbox;
      if (p[0] < b.minLng || p[0] > b.maxLng || p[1] < b.minLat || p[1] > b.maxLat) continue;
      if (pointInRing(p, poly.ring)) {
        best = poly.opacity;
        if (best >= 1) return 1;
      }
    }
    return best;
  }

  /** 폴리라인의 평균 그늘 비율 */
  shadeOfPath(samples: LngLat[]): number {
    if (!samples.length) return 0;
    let sum = 0;
    for (const p of samples) sum += this.shadeAt(p);
    return sum / samples.length;
  }
}

/** OSM 태그에서 건물 높이 추정 */
export function estimateHeight(tags: Record<string, string> | undefined): number {
  if (!tags) return DEFAULT_HEIGHT;
  const h = parseFloat(tags["height"] ?? tags["building:height"] ?? "");
  if (Number.isFinite(h) && h > 0) return h;
  const lv = parseFloat(tags["building:levels"] ?? tags["levels"] ?? "");
  if (Number.isFinite(lv) && lv > 0) return lv * FLOOR_HEIGHT + 1.5;
  const type = tags["building"];
  if (type === "house" || type === "detached" || type === "hut" || type === "garage") return 5;
  if (type === "apartments" || type === "residential") return 40;
  if (type === "retail" || type === "commercial" || type === "office") return 22;
  if (type === "church" || type === "temple") return 14;
  return DEFAULT_HEIGHT;
}

export const FLOOR_HEIGHT = 3.2;
/** 높이 정보가 없는 건물의 기본값 (국내 도심 저층 상가 기준) */
export const DEFAULT_HEIGHT = 12;
