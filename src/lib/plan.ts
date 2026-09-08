/**
 * 여정(Plan) — 도보 한 구간짜리 경로와 대중교통 경로를 같은 모양으로 다룬다.
 * 화면(탭·시트·지도)은 이 타입만 본다.
 */

import type { LngLat } from "./geo";
import type { RouteOption, RouteResult } from "./router";
import { seatAdvice, type SeatAdvice } from "./seat";
import { MODE_FARE, MODE_LABEL, type RideSpec, type TransitCandidate } from "./transit";

export type WalkLeg = {
  type: "walk";
  route: RouteResult;
  from: string;
  to: string;
  /** 취향(그늘 등)을 반영해 고른 길인지 */
  preferred: boolean;
  startMs: number;
};

export type RideLeg = {
  type: "ride";
  ride: RideSpec;
  seat: SeatAdvice;
  /** 정류장 도착 시각 */
  arriveMs: number;
  /** 승차 시각 (도착 + 평균 대기) */
  startMs: number;
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

export type WalkFn = (a: LngLat, b: LngLat) => RouteResult;

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
  }
): Plan {
  const legs: Leg[] = [];
  let clock = opts.startMs;
  let cursor = opts.origin;
  let cursorName = opts.originName;

  const pushWalk = (to: LngLat, toName: string) => {
    const route = opts.walk(cursor, to);
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
  };

  cand.rides.forEach((ride: RideSpec) => {
    pushWalk(ride.from.p, ride.from.name);
    const arriveMs = clock;
    const boardMs = arriveMs + ride.waitSec * 1000;
    legs.push({
      type: "ride",
      ride,
      seat: seatAdvice(ride.path, boardMs, ride.rideSec),
      arriveMs,
      startMs: boardMs,
    });
    clock = boardMs + ride.rideSec * 1000;
    cursor = ride.to.p;
    cursorName = ride.to.name;
  });

  pushWalk(opts.destination, opts.destName);

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

/** 같은 이동 수단 조합의 "그늘로 추천" / "최단" 두 벌 */
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
