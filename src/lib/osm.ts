import type { LngLat } from "./geo";

export type WalkWay = {
  id: string;
  path: LngLat[];
  kind: "footway" | "steps" | "crossing" | "road" | "park";
  /** 경사 태그 원본 (예: "10%", "up") */
  incline?: string;
  name?: string;
  /** 지붕/아케이드 등 상시 그늘 구간 */
  covered?: boolean;
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
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `지도 데이터를 불러오지 못했습니다 (${res.status})`);
  }
  return res.json();
}
