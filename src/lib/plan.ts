/**
 * 여정(Plan) — 도보 한 구간짜리 경로와 대중교통 경로를 같은 모양으로 다룬다.
 * 화면(탭·시트·지도)은 이 타입만 본다.
 */

import type { LngLat } from "./geo";
import type { RouteOption, RouteResult } from "./router";
import { seatAdvice, type SeatAdvice } from "./seat";
import {
  BOARD_MARGIN_S,
  LIVE_USABLE_S,
  MODE_FARE,
  MODE_LABEL,
  MODE_WAIT,
  TRANSFER_RADIUS_M,
  type Arrival,
  type ArrivalIndex,
  type PatternLive,
  type RideSpec,
  type TransitCandidate,
} from "./transit";

export type WalkLeg = {
  type: "walk";
  route: RouteResult;
  from: string;
  to: string;
  /** 취향(그늘 등)을 반영해 고른 길인지 */
  preferred: boolean;
  startMs: number;
};

/**
 * 평균 대기가 아니라 실제 도착정보로 대기 시간을 잡았을 때, 무슨 차를 기다리는지.
 * 없으면 수단별 평균값(MODE_WAIT)을 쓴 것이다.
 */
export type LiveWait = {
  /** 차가 정류장에 닿는 시각 */
  arrivalMs: number;
  /** 실제로 타게 되는 노선 번호 — 같은 구간을 다니는 다른 노선이 먼저 올 수 있다 */
  ref?: string;
  /** "2분후[2번째 전]" 같은 원문 */
  message?: string;
  stopsAway?: number;
  full?: boolean;
  last?: boolean;
  lowFloor?: boolean;
  /** 오는 차가 안 잡혀 그 노선의 배차간격으로 어림한 값 */
  fromHeadway?: boolean;
};

export type RideLeg = {
  type: "ride";
  ride: RideSpec;
  seat: SeatAdvice;
  /** 정류장 도착 시각 */
  arriveMs: number;
  /** 승차 시각 (정류장 도착 + 대기) */
  startMs: number;
  /** 실시간 도착정보로 대기를 잡았다면 그 내용 */
  live?: LiveWait;
};

export type Leg = WalkLeg | RideLeg;

export type PlanStyle = "shade" | "fast";

export type Plan = {
  id: string;
  kind: "walk" | "transit";
  style: PlanStyle;
  legs: Leg[];
  /** 총 소요(초) */
  seconds: number;
  startMs: number;
  /** 도보 거리 합(m) */
  walkMeters: number;
  /** 도보 구간의 길이 가중 평균 그늘 비율 */
  walkShade: number;
  transfers: number;
  fare: number;
  /** 지도에 그릴 전체 좌표열 */
  path: LngLat[];
  /** 탭에 쓸 요약 ("500", "7호선 → 500", "도보") */
  summary: string;
};

/**
 * 두 점 사이를 걷는 길. **못 찾으면 null 이다.**
 * 예전에는 직선으로 이어 버렸는데, 그러면 상도터널처럼 사람이 걸어서 지날 수 없는 곳을
 * "16분 걷기" 라고 우기는 안내가 나왔다. 없으면 그 여정을 통째로 버리는 편이 옳다.
 */
export type WalkFn = (a: LngLat, b: LngLat, maxStraight?: number) => RouteResult | null;

function walkStats(legs: Leg[]) {
  let meters = 0;
  let shaded = 0;
  for (const l of legs) {
    if (l.type !== "walk") continue;
    meters += l.route.distance;
    shaded += l.route.distance * l.route.shadeRatio;
  }
  return { meters, shade: meters > 0 ? shaded / meters : 0 };
}

function joinPaths(legs: Leg[]): LngLat[] {
  const out: LngLat[] = [];
  for (const l of legs) {
    const path = l.type === "walk" ? l.route.path : l.ride.path;
    for (const p of path) {
      const last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
    }
  }
  return out;
}

export function buildWalkPlan(
  route: RouteOption,
  opts: { originName: string; destName: string; startMs: number }
): Plan {
  const leg: WalkLeg = {
    type: "walk",
    route,
    from: opts.originName,
    to: opts.destName,
    preferred: route.id === "shade",
    startMs: opts.startMs,
  };
  return {
    id: `walk:${route.id}`,
    kind: "walk",
    style: route.id === "shade" ? "shade" : "fast",
    legs: [leg],
    seconds: route.duration,
    startMs: opts.startMs,
    walkMeters: route.distance,
    walkShade: route.shadeRatio,
    transfers: 0,
    fare: 0,
    path: route.path,
    summary: "도보",
  };
}

/** 이 구간을 함께 다니는 노선들 — 실시간이 있으면 이 중 먼저 오는 걸 탄다 */
function liveRoutes(ride: RideSpec) {
  return [{ ref: ride.pattern.ref, live: ride.pattern.live }, ...(ride.alts ?? [])].filter(
    (r): r is { ref: string; live: PatternLive } => !!r.live
  );
}

/** 오는 차가 안 잡힐 때 — 배차간격의 절반을 기다린다고 본다 */
function headwayWait(
  routes: { ref: string; live: PatternLive }[],
  stopId: string,
  live: ArrivalIndex
) {
  let best: { sec: number; ref: string } | null = null;
  for (const r of routes) {
    const term = live.headwaySec(stopId, r.live.routeId);
    if (term == null) continue;
    const sec = term / 2;
    if (!best || sec < best.sec) best = { sec, ref: r.ref };
  }
  return best;
}

/**
 * 정류장에 닿는 시각(arriveMs)에 실제로 탈 수 있는 차를 골라 대기 시간을 낸다.
 *
 * 실시간 정보에는 지금 오고 있는 차만 잡히므로, 한참 뒤에 타는 환승 구간이나
 * 정보가 없는 노선은 평균 대기(MODE_WAIT)로 되돌린다. 배차간격이라도 알면
 * 그 절반을 쓴다 — 모든 노선에 똑같은 4분을 얹는 것보다 실제에 가깝다.
 */
function waitFor(
  ride: RideSpec,
  arriveMs: number,
  live: ArrivalIndex | null
): { sec: number; live?: LiveWait } {
  const average = MODE_WAIT[ride.pattern.mode];
  // 지하철은 실시간 도착을 받지 않는다 (그래서 늘 평균 배차다)
  if (!live || ride.pattern.mode !== "bus") return { sec: average };

  const routes = liveRoutes(ride);
  if (!routes.length) return { sec: average };

  const byHeadway = () => {
    const head = headwayWait(routes, ride.from.id, live);
    if (!head) return { sec: average };
    return {
      sec: head.sec,
      live: { arrivalMs: arriveMs + head.sec * 1000, ref: head.ref, fromHeadway: true },
    };
  };

  // 너무 먼 미래에 탈 차는 지금 예측에 잡히지 않는다
  if (arriveMs - live.fetchedAt > LIVE_USABLE_S * 1000) return byHeadway();

  let best: { arrivalMs: number; ref: string; bus: Arrival } | null = null;
  for (const r of routes) {
    for (const bus of live.buses(ride.from.id, r.live.routeId)) {
      const arrivalMs = live.fetchedAt + bus.sec * 1000;
      // 우리가 정류장에 닿기 전에 지나가 버리는 차는 못 탄다
      if (arrivalMs < arriveMs + BOARD_MARGIN_S * 1000) continue;
      if (!best || arrivalMs < best.arrivalMs) best = { arrivalMs, ref: r.ref, bus };
      break; // 노선별 목록은 이른 순이라 탈 수 있는 첫 차만 보면 된다
    }
  }
  if (!best) return byHeadway();

  return {
    sec: Math.max(0, (best.arrivalMs - arriveMs) / 1000),
    live: {
      arrivalMs: best.arrivalMs,
      ref: best.ref,
      message: best.bus.message,
      stopsAway: best.bus.stopsAway,
      full: best.bus.full,
      last: best.bus.last,
      lowFloor: best.bus.lowFloor,
    },
  };
}

export function buildTransitPlan(
  cand: TransitCandidate,
  opts: {
    origin: LngLat;
    destination: LngLat;
    originName: string;
    destName: string;
    startMs: number;
    style: PlanStyle;
    walk: WalkFn;
    /** 실시간 도착정보 — "지금" 을 보고 있을 때만 들어온다 */
    arrivals?: ArrivalIndex | null;
  }
): Plan | null {
  const legs: Leg[] = [];
  let clock = opts.startMs;
  let cursor = opts.origin;
  let cursorName = opts.originName;

  /** 걷는 길이 없으면 false — 부르는 쪽이 이 여정을 버린다 */
  const pushWalk = (to: LngLat, toName: string, maxStraight?: number) => {
    const route = opts.walk(cursor, to, maxStraight);
    if (!route) return false;
    if (route.distance >= 15) {
      legs.push({
        type: "walk",
        route,
        from: cursorName,
        to: toName,
        preferred: opts.style === "shade",
        startMs: clock,
      });
      clock += route.duration * 1000;
    }
    cursor = to;
    cursorName = toName;
    return true;
  };

  for (const [i, ride] of (cand.rides as RideSpec[]).entries()) {
    /*
     * 환승 도보는 같은 역·정류장 언저리를 걷는 짧은 구간이다(길어야 TRANSFER_RADIUS_M).
     * 그런데 환승 지점은 출발지·목적지에서 멀 수 있어 보행로 데이터가 없는 곳이 많다.
     * (상도동 → 대치동 이면 노들역에서 갈아타는데, 거기는 출발지에서 1.7km 떨어져 있다)
     * 그때 여정을 통째로 버리면 지하철 안내가 전부 사라진다. 짧은 구간이니 직선으로 어림한다.
     */
    if (!pushWalk(ride.from.p, ride.from.name, i > 0 ? TRANSFER_RADIUS_M : undefined)) return null;
    const arriveMs = clock;
    const wait = waitFor(ride, arriveMs, opts.arrivals ?? null);
    const boardMs = arriveMs + wait.sec * 1000;
    legs.push({
      type: "ride",
      ride,
      seat: seatAdvice(ride.path, boardMs, ride.rideSec, ride.surface),
      arriveMs,
      startMs: boardMs,
      live: wait.live,
    });
    clock = boardMs + ride.rideSec * 1000;
    cursor = ride.to.p;
    cursorName = ride.to.name;
  }

  if (!pushWalk(opts.destination, opts.destName)) return null;

  const { meters, shade } = walkStats(legs);
  const fare = cand.rides.reduce((acc, r) => Math.max(acc, MODE_FARE[r.pattern.mode]), 0);

  return {
    id: `${cand.id}:${opts.style}`,
    kind: "transit",
    style: opts.style,
    legs,
    seconds: (clock - opts.startMs) / 1000,
    startMs: opts.startMs,
    walkMeters: meters,
    walkShade: shade,
    transfers: Math.max(0, cand.rides.length - 1),
    fare,
    path: joinPaths(legs),
    summary: cand.rides.map((r) => r.pattern.ref || r.pattern.name).join(" → "),
  };
}

/** 같은 이동 수단 조합의 "그늘 우선" / "최단" 두 벌 */
export type PlanPair = { shade: Plan; fast: Plan };

export function planLabel(plan: Plan) {
  if (plan.kind === "walk") return "도보";
  const first = plan.legs.find((l): l is RideLeg => l.type === "ride");
  if (!first) return "도보";
  return `${MODE_LABEL[first.ride.pattern.mode]} ${plan.summary}`;
}

export function formatClock(ms: number) {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatClockKo(ms: number) {
  const d = new Date(ms);
  const h = d.getHours();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFare(won: number) {
  return `${won.toLocaleString("ko-KR")}원`;
}
