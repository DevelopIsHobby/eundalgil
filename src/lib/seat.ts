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
  /** 지상으로 달리는 구간 비율 0~1 — 지하에서는 어느 자리든 같다 */
  surfaceRatio: number;
  /** 선로의 지상·지하를 실제로 확인했는지 (OSM 에 선로가 없으면 false) */
  surfaceKnown: boolean;
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
 * @param surface   구간마다 지상으로 달리는 비율(0~1). null 은 모르는 구간이라 지상으로 친다.
 *                  지하철은 대부분 지하로 다니고, 그런 구간에서는 자리를 고를 이유가 없다.
 * @param shaded    구간마다 **건물 그림자에 들어 있는 비율**(0~1).
 *                  해 방향만 보면 "왼쪽에 해가 든다" 가 되지만, 실제로는 길 옆 건물이
 *                  창을 가린다. 그늘 속을 달리는 구간은 어느 자리든 같다.
 */
export function seatAdvice(
  path: LngLat[],
  startMs: number,
  rideSec: number,
  surface?: (number | null)[],
  shaded?: (number | null)[]
): SeatAdvice {
  const short = (reason: string): SeatAdvice => ({
    side: "any",
    shadeRatio: 1,
    otherShadeRatio: 1,
    reason,
    surfaceRatio: 1,
    surfaceKnown: false,
  });

  if (path.length < 2) return short("구간이 짧아 자리 영향이 거의 없어요.");

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = distMeters(path[i - 1], path[i]);
    lengths.push(d);
    total += d;
  }
  if (total <= 0) return short("구간이 짧아 자리 영향이 거의 없어요.");

  let leftSun = 0;
  let rightSun = 0;
  let daylight = 0;
  let travelled = 0;
  /** 지상으로 달린 거리 — 햇빛을 따질 수 있는 건 이만큼뿐이다 */
  let exposed = 0;
  let surfaceKnown = false;
  /** 지상으로 달린 거리 — 건물 그늘까지 포함한다 (지상 비율을 재는 값) */
  let aboveGround = 0;
  /** 건물 그늘에 가려 달린 거리 */
  let inShade = 0;
  let shadeKnown = false;

  for (let i = 1; i < path.length; i++) {
    const len = lengths[i - 1];
    if (len <= 0) continue;
    const mid: LngLat = [(path[i - 1][0] + path[i][0]) / 2, (path[i - 1][1] + path[i][1]) / 2];
    // 시각은 실제로 달린 거리로 따라간다 — 지하 구간도 시간은 흐른다
    const at = new Date(startMs + ((travelled + len / 2) / total) * rideSec * 1000);
    travelled += len;

    const ratio = surface?.[i - 1];
    if (ratio != null) surfaceKnown = true;
    const open = ratio ?? 1;
    if (open <= 0) continue; // 지하 구간에는 해가 들지 않는다
    aboveGround += len * open;

    const shade = shaded?.[i - 1];
    if (shade != null) shadeKnown = true;
    // 건물 그늘 속을 달리는 만큼은 어느 창으로도 해가 들지 않는다
    const openLit = open * (1 - (shade ?? 0));
    inShade += len * open * (shade ?? 0);

    if (openLit <= 0) continue;
    const lit = len * openLit;
    exposed += lit;

    const sun = getSunState(at, mid);
    if (!sun.isDay) continue;
    daylight += lit;

    const rel = normalizeDeg(sun.azimuthDeg - bearingOf(path[i - 1], path[i]));
    const lateral = Math.sin((rel * Math.PI) / 180); // + 오른쪽, − 왼쪽
    const glare = sideGlare(sun.altitudeDeg) * lit;
    if (lateral > 0) rightSun += lateral * glare;
    else leftSun += -lateral * glare;
  }

  // 지상 비율은 건물 그늘과 무관하다 — 그늘 속을 달려도 지상은 지상이다
  const surfaceRatio = aboveGround / total;

  if (surfaceRatio < 0.05) {
    return {
      side: "any",
      shadeRatio: 1,
      otherShadeRatio: 1,
      reason: "전 구간 지하라 어느 자리에 앉아도 같아요.",
      surfaceRatio,
      surfaceKnown,
    };
  }

  // 건물 그늘이 대부분이면 좌우를 따질 일이 아니다
  if (shadeKnown && inShade / (inShade + exposed) > 0.8) {
    return {
      side: "any",
      shadeRatio: 1,
      otherShadeRatio: 1,
      reason: "길 옆 건물 그늘이 많아 어느 자리에 앉아도 비슷해요.",
      surfaceRatio,
      surfaceKnown,
    };
  }

  // 지상인데 해가 닿는 구간이 하나도 없으면 (온통 건물 그늘) 나눗셈이 성립하지 않는다
  if (exposed <= 0) {
    return {
      side: "any",
      shadeRatio: 1,
      otherShadeRatio: 1,
      reason: "길 옆 건물 그늘이 많아 어느 자리에 앉아도 비슷해요.",
      surfaceRatio,
      surfaceKnown,
    };
  }

  if (daylight / exposed < 0.15) {
    return {
      side: "any",
      shadeRatio: 1,
      otherShadeRatio: 1,
      reason: "해가 진 뒤라 어느 쪽에 앉아도 괜찮아요.",
      surfaceRatio,
      surfaceKnown,
    };
  }

  // 지상 구간만 놓고 좌·우를 견준다
  const leftShade = 1 - leftSun / exposed;
  const rightShade = 1 - rightSun / exposed;
  const gap = Math.abs(leftShade - rightShade);

  if (gap < 0.05) {
    return {
      side: "any",
      shadeRatio: Math.max(leftShade, rightShade),
      otherShadeRatio: Math.min(leftShade, rightShade),
      reason: "해가 앞뒤에서 들어와 좌우 차이가 거의 없어요.",
      surfaceRatio,
      surfaceKnown,
    };
  }

  const side: SeatSide = leftShade > rightShade ? "left" : "right";
  return {
    side,
    shadeRatio: side === "left" ? leftShade : rightShade,
    otherShadeRatio: side === "left" ? rightShade : leftShade,
    reason: `해가 ${side === "left" ? "오른쪽" : "왼쪽"}에서 들어와요.`,
    surfaceRatio,
    surfaceKnown,
  };
}
