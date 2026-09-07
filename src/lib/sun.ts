import SunCalc from "suncalc";
import type { LngLat } from "./geo";

export type SunState = {
  /** 태양 고도(도). 0 이하이면 해가 진 상태 */
  altitudeDeg: number;
  /** 태양 방위각(도, 북=0 시계방향) */
  azimuthDeg: number;
  /** 그림자가 뻗어나가는 방위각(도, 북=0 시계방향) */
  shadowBearingDeg: number;
  /** 물체 높이 1m 당 그림자 길이(m) */
  shadowRatio: number;
  isDay: boolean;
  /** 0(일출/일몰) ~ 1(남중) 사이의 햇빛 강도 근사치 */
  intensity: number;
};

/** 그림자 길이 상한 — 저고도에서 무한히 길어지는 것을 막는다 */
export const MAX_SHADOW_RATIO = 12; // 고도 약 4.8도

export function getSunState(at: Date, p: LngLat): SunState {
  const pos = SunCalc.getPosition(at, p[1], p[0]);
  const altitudeDeg = (pos.altitude * 180) / Math.PI;
  // SunCalc 방위각은 남쪽 기준이므로 북쪽 기준 나침반 방위로 변환
  const azimuthDeg = ((pos.azimuth * 180) / Math.PI + 180 + 360) % 360;
  const shadowBearingDeg = (azimuthDeg + 180) % 360;

  const isDay = altitudeDeg > 0.5;
  const ratio = isDay
    ? Math.min(MAX_SHADOW_RATIO, 1 / Math.tan((altitudeDeg * Math.PI) / 180))
    : MAX_SHADOW_RATIO;

  return {
    altitudeDeg,
    azimuthDeg,
    shadowBearingDeg,
    shadowRatio: ratio,
    isDay,
    intensity: isDay ? Math.min(1, Math.sin((altitudeDeg * Math.PI) / 180) / Math.sin(Math.PI / 3)) : 0,
  };
}

export function sunTimes(at: Date, p: LngLat) {
  return SunCalc.getTimes(at, p[1], p[0]);
}

export function compassLabel(deg: number) {
  const names = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
