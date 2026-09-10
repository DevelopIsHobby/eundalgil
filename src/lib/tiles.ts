/**
 * 지도 데이터를 **고정 격자(타일)** 단위로 다룬다.
 *
 * 예전에는 요청한 범위 모양 그대로 받아서 캐시했다. 그러면 출발지를 한 블록만 옮겨도
 * 범위가 달라져 캐시가 통째로 빗나가고, 공개 Overpass 에 다시 줄을 섰다.
 * 격자를 고정해 두면 같은 타일을 여러 요청이 나눠 쓰고, **미리 받아 둘 수도 있다** —
 * 서울 전체가 88타일이라 한 번 받아 두면 런타임에 Overpass 를 부를 일이 없다.
 *
 * 타일 크기는 실측으로 정했다. 0.04°(3.5km × 4.4km)가 강남 한복판 기준 4초·1.7MB 였다.
 * 더 잘게 쪼개면 요청 수만 늘고(0.02°면 330타일), 더 키우면 미러가 504 로 끊는다.
 */

import { bboxIntersects, type BBox, type LngLat } from "./geo";

export const TILE_DEG = 0.04;

/**
 * 서울 + 경계에 걸친 동네까지. 이 밖은 안내하지 않는다.
 * (한강 이북 도봉·강북, 이남 금천·강남을 모두 덮는다)
 */
export const SEOUL: BBox = { minLng: 126.75, minLat: 37.41, maxLng: 127.19, maxLat: 37.71 };

export type Tile = { x: number; y: number };

/** 타일 번호는 경도·위도를 격자로 나눈 몫이다 (음수 좌표는 쓰지 않으므로 floor 로 충분) */
export function tileAt(lng: number, lat: number): Tile {
  return { x: Math.floor(lng / TILE_DEG), y: Math.floor(lat / TILE_DEG) };
}

export function tileBBox(t: Tile): BBox {
  return {
    minLng: t.x * TILE_DEG,
    minLat: t.y * TILE_DEG,
    maxLng: (t.x + 1) * TILE_DEG,
    maxLat: (t.y + 1) * TILE_DEG,
  };
}

export const tileKey = (t: Tile) => `${t.x}_${t.y}`;

/** 이 범위를 덮는 타일들 */
export function tilesCovering(b: BBox): Tile[] {
  const lo = tileAt(b.minLng, b.minLat);
  const hi = tileAt(b.maxLng, b.maxLat);
  const out: Tile[] = [];
  for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) out.push({ x, y });
  return out;
}

/** 서울 안(또는 걸침)인지 */
export const inSeoul = (b: BBox) => bboxIntersects(SEOUL, b);
export const pointInSeoul = (p: LngLat) =>
  p[0] >= SEOUL.minLng && p[0] <= SEOUL.maxLng && p[1] >= SEOUL.minLat && p[1] <= SEOUL.maxLat;

/** 서울을 덮는 타일 전부 — 미리 받아 둘 때 쓴다 */
export function seoulTiles(): Tile[] {
  return tilesCovering(SEOUL);
}
