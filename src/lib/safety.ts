import { EARTH_M_PER_DEG_LAT, LngLat, distMeters, mPerDegLon } from "./geo";
import type { SafetyPoint } from "./osm";

/** 방범시설(가로등·CCTV·비상벨)의 격자 인덱스. 임의 지점의 "밝기"를 0~1로 돌려준다. */
export class SafetyIndex {
  private cells = new Map<string, LngLat[]>();
  private cellLng: number;
  private cellLat: number;
  readonly count: number;

  /** 이 거리 안에 시설이 있으면 1, NEAR~FAR 사이는 선형 감소 */
  private static NEAR_M = 25;
  private static FAR_M = 90;

  constructor(points: SafetyPoint[], refLat = 37.5) {
    const cell = SafetyIndex.FAR_M;
    this.cellLat = cell / EARTH_M_PER_DEG_LAT;
    this.cellLng = cell / mPerDegLon(refLat);
    this.count = points.length;
    for (const s of points) {
      const k = this.key(s.p);
      const arr = this.cells.get(k);
      if (arr) arr.push(s.p);
      else this.cells.set(k, [s.p]);
    }
  }

  private key(p: LngLat) {
    return `${Math.floor(p[0] / this.cellLng)}:${Math.floor(p[1] / this.cellLat)}`;
  }

  /** 0(깜깜) ~ 1(시설 바로 옆) */
  coverAt(p: LngLat): number {
    const cx = Math.floor(p[0] / this.cellLng);
    const cy = Math.floor(p[1] / this.cellLat);
    let best = Infinity;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        const arr = this.cells.get(`${x}:${y}`);
        if (!arr) continue;
        for (const q of arr) {
          const d = distMeters(p, q);
          if (d < best) best = d;
        }
      }
    }
    if (!Number.isFinite(best)) return 0;
    if (best <= SafetyIndex.NEAR_M) return 1;
    if (best >= SafetyIndex.FAR_M) return 0;
    return 1 - (best - SafetyIndex.NEAR_M) / (SafetyIndex.FAR_M - SafetyIndex.NEAR_M);
  }
}
