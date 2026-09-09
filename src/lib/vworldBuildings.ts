/**
 * 건물 = 브이월드 건물통합정보(`LT_C_SPBD`) (서버 전용).
 *
 * 그림자의 원천이 건물이라, 이 데이터의 질이 곧 앱의 질이다. 두 가지가 크게 낫다.
 *
 *   1) **빠르다.** 상도동 일대(1.2km × 1.0km) 3,434동을 1.4초에 받는다.
 *      같은 범위를 공개 Overpass 로 받으면 12~67초가 걸리고, 붐비는 밤에는 아예 실패한다.
 *   2) **높이가 있다.** OSM 국내 건물은 height·building:levels 가 대부분 비어 있어
 *      기본값 12m 로 찍어야 했는데, 여기에는 지상 층수(gro_flo_co)가 거의 다 들어 있다.
 *      그림자 길이는 높이에 그대로 비례하므로 이 차이가 곧 그늘 정확도다.
 *
 * 브이월드 키는 등록한 도메인에서만 통하므로 Referer 를 함께 보낸다.
 */

import type { BBox } from "./geo";
import type { RawBuilding } from "./osm";
import { DEFAULT_HEIGHT, FLOOR_HEIGHT } from "./shadow";
import { readJson, writeJson } from "./diskCache";

const ENDPOINT = "https://api.vworld.kr/req/data";
const LAYER = "LT_C_SPBD";
/** 한 번에 받는 건물 수 — 브이월드 상한이 1,000이다 */
const PAGE = 1000;
/**
 * 페이지 상한. 넓은 범위에서 무한정 받지 않으려는 것이다.
 * 8,000동이면 도심 3km 사방을 덮는다.
 */
const MAX_PAGES = 8;
const TIMEOUT_MS = 12000;
/** 건물은 하루 이틀 사이에 생기고 없어지지 않는다 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function vworldKey() {
  return (process.env.VWORLD_KEY ?? process.env.NEXT_PUBLIC_VWORLD_KEY ?? "").trim();
}

export function hasVWorldBuildings() {
  return !!vworldKey();
}

type Feature = {
  properties?: Record<string, string | number | null>;
  geometry?: { type: string; coordinates: unknown };
};

function ringsOf(geometry: Feature["geometry"]): number[][][] {
  if (!geometry) return [];
  const c = geometry.coordinates as unknown;
  // Polygon: [ring][point][2] · MultiPolygon: [polygon][ring][point][2]
  if (geometry.type === "Polygon") return [(c as number[][][])[0] ?? []];
  if (geometry.type === "MultiPolygon")
    return (c as number[][][][]).map((poly) => poly[0] ?? []).filter((r) => r.length >= 3);
  return [];
}

/** 지상 층수 → 높이(m). 층수가 없거나 0이면 그냥 기본값으로 둔다 */
function heightOf(props: Feature["properties"]) {
  const floors = Number(props?.gro_flo_co ?? 0);
  if (!Number.isFinite(floors) || floors <= 0) return DEFAULT_HEIGHT;
  return floors * FLOOR_HEIGHT + 1.5;
}

async function fetchPage(box: BBox, page: number, referer: string): Promise<{ features: Feature[]; total: number }> {
  const params = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: LAYER,
    key: vworldKey(),
    domain: referer,
    format: "json",
    crs: "EPSG:4326",
    size: String(PAGE),
    page: String(page),
    geomFilter: `BOX(${box.minLng},${box.minLat},${box.maxLng},${box.maxLat})`,
  });

  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { Referer: referer },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`브이월드 건물 ${res.status}`);

  const json = (await res.json()) as {
    response?: {
      status?: string;
      error?: { text?: string };
      record?: { total?: string };
      result?: { featureCollection?: { features?: Feature[] } };
    };
  };
  const r = json.response;
  if (r?.status === "NOT_FOUND") return { features: [], total: 0 };
  if (r?.status !== "OK") throw new Error(`브이월드 건물: ${r?.error?.text ?? r?.status ?? "알 수 없는 오류"}`);

  return {
    features: r.result?.featureCollection?.features ?? [],
    total: Number(r.record?.total ?? 0),
  };
}

const keyOf = (b: BBox) =>
  [b.minLng, b.minLat, b.maxLng, b.maxLat].map((v) => v.toFixed(4)).join(",");

/**
 * 범위 안의 건물. 실패하면 null 을 돌려주고, 부르는 쪽이 OSM 으로 되돌아간다.
 * @param referer 브이월드에 등록한 도메인 (서버에서 부를 때는 이걸로 알려 줘야 한다)
 */
export async function fetchVWorldBuildings(box: BBox, referer: string): Promise<RawBuilding[] | null> {
  if (!vworldKey()) return null;

  const cacheKey = keyOf(box);
  const saved = await readJson<RawBuilding[]>("vworld-bld", cacheKey, TTL_MS);
  if (saved) return saved;

  try {
    const first = await fetchPage(box, 1, referer);
    const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE) || 1);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(box, i + 2, referer))
    );
    if (first.total > MAX_PAGES * PAGE) {
      console.warn(`[buildings] ${first.total}동 중 ${MAX_PAGES * PAGE}동만 씁니다 (범위가 넓습니다)`);
    }

    const out: RawBuilding[] = [];
    for (const feature of [first, ...rest].flatMap((p) => p.features)) {
      const height = heightOf(feature.properties);
      const id = String(feature.properties?.bd_mgt_sn ?? out.length);
      ringsOf(feature.geometry).forEach((ring, i) => {
        // 마지막 점이 첫 점과 같으면 빼 둔다 (그림자 계산은 닫히지 않은 링을 쓴다)
        const closed =
          ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
        const points = (closed ? ring.slice(0, -1) : ring).map(([lng, lat]) => [lng, lat] as [number, number]);
        if (points.length >= 3) out.push({ id: `vw${id}_${i}`, ring: points, height });
      });
    }

    if (out.length) void writeJson("vworld-bld", cacheKey, out);
    return out;
  } catch (err) {
    console.warn("[buildings] 브이월드:", (err as Error).message);
    return null;
  }
}
