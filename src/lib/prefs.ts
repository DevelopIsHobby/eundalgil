/**
 * 사용자 취향 — 온보딩에서 한 번 고르고, 설정에서 언제든 바꾼다.
 * 여기서 정한 값이 그대로 경로 탐색 비용(`RoutePreference`)으로 번역된다.
 */

export type SunTaste = "sun" | "balanced" | "shade";
export type Tolerance = "avoid" | "balanced" | "ok";
export type Vibe = "quiet" | "balanced" | "lively";
export type Detour = "short" | "balanced" | "relaxed";
export type Pace = "slow" | "normal" | "fast";

export type Prefs = {
  /** 햇빛 취향 */
  sun: SunTaste;
  /** 언덕(경사) */
  hill: Tolerance;
  /** 계단 */
  steps: Tolerance;
  /** 계단 있는 길 완전 제외 */
  excludeSteps: boolean;
  /** 길 분위기 — 큰길(활기) vs 이면도로(조용) */
  vibe: Vibe;
  /** 조금 돌아가도 괜찮은 정도 */
  detour: Detour;
  /** 야간 방범시설 많은 길 안내 */
  nightSafety: boolean;
  /** 걷는 속도 — 소요 시간이 몸에 맞아야 계획이 선다 */
  pace: Pace;
};

/**
 * 걷는 속도(m/s).
 *
 * 처음에는 1.0 을 기본으로 뒀다. 네이버 표기와 맞춘 값이었는데, 실제로 걸어 본 사람이
 * "그렇게 오래 안 걸린다" 고 했다. 상도동 531m 구간을 우리는 9.3분으로 봤지만
 * 걷는 사람도 그늘로도 6~7분으로 본다. 경사·횡단보도는 이미 따로 더하고 있으니
 * 기준 속도까지 느리게 잡으면 이중으로 깎이는 셈이다.
 *
 * 그래서 기본을 1.25m/s(4.5km/h — 성인 평균 보행 속도)로 올리고,
 * 천천히 걷는 사람은 "느긋하게"(1.0), 빠른 사람은 "빠르게"(1.5)를 고르게 한다.
 */
export const PACE_MPS: Record<Pace, number> = {
  slow: 1.0,
  normal: 1.25,
  fast: 1.5,
};

export const DEFAULT_PREFS: Prefs = {
  sun: "shade",
  hill: "balanced",
  steps: "balanced",
  excludeSteps: false,
  vibe: "balanced",
  detour: "balanced",
  nightSafety: true,
  pace: "normal",
};

export const PREF_OPTIONS = {
  sun: [
    { id: "sun", label: "볕 쪽" },
    { id: "balanced", label: "균형" },
    { id: "shade", label: "그늘 쪽" },
  ],
  hill: [
    { id: "avoid", label: "피할래요" },
    { id: "balanced", label: "균형" },
    { id: "ok", label: "괜찮아요" },
  ],
  steps: [
    { id: "avoid", label: "피할래요" },
    { id: "balanced", label: "균형" },
    { id: "ok", label: "괜찮아요" },
  ],
  vibe: [
    { id: "quiet", label: "조용하게" },
    { id: "balanced", label: "균형" },
    { id: "lively", label: "활기차게" },
  ],
  detour: [
    { id: "short", label: "최단" },
    { id: "balanced", label: "균형" },
    { id: "relaxed", label: "여유 있게" },
  ],
  pace: [
    { id: "slow", label: "느긋하게" },
    { id: "normal", label: "보통" },
    { id: "fast", label: "빠르게" },
  ],
} as const;

/** 온보딩 마지막 장면에 띄우는 요약 칩 */
export function prefChips(p: Prefs) {
  const sun = { sun: "볕 선호", balanced: "햇빛 균형", shade: "그늘 선호" }[p.sun];
  const hill = { avoid: "경사 회피", balanced: "경사 균형", ok: "경사 괜찮음" }[p.hill];
  const steps = p.excludeSteps
    ? "계단 제외"
    : { avoid: "계단 회피", balanced: "계단 균형", ok: "계단 괜찮음" }[p.steps];
  const vibe = { quiet: "조용한 길", balanced: "혼잡 균형", lively: "활기찬 길" }[p.vibe];
  const detour = { short: "거리 최단", balanced: "거리 균형", relaxed: "여유 있게" }[p.detour];
  const pace = { slow: "느긋한 걸음", normal: "보통 걸음", fast: "빠른 걸음" }[p.pace];
  return [
    { label: sun, tone: "green" as const },
    { label: hill, tone: "blue" as const },
    { label: steps, tone: "orange" as const },
    { label: vibe, tone: "purple" as const },
    { label: detour, tone: "sky" as const },
    { label: pace, tone: "green" as const },
    ...(p.nightSafety ? [{ label: "야간 방범시설 안내 사용", tone: "yellow" as const }] : []),
  ];
}

/** 우회 허용도 — 취향 가중치 전체에 곱한다 */
const DETOUR_GAIN: Record<Detour, number> = { short: 0.5, balanced: 1, relaxed: 1.7 };

/** 탐색 비용에 쓰이는 가중치 묶음. 모든 항은 0 이상이라 A* 휴리스틱이 깨지지 않는다. */
export type RouteWeights = {
  /** 햇빛 구간에 붙이는 가산 (그늘 선호) */
  sunPenalty: number;
  /** 그늘 구간에 붙이는 가산 (볕 선호) */
  shadePenalty: number;
  /** 계단 시간 배율 */
  stepPenalty: number;
  /** 계단 길 자체를 제외 */
  excludeSteps: boolean;
  /** 오르막에 드는 시간에 곱하는 배율 (언덕 회피) */
  hillPenalty: number;
  /** 평지 기준 걷는 속도(m/s) */
  speedMps: number;
  /** 큰길에 붙이는 가산 (조용한 길 선호) */
  majorPenalty: number;
  /** 이면도로에 붙이는 가산 (활기찬 길 선호) */
  minorPenalty: number;
  /** 방범시설이 없는 구간에 붙이는 가산 (야간에만) */
  darkPenalty: number;
};

export const FASTEST_WEIGHTS: RouteWeights = {
  sunPenalty: 0,
  shadePenalty: 0,
  stepPenalty: 1,
  excludeSteps: false,
  hillPenalty: 1,
  speedMps: PACE_MPS.normal,
  majorPenalty: 0,
  minorPenalty: 0,
  darkPenalty: 0,
};

/**
 * 취향 → 가중치.
 * `isDay` 가 false 면 그늘 가중치를 끄고, 대신 야간 방범 가중치를 켠다.
 */
export function weightsFromPrefs(p: Prefs, isDay: boolean): RouteWeights {
  const g = DETOUR_GAIN[p.detour];

  const sunPenalty = isDay && p.sun === "shade" ? 1.3 * g : isDay && p.sun === "balanced" ? 0.35 * g : 0;
  const shadePenalty = isDay && p.sun === "sun" ? 0.9 * g : 0;

  return {
    sunPenalty,
    shadePenalty,
    stepPenalty: p.excludeSteps ? 1 : { avoid: 2.6, balanced: 1.2, ok: 1 }[p.steps],
    excludeSteps: p.excludeSteps,
    hillPenalty: { avoid: 2.2, balanced: 1.25, ok: 1 }[p.hill],
    speedMps: PACE_MPS[p.pace] ?? PACE_MPS.normal,
    majorPenalty: p.vibe === "quiet" ? 0.35 * g : 0,
    minorPenalty: p.vibe === "lively" ? 0.3 * g : 0,
    darkPenalty: !isDay && p.nightSafety ? 0.8 * g : 0,
  };
}

/** 취향이 최단 경로와 다른 길을 만들어 낼 여지가 있는지 */
export function weightsAreNeutral(w: RouteWeights) {
  return (
    w.sunPenalty === 0 &&
    w.shadePenalty === 0 &&
    w.majorPenalty === 0 &&
    w.minorPenalty === 0 &&
    w.darkPenalty === 0 &&
    w.stepPenalty <= 1.01 &&
    w.hillPenalty <= 1.01 &&
    !w.excludeSteps
  );
}

const KEY = "eundalgil.prefs.v1";

export function loadPrefs(): { prefs: Prefs; onboarded: boolean } {
  if (typeof window === "undefined") return { prefs: DEFAULT_PREFS, onboarded: true };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { prefs: DEFAULT_PREFS, onboarded: false };
    const parsed = JSON.parse(raw) as Partial<Prefs> & { onboarded?: boolean };
    return {
      prefs: { ...DEFAULT_PREFS, ...parsed },
      onboarded: parsed.onboarded !== false,
    };
  } catch {
    return { prefs: DEFAULT_PREFS, onboarded: false };
  }
}

export function savePrefs(prefs: Prefs, onboarded: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...prefs, onboarded }));
  } catch {
    /* 사파리 프라이빗 모드 등 — 저장 실패해도 동작에는 지장 없음 */
  }
}
