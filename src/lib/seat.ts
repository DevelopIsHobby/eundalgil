/**
 * 자리 추천 — 차량이 가는 방향을 기준으로 햇빛이 덜 드는 쪽을 고른다.
 *
 * 좌·우는 "차량이 가는 쪽을 바라봤을 때"의 왼쪽·오른쪽이다.
 * 태양 방위각과 진행 방위각의 차이로 어느 창으로 해가 들어오는지 구하고,
 * 구간 길이로 가중 평균해 노선 전체의 노출량을 낸다.
 */

import { bearingOf, distMeters, type LngLat } from "./geo";
import { getSunState } from "./sun";

export type SeatSide = "left" | "right" | "any";

export type SeatAdvice = {
  side: SeatSide;
  /** 추천한 쪽에 앉았을 때 햇빛이 들지 않는 구간 비율 0~1 */
  shadeRatio: number;
  /** 반대쪽에 앉았을 때의 같은 값 */
  otherShadeRatio: number;
  /** 한 줄 설명 */
  reason: string;
};

export const SIDE_LABEL: Record<SeatSide, string> = {
  left: "왼쪽",
  right: "오른쪽",
  any: "아무 쪽",
};

/** 태양 고도가 높을수록 옆 창으로 들어오는 빛은 줄어든다 (지붕이 가린다) */
function sideGlare(altitudeDeg: number) {
  if (altitudeDeg <= 0) return 0;
  return Math.max(0, Math.cos((altitudeDeg * Math.PI) / 180));
}

function normalizeDeg(d: number) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/**
 * @param path      정류장을 이은 주행 경로
 * @param startMs   승차 시각
 * @param rideSec   주행 시간 — 경로를 따라가며 태양 위치를 조금씩 옮긴다
 */
export function seatAdvice(path: LngLat[], startMs: number, rideSec: number): SeatAdvice {
  if (path.length < 2) {
    return { side: "any", shadeRatio: 1, otherShadeRatio: 1, reason: "구간이 짧아 자리 영향이 거의 없어요." };
  }

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = distMeters(path[i - 1], path[i]);
    lengths.push(d);
    total += d;
  }
  if (total <= 0) {
    return { side: "any", shadeRatio: 1, otherShadeRatio: 1, reason: "구간이 짧아 자리 영향이 거의 없어요." };
  }

  let leftSun = 0;
  let rightSun = 0;
  let daylight = 0;
  let travelled = 0;

  for (let i = 1; i < path.length; i++) {
    const len = lengths[i - 1];
    if (len <= 0) continue;
    const mid: LngLat = [(path[i - 1][0] + path[i][0]) / 2, (path[i - 1][1] + path[i][1]) / 2];
    const at = new Date(startMs + ((travelled + len / 2) / total) * rideSec * 1000);
    travelled += len;

    const sun = getSunState(at, mid);
    if (!sun.isDay) continue;
    daylight += len;

    const rel = normalizeDeg(sun.azimuthDeg - bearingOf(path[i - 1], path[i]));
    const lateral = Math.sin((rel * Math.PI) / 180); // + 오른쪽, − 왼쪽
    const glare = sideGlare(sun.altitudeDeg) * len;
    if (lateral > 0) rightSun += lateral * glare;
    else leftSun += -lateral * glare;
  }

  if (daylight / total < 0.15) {
    return {
      side: "any",
      shadeRatio: 1,
      otherShadeRatio: 1,
      reason: "해가 진 뒤라 어느 쪽에 앉아도 괜찮아요.",
    };
  }

  const leftShade = 1 - leftSun / total;
  const rightShade = 1 - rightSun / total;
  const gap = Math.abs(leftShade - rightShade);

  if (gap < 0.05) {
    return {
      side: "any",
      shadeRatio: Math.max(leftShade, rightShade),
      otherShadeRatio: Math.min(leftShade, rightShade),
      reason: "해가 앞뒤에서 들어와 좌우 차이가 거의 없어요.",
    };
  }

  const side: SeatSide = leftShade > rightShade ? "left" : "right";
  return {
    side,
    shadeRatio: side === "left" ? leftShade : rightShade,
    otherShadeRatio: side === "left" ? rightShade : leftShade,
    reason: `해가 ${side === "left" ? "오른쪽" : "왼쪽"}에서 들어와요.`,
  };
}
