/**
 * 노선 형상 — 정류장을 실제 길 위에 얹는 일.
 *
 * 정류장 좌표만 이어 그리면 지도에서 버스가 건물을 뚫고 가고, 거리도 실제보다 짧게
 * 나온다. 그래서 길 좌표(버스는 TOPIS 노선형상, 지하철은 OSM 선로)를 받아
 * 정류장이 그 위 어디쯤인지 찾아 두고, 탄 구간만 잘라 쓴다.
 */

import { distMeters, simplifyPath, type LngLat } from "./geo";

/** 형상을 줄일 때 허용하는 오차(m) — 지도에 그리는 용도라 이 정도면 모양이 유지된다 */
export const SHAPE_TOLERANCE_M = 8;
/** 정류장을 형상 위 점에 맞출 때 허용하는 거리(m) */
const STOP_SNAP_M = 150;
/** 첫 정류장이 붙을 만한 자리를 고를 때 쓰는 거리(m) — 넓게 잡으면 정렬이 흔들린다 */
const SEED_SNAP_M = 80;
/** 두 정류장 사이 형상 길이가 직선거리의 이 배를 넘으면 엉뚱한 곳에 붙은 것이다 */
const SPAN_SLACK = 3;
/** 조각난 길을 이어 붙일 때, 끝점이 이만큼 안이면 같은 자리로 본다 */
const JOIN_M = 30;

export type Shaped = { shape: LngLat[]; stopIndex: number[] };

/** 형상을 따라간 누적 거리(m) */
function cumulative(shape: LngLat[]) {
  const cum = new Float64Array(shape.length);
  for (let i = 1; i < shape.length; i++) cum[i] = cum[i - 1] + distMeters(shape[i - 1], shape[i]);
  return cum;
}

/**
 * 첫 정류장 자리를 정해 놓고, 뒤 정류장을 앞으로만 이어 붙인다.
 * 다음 정류장은 직선거리의 몇 배 안에서만 찾는다 — 멀리까지 뒤지면
 * 같은 길의 반대 방향 점에 붙어 경로가 되돌아간다.
 */
function alignFrom(shape: LngLat[], cum: Float64Array, stops: LngLat[], seed: number) {
  const idx = [seed];
  let cost = distMeters(stops[0], shape[seed]);
  let cursor = seed;
  for (let k = 1; k < stops.length; k++) {
    const limit = cum[cursor] + SPAN_SLACK * distMeters(stops[k - 1], stops[k]) + 300;
    let best = -1;
    let bestD = STOP_SNAP_M;
    for (let i = cursor + 1; i < shape.length && cum[i] <= limit; i++) {
      const d = distMeters(stops[k], shape[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    idx.push(best);
    cost += bestD;
    cursor = best;
  }
  return { idx, cost: cost / stops.length };
}

/**
 * 정류장을 형상 위의 점에 순서대로 맞춘다.
 *
 * 형상은 갈 때와 올 때가 한 줄로 이어져 있고, 마을버스처럼 같은 길을 두 번 지나는
 * 노선도 흔하다. 그래서 "가장 가까운 점" 하나만 보면 반대 방향 자리에 붙어 버린다.
 * 첫 정류장이 붙을 만한 자리를 모두 후보로 두고, 전체가 가장 잘 맞는 정렬을 고른다.
 */
function matchStops(shape: LngLat[], stops: LngLat[]): number[] | null {
  const cum = cumulative(shape);

  const seeds: number[] = [];
  for (let i = 0; i < shape.length; i++) {
    const d = distMeters(stops[0], shape[i]);
    if (d > SEED_SNAP_M) continue;
    // 같은 자리에서 이어지는 점들은 가장 가까운 하나로 묶는다
    const prev = seeds[seeds.length - 1];
    if (prev != null && cum[i] - cum[prev] < 200) {
      if (d < distMeters(stops[0], shape[prev])) seeds[seeds.length - 1] = i;
      continue;
    }
    seeds.push(i);
  }

  let best: { idx: number[]; cost: number } | null = null;
  for (const seed of seeds) {
    const got = alignFrom(shape, cum, stops, seed);
    if (got && (!best || got.cost < best.cost)) best = got;
  }
  return best?.idx ?? null;
}

/**
 * 맞춘 정류장 사이를 구간별로 줄여, 정류장이 형상의 몇 번째 점인지까지 함께 낸다.
 * 구간마다 따로 줄이므로 정류장 자리는 그대로 남는다.
 */
function trimShape(raw: LngLat[], idx: number[]): Shaped {
  const shape: LngLat[] = [raw[idx[0]]];
  const stopIndex: number[] = [0];
  for (let k = 1; k < idx.length; k++) {
    const span = simplifyPath(raw.slice(idx[k - 1], idx[k] + 1), SHAPE_TOLERANCE_M);
    // span[0] 은 앞 정류장 자리라 이미 들어가 있다
    for (let i = 1; i < span.length; i++) shape.push(span[i]);
    stopIndex.push(shape.length - 1);
  }
  return { shape, stopIndex };
}

/** 정류장 전부를 길 위에 얹는다 (노선 형상을 통째로 받은 버스) */
export function shapeAlong(path: LngLat[], stops: LngLat[]): Shaped | null {
  if (path.length < 2 || stops.length < 2) return null;
  const idx = matchStops(path, stops);
  if (!idx) return null;
  return trimShape(path, idx);
}

/**
 * 일부만 얹어도 되는 경우 — 지하철 선로는 출발~도착 사이만 받아 오므로
 * 노선 양 끝 역은 길 위에 없다. 맞추지 못한 자리는 -1 로 남긴다.
 *
 * @param stops 맞출 수 없는 자리는 null 로 넘긴다
 */
export function shapePartly(path: LngLat[], stops: (LngLat | null)[]): Shaped | null {
  const from = stops.findIndex((s) => !!s);
  if (from < 0) return null;
  let to = from;
  while (to + 1 < stops.length && stops[to + 1]) to++;
  if (to - from < 1) return null;

  const got = shapeAlong(path, stops.slice(from, to + 1) as LngLat[]);
  if (!got) return null;

  const stopIndex = stops.map(() => -1);
  for (let k = from; k <= to; k++) stopIndex[k] = got.stopIndex[k - from];
  return { shape: got.shape, stopIndex };
}

/**
 * 조각난 길을 진행 순서대로 이어 붙인다.
 *
 * 노선 관계는 선로를 지나는 순서대로 담고 있지만 조각 하나하나의 방향은 제각각이라,
 * 끝점을 맞춰 가며 뒤집는다. 이어지지 않는 자리(받아 온 범위 밖)에서는 끊고 새로 시작한다.
 */
export function chainPaths(parts: LngLat[][]): LngLat[][] {
  const out: LngLat[][] = [];
  let cur: LngLat[] = [];
  let linked = false; // 지금 조각이 다른 조각과 이어져 방향이 정해졌는지

  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
    linked = false;
  };

  for (const part of parts) {
    if (part.length < 2) continue;
    if (!cur.length) {
      cur = [...part];
      continue;
    }
    const rev = [...part].reverse();
    /*
     * 아직 이어 본 적 없는 첫 조각은 방향을 모른다. 그래서 이번엔 cur 쪽도 뒤집어 본다.
     * 한 번 이어진 뒤로는 cur 의 방향이 정해졌으므로 뒤 끝만 본다.
     */
    const tries = linked
      ? [
          { d: distMeters(cur[cur.length - 1], part[0]), next: part },
          { d: distMeters(cur[cur.length - 1], rev[0]), next: rev },
        ]
      : [
          { d: distMeters(cur[cur.length - 1], part[0]), next: part, flip: false },
          { d: distMeters(cur[cur.length - 1], rev[0]), next: rev, flip: false },
          { d: distMeters(cur[0], part[0]), next: part, flip: true },
          { d: distMeters(cur[0], rev[0]), next: rev, flip: true },
        ];
    const best = tries.reduce((a, b) => (b.d < a.d ? b : a));
    if (best.d > JOIN_M) {
      flush();
      cur = [...part];
      continue;
    }
    if ("flip" in best && best.flip) cur.reverse();
    cur.push(...best.next.slice(1));
    linked = true;
  }
  flush();
  return out;
}
