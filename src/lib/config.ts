import type { LngLat } from "./geo";

/** 서비스 브랜드 — 한 곳만 고치면 전체에 반영된다 */
export const BRAND = {
  name: "응달길",
  latin: "EUNDALGIL",
  tagline: "그늘만 밟고 가는 길",
  description: "햇빛과 그늘을 계산해 걷기 좋은 길을 찾아주는 보행 지도",
} as const;

/** 기본 지도 중심 (서울시청) */
export const DEFAULT_CENTER: LngLat = [126.9784, 37.5666];

/**
 * MapLibre 의 줌은 512px 타일 기준이라 네이버·구글의 256px 기준보다 한 단계 낮다.
 * (MapLibre z15 ≒ 네이버 z16) 아래 값들은 모두 MapLibre 기준이다.
 */
export const DEFAULT_ZOOM = 15;

/** 데이터를 내려받는 최소 줌 — 이보다 낮으면 범위가 너무 넓어진다 */
export const MIN_DATA_ZOOM = 14;

/** 지도 이동 시 데이터를 다시 받을지 판단하는 여유 거리(m) */
export const REFETCH_PAD_M = 250;

export const SHADE_PRESETS = [
  { id: "off", label: "빠른 길", weight: 0 },
  { id: "mild", label: "약간 우회", weight: 0.6 },
  { id: "strong", label: "그늘 우선", weight: 1.4 },
] as const;

export type ShadePresetId = (typeof SHADE_PRESETS)[number]["id"];
