import type { LngLat } from "./geo";

export type WalkWay = {
  id: string;
  path: LngLat[];
  /**
   * ramp   = 차량 연결로. 걸을 수는 있어도 보행자가 갈 길은 아니다
   * trail  = 포장 안 된 산길·오솔길. 지름길로 보이지만 실제로 걸어 다니는 길이 아닌 경우가 많다
   * tunnel = 차도 터널의 보도. 걸을 수는 있지만 시끄럽고 매연이 있어 마지막에 고른다
   */
  kind: "footway" | "steps" | "crossing" | "road" | "park" | "ramp" | "trail" | "tunnel";
  /** 경사 태그 원본 (예: "10%", "up") */
  incline?: string;
  name?: string;
  /** 지붕/아케이드 등 상시 그늘 구간 */
  covered?: boolean;
  /** 차량 통행이 많은 큰길 — "길 분위기" 취향에 쓴다 */
  major?: boolean;
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
  /** 지하철 출입구 */
  entrances: Entrance[];
  bbox: [number, number, number, number]; // minLng,minLat,maxLng,maxLat
  fetchedAt: number;
};

/** 지하철 출입구 — 역을 목적지로 잡았을 때 실제로 들어가는 지점 */
export type Entrance = { id: string; p: LngLat; name?: string };

export type SafetyPoint = {
  id: string;
  p: LngLat;
  kind: "cctv" | "lamp" | "emergency";
};

/**
 * 여러 범위를 **한 번에** 받는다.
 * 공개 Overpass 는 요청마다 줄을 서므로, 따로 부르면 그 대기가 그대로 쌓인다.
 * 못 받은 범위 자리에는 null 이 들어간다.
 */
export async function fetchOsmBundles(
  boxes: [number, number, number, number][],
  signal?: AbortSignal
): Promise<(OsmBundle | null)[]> {
  if (!boxes.length) return [];
  const qs = new URLSearchParams();
  for (const b of boxes) qs.append("bbox", b.map((v) => v.toFixed(6)).join(","));
  const res = await fetch(`/api/osm?${qs}`, { signal });
  if (!res.ok) throw new Error(await readError(res));
  const json = (await res.json()) as { bundles?: (OsmBundle | null)[] };
  return json.bundles ?? [];
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
