import type { LngLat } from "./geo";

export type WalkWay = {
  id: string;
  path: LngLat[];
  /**
   * ramp  = 차량 연결로. 걸을 수는 있어도 보행자가 갈 길은 아니다
   * trail = 포장 안 된 산길·오솔길. 지름길로 보이지만 실제로 걸어 다니는 길이 아닌 경우가 많다
   */
  kind: "footway" | "steps" | "crossing" | "road" | "park" | "ramp" | "trail";
  /** 경사 태그 원본 (예: "10%", "up") */
  incline?: string;
  name?: string;
  /** 지붕/아케이드 등 상시 그늘 구간 */
  covered?: boolean;
  /** path 좌표별 고도(m). DEM 을 못 받으면 없다 */
  elev?: number[];
};

export type RawBuilding = { id: string; ring: LngLat[]; height: number };
export type RawTree = { id: string; p: LngLat; height: number; crown: number };

export type OsmBundle = {
  buildings: RawBuilding[];
  trees: RawTree[];
  ways: WalkWay[];
  /** 방범시설 (야간 모드) */
  safety: SafetyPoint[];
  bbox: [number, number, number, number]; // minLng,minLat,maxLng,maxLat
  fetchedAt: number;
};

export type SafetyPoint = {
  id: string;
  p: LngLat;
  kind: "cctv" | "lamp" | "emergency";
};

export async function fetchOsmBundle(
  bbox: [number, number, number, number],
  signal?: AbortSignal
): Promise<OsmBundle> {
  const qs = new URLSearchParams({ bbox: bbox.map((v) => v.toFixed(6)).join(",") });
  const res = await fetch(`/api/osm?${qs}`, { signal });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/**
 * 오류 본문을 그대로 화면에 뿌리면 안 된다.
 * Overpass 미러나 개발 서버는 실패할 때 HTML 페이지를 통째로 돌려주는데,
 * 그게 그대로 안내 문구 자리에 들어가면 화면이 태그로 뒤덮인다.
 */
async function readError(res: Response) {
  const body = (await res.text().catch(() => "")).trim();
  const looksLikeHtml = /^<|<\/?[a-z]+[\s>]/i.test(body);
  if (!body || looksLikeHtml || body.length > 200) {
    return `지도 데이터를 불러오지 못했습니다 (${res.status})`;
  }
  return body;
}
