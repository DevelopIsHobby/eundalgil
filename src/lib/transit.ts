/**
 * 대중교통 — OpenStreetMap 의 노선 관계(route relation)로 정류장 순서를 읽어
 * "출발지 근처에서 타서 목적지 근처에서 내리는" 조합을 찾는다.
 *
 * 시간표·실시간 도착 정보는 쓰지 않는다. 소요 시간은 정류장 사이 거리와
 * 수단별 평균 통행 속도로 추정하고, 대기 시간은 배차 평균값을 더한다.
 */

import { distMeters, pathLength, type LngLat } from "./geo";

export type TransitMode = "bus" | "subway" | "tram" | "train";

/**
 * 실시간 도착정보를 물어볼 때 쓰는 원본 식별자.
 * 서울(TOPIS)은 정류소 고유번호(arsId), 그 밖(TAGO)은 도시코드 + 정류소 id 가 있어야 부른다.
 */
export type StopLive =
  | { src: "seoul"; arsId: string }
  | { src: "tago"; cityCode: string; nodeId: string };

/** 도착정보 응답을 노선에 맞춰 붙일 때 쓰는 노선 식별자 */
export type PatternLive = { src: "seoul" | "tago"; routeId: string };

export type TransitStop = {
  id: string;
  name: string;
  p: LngLat;
  mode: TransitMode;
  /** 버스만 붙는다 — 지하철은 실시간 도착을 받지 않는다 */
  live?: StopLive;
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
  /** 버스만 — 실시간 도착정보를 이 노선에 맞춰 붙일 때 쓴다 */
  live?: PatternLive;
  /**
   * 정류장 사이 구간마다 **지상으로 달리는 비율**(0~1). 길이는 stops.length - 1.
   * null 은 "지상이다" 가 아니라 그 구간 선로 정보가 없다는 뜻이다.
   * 지하 구간에는 햇빛이 들지 않으므로 자리 추천에서 빼야 한다.
   */
  aboveGround?: (number | null)[];
  /**
   * 노선이 실제로 지나는 길의 좌표열. 없으면 정류장을 직선으로 잇는다 —
   * 그러면 지도에서 버스가 건물을 뚫고 가는 것처럼 보인다.
   */
  shape?: LngLat[];
  /** stops[k] 가 shape 의 몇 번째 점인지. 길이는 stops 와 같다 */
  stopIndex?: number[];
};

export type TransitData = {
  stops: TransitStop[];
  patterns: TransitPattern[];
  /** 버스 정보를 못 받았을 때 그 이유 (키 미신청 등) */
  notice?: string;
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

/**
 * 정류장까지 걸어갈 수 있다고 보는 최대 직선거리(m) — 수단마다 다르다.
 *
 * 지하철은 한 정거장이 멀리 데려다주니 사람들이 더 걸어서라도 탄다.
 * 800m 로 묶어 두면 상도동 → 대치동처럼 "역까지 1km" 인 구간에서 지하철이
 * 통째로 후보에서 빠지고 버스만 남는다. (삼성중앙역이 993m 라 잘렸었다)
 */
export const ACCESS_RADIUS_M: Record<TransitMode, number> = {
  bus: 1200,
  subway: 1200,
  tram: 1000,
  train: 1200,
};

/** 정류장을 찾아 달라고 서버에 넘길 반경 — 가장 넓은 수단에 맞춘다 */
export const SEARCH_RADIUS_M = Math.max(...Object.values(ACCESS_RADIUS_M));

/**
 * 한쪽 끝에서 고를 정류장 수 — 수단마다 따로 센다.
 *
 * 가까운 순으로 자르면 안 된다. 봉천역 앞처럼 같은 이름 정류장이 촘촘한 곳에서는
 * 가장 가까운 여섯 곳이 전부 "봉천역" 으로 채워지고, 정작 타야 할 노선이 서는
 * "봉천역.관악초등학교"(162m)가 밀려난다. 실제로 500번 직행이 후보에서 빠져
 * 환승 경로가 추천되던 버그가 여기서 났다.
 *
 * 그래서 **노선을 기준으로 고른다** — 가까운 순으로 보되, 이미 잡은 정류장에 없는
 * 노선을 하나라도 더해 주는 곳만 남긴다.
 *
 * 가장 가까운 두 곳은 노선이 겹쳐도 남긴다 — "코앞에서 타기" 는 사람들이 실제로 하는
 * 선택이라, 노선이 이미 잡혀 있다는 이유로 지울 것이 아니다.
 */
const MAX_ACCESS_PER_MODE = 12;
const ALWAYS_NEAREST = 2;
/** 환승 도보로 인정하는 최대 직선거리(m) */
export const TRANSFER_RADIUS_M = 260;
/**
 * 도보 추정용 — 직선거리에 곱하는 우회 계수.
 *
 * 후보를 고를 때는 걷는 길을 실제로 계산하지 않고 직선거리로 어림한다. 그 값이 낮으면
 * **많이 걷는 안이 실제보다 좋아 보여** 좋은 안을 밀어낸다. 상도동 → 대치동에서
 * 추정 54분짜리가 계산 뒤엔 61분이 되던 게 그래서였다.
 *
 * 실측(상도·중앙대·광화문·잠실 구간 도보 16개)으로 다시 잡았다 —
 * 직선 대비 실제 거리가 중앙값 1.43, 4분위 1.39~1.64 였다. 1.3 은 너무 낮았다.
 */
const WALK_DETOUR = 1.45;
/** 환승 한 번에 붙이는 심리적 비용(초) */
const TRANSFER_PENALTY_S = 180;
/** 첫 구간이 이보다 오래 걸리면 환승 후보로 두지 않는다 */
const MAX_FIRST_LEG_S = 55 * 60;
/** 환승 지점 후보 수 상한 — 빠른 순으로 자른다 */
const MAX_TRANSFER_HUBS = 160;
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
/** 갈아타러 가는 첫 구간이 목적지에서 멀어져도 되는 한도 — 전체 직선거리 대비 */
const BACKTRACK_RATIO = 0.15;
/**
 * 접근·하차 도보 합의 상한 — 여기 걸리면 후보로 만들지도 않는다.
 *
 * 예전에는 `직선거리 × 1.15` 로 빡빡하게 잡았다. 엉터리 경로를 막으려던 것인데,
 * 지금은 "타고 가서 가까워져야 한다"는 규칙과 "실제로 걸어 본 뒤 걷는 것보다 느리면
 * 버린다"는 규칙이 그 일을 대신한다. 빡빡한 상한은 오히려 **역까지 걸어 나가서 좋은
 * 노선을 타는** 멀쩡한 안(상도동에서 1.2km 걸어 상도역, 거기서 마을버스)을 잘라 냈다.
 * 그래서 계산량만 막을 만큼 느슨하게 둔다.
 */
const walkBudget = (straight: number) => Math.max(1600, straight * 1.6);

export async function fetchTransit(
  origin: LngLat,
  destination: LngLat,
  signal?: AbortSignal
): Promise<TransitData> {
  const qs = new URLSearchParams({
    a: `${origin[0].toFixed(6)},${origin[1].toFixed(6)}`,
    b: `${destination[0].toFixed(6)},${destination[1].toFixed(6)}`,
    r: String(SEARCH_RADIUS_M),
  });
  const res = await fetch(`/api/transit?${qs}`, { signal });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `대중교통 노선을 불러오지 못했습니다 (${res.status})`);
  }
  return res.json();
}

/* ─────────────────────────── 실시간 도착정보 ─────────────────────────── */

/**
 * "지금 오고 있는 차" 로 볼 최대 남은 시간(초).
 * 이보다 먼 예측은 배차간격 어림값과 다를 게 없어 쓰지 않는다.
 */
export const ARRIVAL_HORIZON_S = 45 * 60;

/**
 * 정류장에 닿는 시각이 도착정보를 받은 때로부터 이보다 뒤면 실시간을 쓰지 않는다.
 * (환승 두 번째 구간처럼 30분 뒤에 탈 차는 지금 예측에 잡히지 않는다)
 */
export const LIVE_USABLE_S = 30 * 60;

/** 차를 놓치지 않으려면 도착보다 이만큼은 먼저 정류장에 있어야 한다(초) */
export const BOARD_MARGIN_S = 20;

/** 정류장으로 다가오는 차 한 대 */
export type Arrival = {
  stopId: string;
  /** pattern.live.routeId 와 맞춘다 */
  routeId: string;
  /** 받은 시각(ArrivalData.fetchedAt)부터 도착까지 남은 시간(초) */
  sec: number;
  /** 몇 정류장 전에 있는지 */
  stopsAway?: number;
  /** "2분후[2번째 전]" 같은 원문 — 있으면 그대로 보여 준다 */
  message?: string;
  full?: boolean;
  last?: boolean;
  /** 저상버스 */
  lowFloor?: boolean;
};

/** 노선의 배차간격(분) — 실시간 차가 안 잡힐 때 평균 대기를 이 값으로 대신한다 */
export type Headway = { stopId: string; routeId: string; minutes: number };

export type ArrivalData = {
  arrivals: Arrival[];
  headways: Headway[];
  /** sec 는 이 시각 기준이다 */
  fetchedAt: number;
  /** 못 받았으면 그 이유 */
  notice?: string;
};

export type ArrivalIndex = {
  fetchedAt: number;
  /** 이 정류장에 오는 이 노선의 차들 — 이른 순 */
  buses: (stopId: string, routeId: string) => Arrival[];
  /** 배차간격(초). 모르면 undefined */
  headwaySec: (stopId: string, routeId: string) => number | undefined;
};

export function indexArrivals(data: ArrivalData): ArrivalIndex {
  const buses = new Map<string, Arrival[]>();
  for (const a of data.arrivals) {
    const key = `${a.stopId}|${a.routeId}`;
    const list = buses.get(key);
    if (list) list.push(a);
    else buses.set(key, [a]);
  }
  for (const list of buses.values()) list.sort((x, y) => x.sec - y.sec);

  const head = new Map<string, number>();
  for (const h of data.headways) head.set(`${h.stopId}|${h.routeId}`, h.minutes * 60);

  return {
    fetchedAt: data.fetchedAt,
    buses: (stopId, routeId) => buses.get(`${stopId}|${routeId}`) ?? [],
    headwaySec: (stopId, routeId) => head.get(`${stopId}|${routeId}`),
  };
}

/** 정류장 여러 곳의 실시간 도착정보를 한 번에 받아 온다 */
export async function fetchArrivals(
  stops: TransitStop[],
  signal?: AbortSignal
): Promise<ArrivalData | null> {
  const wanted = stops.filter((s) => s.live);
  if (!wanted.length) return null;
  const res = await fetch("/api/arrivals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stops: wanted.map((s) => ({ id: s.id, live: s.live })) }),
    signal,
  });
  if (!res.ok) throw new Error(`실시간 도착정보를 불러오지 못했습니다 (${res.status})`);
  return res.json();
}

export type RideSpec = {
  pattern: TransitPattern;
  /**
   * 같은 정류장 사이를 함께 다니는 다른 노선 — 먼저 오는 걸 타면 된다.
   * 실시간 정보가 있으면 이 중 가장 빨리 오는 차로 대기 시간을 잡는다.
   */
  alts?: { ref: string; live?: PatternLive }[];
  from: TransitStop;
  to: TransitStop;
  /** 타는 정류장을 뺀 정차 수 */
  stopCount: number;
  /** 정류장을 이은 주행 경로 */
  path: LngLat[];
  /** path 의 구간마다 지상으로 달리는 비율 — 길이는 path.length - 1 */
  surface?: (number | null)[];
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

/** 걷는 속도는 취향에 따라 다르다. 추정도 그 속도로 해야 순위가 맞는다 */
const walkSecAt = (speedMps: number) => (meters: number) => (meters * WALK_DETOUR) / speedMps;

/**
 * 길 좌표가 없을 때 쓰는 어림 구간 — 정류장을 곧장 이은 것이다.
 * **순위를 매기는 1차 계산에만 쓰고 화면에는 내보내지 않는다.**
 * 이 좌표가 그대로 그려지면 지도에 없는 직선 도로가 생긴다.
 */
function roughRide(
  pattern: TransitPattern,
  stopsById: Map<string, TransitStop>,
  i: number,
  j: number,
  from: TransitStop,
  to: TransitStop
): RideSpec | null {
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

/**
 * @param needShape 길 좌표가 있는 구간만 인정할지.
 *   후보를 고르는 1차 계산에서는 false 다 — 그때는 아직 형상을 받기 전이고,
 *   여기서 만든 직선 좌표는 순위를 매기는 데만 쓰고 화면에는 나가지 않는다.
 *   화면에 올릴 2차 계산은 true 로 불러, 길을 모르는 구간을 통째로 뺀다.
 */
function rideOf(
  pattern: TransitPattern,
  stopsById: Map<string, TransitStop>,
  i: number,
  j: number,
  needShape: boolean
): RideSpec | null {
  const from = stopsById.get(pattern.stops[i]);
  const to = stopsById.get(pattern.stops[j]);
  if (!from || !to) return null;

  /*
   * 길 좌표(버스는 노선형상, 지하철은 선로)가 있어야 안내한다.
   * 정류장만 직선으로 이으면 지도에서 건물을 뚫고 가고 거리도 실제보다 짧게 나온다.
   * 길을 모르는 구간은 그럴듯하게 그리느니 아예 내놓지 않는다.
   */
  const si = pattern.stopIndex;
  const shaped = !!pattern.shape && !!si && si.length === pattern.stops.length && si[i] >= 0 && si[j] > si[i];
  if (!shaped) return needShape ? null : roughRide(pattern, stopsById, i, j, from, to);

  const path = pattern.shape!.slice(si![i], si![j] + 1);
  const distance = pathLength(path);
  if (path.length < 2 || distance < MIN_RIDE_M) return null;

  /*
   * 지상 비율은 정류장 사이 단위로 재 놓은 값이다.
   * 형상은 그보다 잘게 나뉘므로, 구간이 차지하는 선분 수만큼 펴서 맞춘다.
   */
  const surface: (number | null)[] = [];
  for (let k = i; k < j; k++) {
    const ratio = pattern.aboveGround?.[k] ?? null;
    for (let s = si![k]; s < si![k + 1]; s++) surface.push(ratio);
  }

  return {
    pattern,
    from,
    to,
    stopCount: j - i,
    path,
    surface: surface.length === path.length - 1 ? surface : undefined,
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
  limit = 4,
  /** 길 좌표가 있는 구간만 인정할지 — 화면에 올릴 계산은 true */
  needShape = false,
  /** 걷는 속도(m/s) — 취향 설정을 그대로 받는다 */
  speedMps = 1.25
): TransitCandidate[] {
  const walkSec = walkSecAt(speedMps);
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

  /*
   * 걸어서 갈 수 있는 정류장. 수단별로 나눠서 고른다 —
   * 한 덩어리로 놓고 가까운 순으로 자르면 촘촘한 버스정류장이 역을 밀어낸다.
   */
  const near = (p: LngLat) => {
    const byMode = new Map<TransitMode, { s: TransitStop; d: number }[]>();
    for (const s of data.stops) {
      const d = distMeters(p, s.p);
      if (d > ACCESS_RADIUS_M[s.mode]) continue;
      const arr = byMode.get(s.mode);
      if (arr) arr.push({ s, d });
      else byMode.set(s.mode, [{ s, d }]);
    }
    const out: { s: TransitStop; d: number }[] = [];
    for (const arr of byMode.values()) {
      arr.sort((x, y) => x.d - y.d);
      const covered = new Set<string>();
      let taken = 0;
      for (const item of arr) {
        if (taken >= MAX_ACCESS_PER_MODE) break;
        const here = boardings.get(item.s.id) ?? [];
        const adds = here.some((b) => !covered.has(b.pattern.id));
        if (taken >= ALWAYS_NEAREST && !adds) continue;
        for (const b of here) covered.add(b.pattern.id);
        out.push(item);
        taken++;
      }
    }
    return out.sort((a, b) => a.d - b.d);
  };

  const originStops = near(origin);
  const destStops = near(destination);
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
      const ride = rideOf(pattern, stopsById, index, j, needShape);
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
  /**
   * 환승 지점 점수 — 여기까지 온 시간 + 남은 거리를 가장 빠른 수단으로 갔을 때의 시간.
   *
   * 여기까지의 시간만으로 줄을 세우면 가까운 정류장이 후보 자리를 다 차지한다.
   * 그러면 조금 돌아가더라도 빠른 노선을 탈 수 있는 지점(상도동 → 대치동의 봉천역)이
   * 밀려난다. 남은 거리를 함께 보면 "여기서 갈아타면 결국 빨리 도착하는가" 로 줄이 선다.
   */
  const hubScore = (cost: number, hub: TransitStop) =>
    cost + distMeters(hub.p, destination) / MODE_SPEED.subway;

  type Reach = { ride: RideSpec; accessMeters: number; cost: number; score: number };
  const reachAll = new Map<string, Reach>();
  for (const { board, accessMeters } of seeds) {
    const { pattern, index } = board;
    for (let j = index + 1; j < pattern.stops.length; j++) {
      const stop = stopsById.get(pattern.stops[j]);
      if (!stop) continue;
      const ride = rideOf(pattern, stopsById, index, j, needShape);
      if (!ride) continue;
      /*
       * 갈아타러 가는 첫 구간은 목적지에서 멀어져도 된다.
       *
       * 상도동 → 대치동이 그렇다. 500번을 타고 **서쪽** 봉천역으로 가서 2호선으로
       * 갈아타는 게 가장 빠른데(네이버도 그렇게 안내한다), 봉천역은 출발지보다 목적지에서
       * 581m 더 멀다. "가까워져야 한다" 로 자르면 이 안이 통째로 사라진다.
       * 빠른 노선을 타러 조금 돌아가는 건 실제 노선망에서 흔한 일이다.
       *
       * 다만 한없이 돌아가지는 못하게 전체 거리에 비례해 묶어 둔다. 엉터리 조합은
       * 어차피 뒤에서 "타고 가서 가까워져야 한다"(worthRiding) 와 실제 소요 시간이 거른다.
       */
      if (progressOf(ride) < -straight * BACKTRACK_RATIO) continue;
      const cost = walkSec(accessMeters) + ride.waitSec + ride.rideSec;
      if (cost > MAX_FIRST_LEG_S) continue;
      const prev = reachAll.get(stop.id);
      if (!prev || cost < prev.cost)
        reachAll.set(stop.id, { ride, accessMeters, cost, score: hubScore(cost, stop) });
    }
  }
  const reach = [...reachAll.entries()]
    .sort((x, y) => x[1].score - y[1].score)
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
          const second = rideOf(board.pattern, stopsById, board.index, j, needShape);
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

  /*
   * 타고 내리는 정류장이 같으면 사용자에게는 같은 여정이다 — 노선 번호만 다를 뿐이다.
   * (상도4동약수맨션 → 중대후문입구 를 동작08·동작10·동작21 이 함께 다닌다)
   * 하나만 남기고 나머지는 "이것도 탈 수 있다" 로 붙인다.
   */
  const seen = new Map<string, TransitCandidate>();
  for (const c of out) {
    const key = c.rides.map((r) => `${r.from.id}>${r.to.id}`).join("|");
    const prev = seen.get(key);
    if (!prev) {
      if (seen.size >= limit) continue;
      seen.set(key, c);
      continue;
    }
    prev.rides.forEach((ride, i) => {
      const alt = c.rides[i]?.pattern;
      if (!alt?.ref || alt.ref === ride.pattern.ref) return;
      ride.alts ??= [];
      if (!ride.alts.some((a) => a.ref === alt.ref) && ride.alts.length < 4)
        ride.alts.push({ ref: alt.ref, live: alt.live });
    });
  }
  return [...seen.values()];
}

/* ───────────────────────────── 노선 형상 ───────────────────────────── */

/**
 * 화면에 안내할 노선들의 형상을 받아 온다.
 *
 * 근처 노선을 통째로 받으면 응답이 너무 커서, 후보가 정해진 다음에 그 노선만 받는다.
 * 형상이 붙으면 지도에 도로를 따라 그려지고, 거리·소요 시간도 실제 주행 기준이 된다.
 */
export async function fetchShapes(
  data: TransitData,
  patterns: TransitPattern[],
  signal?: AbortSignal
): Promise<{ id: string; shape: LngLat[]; stopIndex: number[] }[]> {
  const stopsById = new Map(data.stops.map((s) => [s.id, s]));
  const body: { id: string; live: PatternLive; stops: LngLat[] }[] = [];
  for (const p of patterns) {
    if (!p.live || p.shape) continue;
    const stops = p.stops.map((id) => stopsById.get(id)?.p);
    // 좌표를 못 찾은 정류장이 하나라도 있으면 순서가 어긋난다. 통째로 건너뛴다
    if (stops.some((s) => !s)) continue;
    body.push({ id: p.id, live: p.live, stops: stops as LngLat[] });
  }
  if (!body.length) return [];

  const res = await fetch("/api/shapes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ patterns: body }),
    signal,
  });
  if (!res.ok) throw new Error(`노선 형상을 불러오지 못했습니다 (${res.status})`);
  const json = (await res.json()) as { shapes?: { id: string; shape: LngLat[]; stopIndex: number[] }[] };
  return json.shapes ?? [];
}

/** 받은 형상을 노선에 붙인다. 붙인 게 하나라도 있으면 true */
export function applyShapes(
  data: TransitData,
  shapes: { id: string; shape: LngLat[]; stopIndex: number[] }[]
) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  let changed = false;
  for (const p of data.patterns) {
    const got = byId.get(p.id);
    // 정류장 수와 어긋나면 잘못 맞춘 것이다 — 직선으로 두는 편이 낫다
    if (!got || got.stopIndex.length !== p.stops.length) continue;
    p.shape = got.shape;
    p.stopIndex = got.stopIndex;
    changed = true;
  }
  return changed;
}
