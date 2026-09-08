/**
 * 대중교통 — OpenStreetMap 의 노선 관계(route relation)로 정류장 순서를 읽어
 * "출발지 근처에서 타서 목적지 근처에서 내리는" 조합을 찾는다.
 *
 * 시간표·실시간 도착 정보는 쓰지 않는다. 소요 시간은 정류장 사이 거리와
 * 수단별 평균 통행 속도로 추정하고, 대기 시간은 배차 평균값을 더한다.
 */

import { distMeters, type LngLat } from "./geo";

export type TransitMode = "bus" | "subway" | "tram" | "train";

export type TransitStop = {
  id: string;
  name: string;
  p: LngLat;
  mode: TransitMode;
};

export type TransitPattern = {
  id: string;
  /** 노선 번호 (버스 500, 지하철 7호선 등) */
  ref: string;
  name: string;
  mode: TransitMode;
  colour?: string;
  /** 방향 표기 ("→ 서울역") */
  headsign?: string;
  /** 정류장 id 를 지나는 순서대로 */
  stops: string[];
};

export type TransitData = {
  stops: TransitStop[];
  patterns: TransitPattern[];
  fetchedAt: number;
};

/** 수단별 평균 통행 속도(m/s) — 정차 시간을 포함한 표정속도 */
export const MODE_SPEED: Record<TransitMode, number> = {
  bus: 4.4, // 약 16km/h
  subway: 8.9, // 약 32km/h
  tram: 5.6,
  train: 12.5,
};

/** 수단별 평균 대기 시간(초) — 배차 간격의 절반 어림값 */
export const MODE_WAIT: Record<TransitMode, number> = {
  bus: 240,
  subway: 180,
  tram: 240,
  train: 420,
};

/** 수단별 기본요금(원) — 2024년 수도권 성인 교통카드 기준 */
export const MODE_FARE: Record<TransitMode, number> = {
  bus: 1500,
  subway: 1400,
  tram: 1500,
  train: 1400,
};

export const MODE_LABEL: Record<TransitMode, string> = {
  bus: "버스",
  subway: "지하철",
  tram: "트램",
  train: "열차",
};

/** 정류장까지 걸어갈 수 있다고 보는 최대 직선거리(m) */
export const ACCESS_RADIUS_M = 800;
/** 환승 도보로 인정하는 최대 직선거리(m) */
const TRANSFER_RADIUS_M = 260;
/** 도보 추정용 — 직선거리에 곱하는 우회 계수 */
const WALK_DETOUR = 1.3;
const WALK_MPS = 1.25;
/** 환승 한 번에 붙이는 심리적 비용(초) */
const TRANSFER_PENALTY_S = 180;
/** 첫 구간이 이보다 오래 걸리면 환승 후보로 두지 않는다 */
const MAX_FIRST_LEG_S = 55 * 60;
/** 환승 지점 후보 수 상한 — 빠른 순으로 자른다 */
const MAX_TRANSFER_HUBS = 40;
/**
 * 이보다 짧은 승차 구간은 만들지 않는다.
 * 한두 정류장을 위해 기다렸다 타는 안내는 실제로는 걷느니만 못하다.
 */
const MIN_RIDE_M = 450;
/**
 * 타고 가서 실제로 가까워져야 한다. 승차·하차 정류장의 목적지까지 거리 차이가
 * 주행 거리의 이만큼은 돼야 후보로 인정한다.
 * (이게 없으면 목적지 반대쪽으로 한 정거장 갔다가 되돌아 걷는 경로가 만들어진다)
 */
const MIN_PROGRESS_RATIO = 0.35;
const MIN_PROGRESS_M = 250;
/** 접근·하차 도보를 합쳐 이보다 멀면, 타는 것보다 걷는 게 낫다 */
const walkBudget = (straight: number) => Math.max(700, straight * 1.15);

export async function fetchTransit(
  origin: LngLat,
  destination: LngLat,
  signal?: AbortSignal
): Promise<TransitData> {
  const qs = new URLSearchParams({
    a: `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`,
    b: `${destination[0].toFixed(6)},${destination[1].toFixed(6)}`,
    r: String(ACCESS_RADIUS_M),
  });
  const res = await fetch(`/api/transit?${qs}`, { signal });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `대중교통 노선을 불러오지 못했습니다 (${res.status})`);
  }
  return res.json();
}

export type RideSpec = {
  pattern: TransitPattern;
  from: TransitStop;
  to: TransitStop;
  /** 타는 정류장을 뺀 정차 수 */
  stopCount: number;
  /** 정류장을 이은 주행 경로 */
  path: LngLat[];
  distance: number;
  rideSec: number;
  waitSec: number;
};

export type TransitCandidate = {
  id: string;
  rides: RideSpec[];
  /** 출발지 → 첫 정류장 직선거리 */
  accessMeters: number;
  /** 마지막 정류장 → 목적지 직선거리 */
  egressMeters: number;
  /** 환승 도보 직선거리 합 */
  transferMeters: number;
  /** 도보 추정치까지 더한 총 소요(초) — 정렬용 */
  estimateSec: number;
};

const walkSec = (meters: number) => (meters * WALK_DETOUR) / WALK_MPS;

function rideOf(
  pattern: TransitPattern,
  stopsById: Map<string, TransitStop>,
  i: number,
  j: number
): RideSpec | null {
  const from = stopsById.get(pattern.stops[i]);
  const to = stopsById.get(pattern.stops[j]);
  if (!from || !to) return null;

  const path: LngLat[] = [];
  let distance = 0;
  let prev: LngLat | null = null;
  for (let k = i; k <= j; k++) {
    const s = stopsById.get(pattern.stops[k]);
    if (!s) continue;
    if (prev) distance += distMeters(prev, s.p);
    path.push(s.p);
    prev = s.p;
  }
  if (path.length < 2 || distance < MIN_RIDE_M) return null;

  return {
    pattern,
    from,
    to,
    stopCount: j - i,
    path,
    distance,
    rideSec: distance / MODE_SPEED[pattern.mode],
    waitSec: MODE_WAIT[pattern.mode],
  };
}

type Boarding = { pattern: TransitPattern; index: number };

/**
 * 직행 + 1회 환승 조합을 찾아 소요 시간 순으로 돌려준다.
 * 도보 구간은 여기서는 직선거리로만 어림잡고, 실제 그늘 경로는 나중에 한 번 더 계산한다.
 */
export function planTransit(
  data: TransitData,
  origin: LngLat,
  destination: LngLat,
  limit = 4
): TransitCandidate[] {
  const stopsById = new Map(data.stops.map((s) => [s.id, s]));
  const boardings = new Map<string, Boarding[]>();
  for (const pattern of data.patterns) {
    pattern.stops.forEach((id, index) => {
      const arr = boardings.get(id);
      if (arr) arr.push({ pattern, index });
      else boardings.set(id, [{ pattern, index }]);
    });
  }

  const straight = distMeters(origin, destination);
  const near = (p: LngLat, radius: number) =>
    data.stops
      .map((s) => ({ s, d: distMeters(p, s.p) }))
      .filter((x) => x.d <= radius)
      .sort((a, b) => a.d - b.d);

  const originStops = near(origin, ACCESS_RADIUS_M).slice(0, 14);
  const destStops = near(destination, ACCESS_RADIUS_M).slice(0, 14);
  if (!originStops.length || !destStops.length) return [];

  const egressOf = new Map(destStops.map((x) => [x.s.id, x.d]));
  const out: TransitCandidate[] = [];

  /** 첫 승차 지점들 */
  const seeds = originStops.flatMap(({ s, d }) =>
    (boardings.get(s.id) ?? []).map((b) => ({ board: b, accessMeters: d }))
  );

  /** 타는 구간이 목적지 쪽으로 얼마나 데려다주는지 (m) */
  const progressOf = (ride: RideSpec) =>
    distMeters(ride.from.p, destination) - distMeters(ride.to.p, destination);

  const worthRiding = (ride: RideSpec) => {
    const progress = progressOf(ride);
    return progress >= MIN_PROGRESS_M && progress >= ride.distance * MIN_PROGRESS_RATIO;
  };

  // 1) 직행
  for (const { board, accessMeters } of seeds) {
    const { pattern, index } = board;
    for (let j = index + 1; j < pattern.stops.length; j++) {
      const egress = egressOf.get(pattern.stops[j]);
      if (egress === undefined) continue;
      const ride = rideOf(pattern, stopsById, index, j);
      if (!ride) continue;
      // 걸어가는 편이 나은 조합, 목적지 쪽으로 가지 않는 조합은 버린다
      if (ride.distance < straight * 0.35) continue;
      if (!worthRiding(ride)) continue;
      if (accessMeters + egress > walkBudget(straight)) continue;
      out.push({
        id: `${pattern.id}:${index}-${j}`,
        rides: [ride],
        accessMeters,
        egressMeters: egress,
        transferMeters: 0,
        estimateSec:
          walkSec(accessMeters) + ride.waitSec + ride.rideSec + walkSec(egress),
      });
    }
  }

  /*
   * 2) 1회 환승.
   *
   * "목적지에 가까워지는 정류장에서만 갈아탄다" 는 식으로 지도상 거리로 자르면
   * 실제 노선망에서 흔한 환승(한 번 지나쳤다가 다른 노선으로 되돌아오는 경우)을 놓친다.
   * 그래서 지리 대신 **시간**으로 자른다 — 여기까지 오는 데 오래 걸린 정류장부터 버린다.
   */
  type Reach = { ride: RideSpec; accessMeters: number; cost: number };
  const reachAll = new Map<string, Reach>();
  for (const { board, accessMeters } of seeds) {
    const { pattern, index } = board;
    for (let j = index + 1; j < pattern.stops.length; j++) {
      const stop = stopsById.get(pattern.stops[j]);
      if (!stop) continue;
      const ride = rideOf(pattern, stopsById, index, j);
      if (!ride) continue;
      // 첫 구간도 목적지 쪽으로 가야 한다 (되돌아가는 환승은 여기서 걸러진다)
      if (progressOf(ride) < MIN_PROGRESS_M) continue;
      const cost = walkSec(accessMeters) + ride.waitSec + ride.rideSec;
      if (cost > MAX_FIRST_LEG_S) continue;
      const prev = reachAll.get(stop.id);
      if (!prev || cost < prev.cost) reachAll.set(stop.id, { ride, accessMeters, cost });
    }
  }
  const reach = [...reachAll.entries()]
    .sort((x, y) => x[1].cost - y[1].cost)
    .slice(0, MAX_TRANSFER_HUBS);

  for (const [stopId, first] of reach) {
    const hub = stopsById.get(stopId);
    if (!hub) continue;
    // 같은 정류장 또는 걸어서 갈아탈 수 있는 이웃 정류장
    const transferStops = data.stops
      .map((s) => ({ s, d: s.id === stopId ? 0 : distMeters(hub.p, s.p) }))
      .filter((x) => x.d <= TRANSFER_RADIUS_M);

    for (const { s: t, d: transferMeters } of transferStops) {
      for (const board of boardings.get(t.id) ?? []) {
        if (board.pattern.id === first.ride.pattern.id) continue;
        // 같은 노선의 다른 방향으로 갈아타는 건 환승이 아니라 되돌아가는 것이다
        if (
          board.pattern.mode === first.ride.pattern.mode &&
          board.pattern.ref &&
          board.pattern.ref === first.ride.pattern.ref
        )
          continue;
        for (let j = board.index + 1; j < board.pattern.stops.length; j++) {
          const egress = egressOf.get(board.pattern.stops[j]);
          if (egress === undefined) continue;
          const second = rideOf(board.pattern, stopsById, board.index, j);
          if (!second) continue;
          if (!worthRiding(second)) continue;
          if (first.accessMeters + egress > walkBudget(straight)) continue;
          out.push({
            id: `${first.ride.pattern.id}>${board.pattern.id}:${stopId}`,
            rides: [first.ride, second],
            accessMeters: first.accessMeters,
            egressMeters: egress,
            transferMeters,
            estimateSec:
              first.cost +
              walkSec(transferMeters) +
              TRANSFER_PENALTY_S +
              second.waitSec +
              second.rideSec +
              walkSec(egress),
          });
        }
      }
    }
  }

  out.sort((a, b) => a.estimateSec - b.estimateSec);

  // 같은 노선 조합은 하나만 남긴다
  const seen = new Set<string>();
  const picked: TransitCandidate[] = [];
  for (const c of out) {
    const key = c.rides.map((r) => `${r.pattern.mode}${r.pattern.ref || r.pattern.name}`).join(">");
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  return picked;
}
