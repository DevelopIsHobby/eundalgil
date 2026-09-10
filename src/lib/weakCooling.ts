/**
 * 약냉방칸 — 냉방을 1도 약하게 트는 칸.
 *
 * 여름에 지하철이 춥다는 사람이 많다. 어느 칸이 덜 추운지는 승강장 스크린도어에 적혀
 * 있지만 미리 알면 그 자리에서 기다릴 수 있다. 우리는 이미 "어느 쪽에 앉을지" 를
 * 말해 주고 있으니, "몇 번째 칸에 탈지" 도 같은 자리에서 말해 주는 게 맞다.
 *
 * 서울교통공사가 운영하는 1·3~8호선만 다룬다. 9호선과 광역전철(수인·분당, 경의중앙 등)은
 * 운영 주체가 달라 확인된 자료가 없다 — 모르는 건 말하지 않는다.
 * 출처: 서울시 내 손안에 서울 (mediahub.seoul.go.kr/archives/2015209)
 */

/** 일반 칸 24℃, 약냉방칸 25℃ */
export const WEAK_COOLING_DIFF_C = 1;

type Cars = { cars: number[] } | { none: true };

const BY_LINE: Record<string, Cars> = {
  "1": { cars: [4, 7] },
  "3": { cars: [4, 7] },
  "4": { cars: [4, 7] },
  "5": { cars: [4, 5] },
  "6": { cars: [4, 5] },
  "7": { cars: [4, 5] },
  "8": { cars: [3, 4] },
  // 2호선은 붐벼서 약냉방칸을 따로 두지 않는다
  "2": { none: true },
};

export type WeakCooling = { cars: number[] } | { none: true } | null;

/**
 * @param ref 노선 번호 (우리 데이터의 pattern.ref — "2", "7" 처럼 들어온다)
 * @returns 모르는 노선이면 null. 그럴 땐 화면에 아무 말도 하지 않는다
 */
export function weakCoolingCars(ref: string | undefined): WeakCooling {
  if (!ref) return null;
  return BY_LINE[ref.trim()] ?? null;
}
