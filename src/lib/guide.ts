/**
 * 길 안내 — 정해진 경로를 따라 걷는 동안 "다음에 뭘 하면 되는지" 를 말해 준다.
 *
 * 안내 문구는 **경로 모양에서 뽑는다.** 길 이름을 붙이려면 좌표마다 어느 길인지 알아야 하는데,
 * 우리 경로 결과는 길 이름을 구간 단위로만 들고 있다. 이름을 억지로 갖다 붙이면
 * 엉뚱한 골목 이름을 말하게 되므로, 방향과 거리로만 안내한다.
 * ("120m 직진 후 왼쪽" 은 이름 없이도 따라갈 수 있다)
 */

import { bearingOf, distMeters, type LngLat } from "./geo";
import type { Leg, Plan, RideLeg, WalkLeg } from "./plan";

export type Turn = "straight" | "left" | "right" | "sharp-left" | "sharp-right";

export type GuideStep = {
  /** 이 안내를 수행할 지점 */
  p: LngLat;
  /** 경로 시작점부터 이 지점까지의 거리(m) */
  at: number;
  turn: Turn;
  /** 한 줄 안내 */
  text: string;
  /** 버스·지하철 구간이면 그 안내 */
  ride?: { line: string; from: string; to: string; stops: number };
};

/** 이 각도보다 크게 꺾이면 안내할 만한 회전으로 본다 */
const TURN_DEG = 32;
const SHARP_DEG = 95;
/** 이만큼 안에서 잇달아 꺾이면 한 번만 말한다 (골목 지그재그) */
const MERGE_M = 18;

function normalize(deg: number) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function turnOf(delta: number): Turn {
  if (Math.abs(delta) < TURN_DEG) return "straight";
  if (delta > 0) return Math.abs(delta) >= SHARP_DEG ? "sharp-right" : "right";
  return Math.abs(delta) >= SHARP_DEG ? "sharp-left" : "left";
}

export const TURN_LABEL: Record<Turn, string> = {
  straight: "직진",
  left: "왼쪽으로",
  right: "오른쪽으로",
  "sharp-left": "왼쪽으로 크게",
  "sharp-right": "오른쪽으로 크게",
};

/** 여정 전체를 하나의 좌표열과 안내 목록으로 편다 */
export function buildGuide(plan: Plan): { path: LngLat[]; steps: GuideStep[] } {
  const path: LngLat[] = [];
  const steps: GuideStep[] = [];
  let acc = 0;

  const pushPoint = (p: LngLat) => {
    const last = path[path.length - 1];
    if (last) {
      const d = distMeters(last, p);
      if (d < 0.5) return;
      acc += d;
    }
    path.push(p);
  };

  for (const leg of plan.legs as Leg[]) {
    if (leg.type === "ride") {
      const ride = (leg as RideLeg).ride;
      const line = ride.pattern.ref || ride.pattern.name;
      steps.push({
        p: ride.from.p,
        at: acc,
        turn: "straight",
        text: `${ride.from.name}에서 ${line} 승차`,
        ride: { line, from: ride.from.name, to: ride.to.name, stops: ride.stopCount },
      });
      for (const p of ride.path) pushPoint(p);
      steps.push({
        p: ride.to.p,
        at: acc,
        turn: "straight",
        text: `${ride.to.name} 하차`,
      });
      continue;
    }

    const walk = leg as WalkLeg;
    const wp = walk.route.path;
    if (wp.length < 2) continue;

    const startAt = acc;
    for (const p of wp) pushPoint(p);

    // 걷는 구간 안의 회전만 뽑는다
    let lastTurnAt = startAt;
    let run = startAt;
    for (let i = 1; i < wp.length - 1; i++) {
      run += distMeters(wp[i - 1], wp[i]);
      const delta = normalize(bearingOf(wp[i], wp[i + 1]) - bearingOf(wp[i - 1], wp[i]));
      const turn = turnOf(delta);
      if (turn === "straight") continue;
      if (run - lastTurnAt < MERGE_M) continue;
      steps.push({
        p: wp[i],
        at: run,
        turn,
        text: `${TURN_LABEL[turn]}`,
      });
      lastTurnAt = run;
    }
  }

  steps.push({ p: path[path.length - 1] ?? plan.path[0], at: acc, turn: "straight", text: "도착" });
  steps.sort((a, b) => a.at - b.at);
  return { path, steps };
}

export type OnPath = {
  /** 경로 위 가장 가까운 지점까지의 거리(m) — 이게 크면 경로를 벗어난 것이다 */
  offset: number;
  /** 경로 시작점부터 그 지점까지의 거리(m) */
  at: number;
};

/** 지금 있는 자리를 경로 위로 내려 찍는다 */
export function projectOnPath(path: LngLat[], p: LngLat): OnPath | null {
  if (path.length < 2) return null;
  let acc = 0;
  let best: OnPath | null = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = distMeters(a, b);
    if (seg < 0.01) continue;
    // 짧은 구간이라 위경도를 평면처럼 다뤄도 무방하다
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) /
        ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2))
    );
    const foot: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const offset = distMeters(p, foot);
    if (!best || offset < best.offset) best = { offset, at: acc + seg * t };
    acc += seg;
  }
  return best;
}

/** 지금 위치에서 다음에 할 일과 거기까지 남은 거리 */
export function nextStep(steps: GuideStep[], at: number) {
  for (const s of steps) {
    if (s.at > at + 2) return { step: s, remain: s.at - at };
  }
  const last = steps[steps.length - 1];
  return last ? { step: last, remain: Math.max(0, last.at - at) } : null;
}

export function formatRemain(meters: number) {
  if (meters < 20) return "곧";
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m 앞`;
  return `${(meters / 1000).toFixed(1)}km 앞`;
}
