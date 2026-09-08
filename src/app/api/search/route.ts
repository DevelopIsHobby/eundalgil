import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PlaceHit = {
  id: string;
  name: string;
  address: string;
  category?: string;
  lng: number;
  lat: number;
};

/** 검색 기준점 — 지금 보고 있는 지도 중심. 가까운 결과를 먼저 보여주는 데 쓴다. */
type Bias = { lng: number; lat: number } | null;

const cache = new Map<string, { at: number; hits: PlaceHit[] }>();
const TTL = 5 * 60 * 1000;
const LIMIT = 8;

/** 대한민국 대략 경계 — 해외 동명 지역이 섞이지 않게 막는다 */
const KR_BBOX = [124.5, 33.0, 132.0, 38.7] as const;

/**
 * 도로명 주소는 "삼성로86길" 처럼 길 번호를 붙여 쓴다.
 * 사람은 "삼성로 86길" 로 띄어 쓰는 일이 많은데, 그대로 보내면 한 건도 안 나온다.
 * "…로/대로" + 숫자 + "길/번길" 조합일 때만 붙인다. ("테헤란로 5" 의 5는 건물번호라 건드리면 안 된다)
 */
function normalizeRoadName(q: string) {
  return q
    .replace(/([가-힣A-Za-z0-9]+(?:대로|로))\s+(\d+)\s*(번길|길)/g, "$1$2$3")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 같은 장소가 여러 출처에서 겹쳐 온다. 이름 + 좌표(약 10m)로 한 번 걸러 낸다.
 * 좌표를 느슨하게 잡아도 이름이 다르면 남으므로 한 건물 안의 서로 다른 지점은 살아남는다.
 */
function dedupe(hits: PlaceHit[]) {
  const seen = new Set<string>();
  const out: PlaceHit[] = [];
  for (const h of hits) {
    const key = `${h.name}@${h.lng.toFixed(4)},${h.lat.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * 출처별 결과를 한 건씩 번갈아 가며 뽑는다.
 * 한 곳이 앞자리를 다 차지하지 못하게 하려는 것이다 — 예를 들어 "서울시청" 은
 * 브이월드가 전기차충전소·버스정류장을 먼저 주지만 OSM 은 서울특별시청을 바로 준다.
 */
function interleave(groups: PlaceHit[][]) {
  const out: PlaceHit[] = [];
  const longest = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < longest; i++) {
    for (const g of groups) if (g[i]) out.push(g[i]);
  }
  return out;
}

function joinAddress(parts: (string | undefined)[]) {
  const out: string[] = [];
  for (const p of parts) {
    const v = p?.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.join(" ");
}

/**
 * 도로명 주소는 "시·도 / 시·군·구 / 도로명 / 건물번호" 로 끝난다.
 * 행정동·법정동·우편번호는 공식 표기에 넣지 않으므로 뺀다.
 * 도로명이 없는 결과(동네 자체 등)만 동 이름으로 대신한다.
 */
function koreanAddress(a: {
  wide?: string;
  city?: string;
  district?: string;
  road?: string;
  houseNumber?: string;
}) {
  // "11, 거봉INC 지상2층" 처럼 건물 정보가 붙어 오면 번호만 남긴다
  const no = a.houseNumber?.split(",")[0]?.trim();
  return a.road
    ? joinAddress([a.wide, a.city, a.road, no])
    : joinAddress([a.wide, a.city, a.district]);
}

/** 네이버 지역 검색 API (선택). 키가 있으면 국내 상호 검색이 가장 정확하다. */
async function naverLocal(q: string, signal: AbortSignal): Promise<PlaceHit[] | null> {
  const id = process.env.NAVER_SEARCH_CLIENT_ID;
  const secret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!id || !secret) return null;

  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(q)}&display=${LIMIT}&sort=random`;
  const res = await fetch(url, {
    headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
    signal,
  });
  if (!res.ok) return null;

  const json = (await res.json()) as {
    items?: { title: string; address: string; roadAddress: string; category: string; mapx: string; mapy: string }[];
  };
  return (json.items ?? []).map((it, i) => ({
    id: `nv${i}`,
    name: it.title.replace(/<[^>]+>/g, ""),
    address: it.roadAddress || it.address,
    category: it.category?.split(">").pop()?.trim(),
    // 네이버 지역검색은 KATECH이 아닌 WGS84*1e7 정수로 내려온다
    lng: Number(it.mapx) / 1e7,
    lat: Number(it.mapy) / 1e7,
  }));
}

/**
 * 브이월드 검색 2.0 (선택) — 국토교통부 도로명주소 DB.
 *
 * OSM 은 국내 중소형 빌딩의 이름을 거의 담고 있지 않다. 예를 들어 "삼성로86길 11" 의
 * 거봉INC 는 OSM 어디에도 name 으로 없고 입주 점포의 addr:unit 안에만 적혀 있어서
 * Nominatim·Photon 으로는 영영 찾을 수 없다. 브이월드 ADDRESS 결과에는 bldnm(건물명)이
 * 따로 들어 있어 이런 건물이 이름으로 잡힌다.
 *
 * 응답 껍데기가 문서와 실제가 조금씩 다르게 알려져 있어(최상위 response 유무, items 가
 * 배열이거나 {item:...} 이거나) 어느 쪽이 와도 읽히게 해 둔다.
 */
type VWorldItem = {
  id?: string;
  title?: string;
  category?: string;
  point?: { x: string | number; y: string | number };
  address?: { road?: string; parcel?: string; bldnm?: string; bldnmdc?: string; zipcode?: string };
};

function vworldItems(json: unknown): VWorldItem[] {
  const root = (json as { response?: unknown })?.response ?? json;
  const result = (root as { result?: { items?: unknown } })?.result;
  const items = result?.items as unknown;
  if (!items) return [];
  if (Array.isArray(items)) return items as VWorldItem[];
  const one = (items as { item?: unknown }).item;
  if (Array.isArray(one)) return one as VWorldItem[];
  return one ? [one as VWorldItem] : [];
}

function vworldStatus(json: unknown) {
  const root = ((json as { response?: unknown })?.response ?? json) as {
    status?: string;
    error?: { code?: string; text?: string };
  };
  return {
    status: String(root?.status ?? ""),
    // 키가 틀렸는지 도메인이 안 맞는지는 이 코드를 봐야 안다 (INVALID_KEY / INCORRECT_KEY)
    error: [root?.error?.code, root?.error?.text].filter(Boolean).join(" — "),
  };
}

async function vworldOnce(
  q: string,
  type: "ADDRESS" | "PLACE",
  key: string,
  referer: string,
  signal: AbortSignal
): Promise<PlaceHit[]> {
  const params = new URLSearchParams({
    service: "search",
    request: "search",
    version: "2.0",
    crs: "EPSG:4326",
    format: "json",
    errorFormat: "json",
    size: String(LIMIT),
    page: "1",
    type,
    query: q,
    key,
  });
  // ADDRESS 는 도로명/지번 중 하나를 반드시 골라야 한다
  if (type === "ADDRESS") params.set("category", "ROAD");

  // 브이월드 키는 등록한 도메인에서만 통한다. 서버에서 부를 때는 Referer 로 알려 줘야 한다
  const res = await fetch(`https://api.vworld.kr/req/search?${params}`, {
    headers: { Referer: referer },
    signal,
  });
  if (!res.ok) throw new Error(`VWorld ${res.status}`);

  const json = await res.json();
  const { status, error } = vworldStatus(json);
  if (status === "NOT_FOUND") return [];
  if (status && status !== "OK") throw new Error(`VWorld ${type} ${status}: ${error || "사유 없음"}`);

  return vworldItems(json)
    .map((it, i): PlaceHit | null => {
      const lng = Number(it.point?.x);
      const lat = Number(it.point?.y);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

      const title = it.title?.trim();
      const bldnm = it.address?.bldnm?.trim();
      const parcel = it.address?.parcel?.trim();
      // 도로명은 "…삼성로86길 11 (대치동)" 처럼 법정동이 괄호로 붙어 온다.
      // 제목으로 쓸 때는 길어서 떼고, 주소로 쓸 때는 그대로 둔다.
      const road = it.address?.road?.trim();
      const roadShort = road?.replace(/\s*\([^)]*\)\s*$/, "");

      // PLACE 는 상호가 제목. ADDRESS 는 건물명이 있으면 건물명, 없으면 주소 자체가 제목이 된다.
      const name = title || bldnm || roadShort || parcel || q;
      // 제목이 곧 주소인 경우(건물명 없는 주소 결과)까지 같은 줄을 두 번 보여 주지 않는다
      const address = name === roadShort ? (parcel ? `지번 ${parcel}` : (road ?? "")) : (road ?? parcel ?? "");

      return {
        id: `vw${type}${it.id ?? i}`,
        name,
        // "건물 > 제2종근린생활시설" 처럼 대분류부터 오므로 가장 구체적인 끝만 쓴다.
        // 주소 검색 결과에는 분류가 없어서 무엇으로 잡힌 줄인지 표시해 준다.
        category:
          it.category?.split(">").pop()?.trim() ||
          (type === "ADDRESS" ? (bldnm ? "건물" : "주소") : undefined),
        address,
        lng,
        lat,
      };
    })
    .filter((h): h is PlaceHit => h !== null);
}

async function vworld(q: string, origin: string, signal: AbortSignal): Promise<PlaceHit[] | null> {
  const key = (process.env.VWORLD_KEY ?? process.env.NEXT_PUBLIC_VWORLD_KEY ?? "").trim();
  if (!key) return null;
  // 보통은 앱이 떠 있는 주소가 곧 브이월드에 등록한 도메인이다
  const referer = process.env.VWORLD_REFERER ?? origin;

  const settled = await Promise.allSettled([
    vworldOnce(q, "ADDRESS", key, referer, signal),
    vworldOnce(q, "PLACE", key, referer, signal),
  ]);
  for (const s of settled) {
    // 키가 틀리면 조용히 빈 결과가 되는 대신 서버 로그에 남긴다
    if (s.status === "rejected") console.warn("[search] vworld:", (s.reason as Error)?.message);
  }
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  // 주소와 장소를 번갈아 넣는다. 한쪽이 5건씩 쏟아져 다른 쪽을 덮지 않게 하려는 것이다
  // (예: "강남역" 은 주소 쪽이 오피스텔 이름을 먼저 주고, 지하철역은 장소 쪽에 있다)
  return ok.length ? interleave(ok) : null;
}

/** Nominatim — 주소를 정확히 적었을 때 가장 잘 맞는다. 상호 검색은 거의 안 된다. */
async function nominatim(q: string, bias: Bias, signal: AbortSignal): Promise<PlaceHit[]> {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: String(LIMIT),
    "accept-language": "ko",
    countrycodes: "kr",
    addressdetails: "1",
    q,
  });
  if (bias) {
    // bounded=0 이라 경계 밖도 나오되, 이 영역 안이 위로 올라온다
    params.set("viewbox", `${bias.lng - 0.15},${bias.lat + 0.12},${bias.lng + 0.15},${bias.lat - 0.12}`);
    params.set("bounded", "0");
  }

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { "User-Agent": "eundalgil-shade-walk/0.1 (https://github.com/DevelopIsHobby/eundalgil)" },
    signal,
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);

  const json = (await res.json()) as {
    place_id: number;
    name?: string;
    display_name: string;
    lon: string;
    lat: string;
    type?: string;
    address?: Record<string, string>;
  }[];

  return json.map((it) => {
    const a = it.address ?? {};
    return {
      id: `nm${it.place_id}`,
      // display_name 은 좁은 곳 → 넓은 곳 순서라 첫 조각이 장소 이름이다
      name: it.name || it.display_name.split(",")[0].trim(),
      address: koreanAddress({
        wide: a.state ?? a.city ?? a.province,
        city: a.borough ?? a.county ?? a.town ?? (a.state ? a.city : undefined),
        district: a.suburb ?? a.quarter ?? a.neighbourhood,
        road: a.road,
        houseNumber: a.house_number,
      }),
      category: it.type,
      lng: Number(it.lon),
      lat: Number(it.lat),
    };
  });
}

/**
 * Photon — 같은 OSM 데이터를 흐릿하게(부분 일치) 찾아 준다.
 * 치자마자 뜨는 자동완성과 상호 검색은 이쪽이 훨씬 낫고, 대신 엉뚱한 동네를 물어 오기도 한다.
 */
async function photon(q: string, bias: Bias, signal: AbortSignal): Promise<PlaceHit[]> {
  const params = new URLSearchParams({
    q,
    limit: String(LIMIT),
    lang: "default",
    bbox: KR_BBOX.join(","),
  });
  if (bias) {
    params.set("lat", String(bias.lat));
    params.set("lon", String(bias.lng));
  }

  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Photon ${res.status}`);

  const json = (await res.json()) as {
    features?: {
      geometry: { coordinates: [number, number] };
      properties: {
        osm_type?: string;
        osm_id?: number;
        osm_value?: string;
        name?: string;
        housenumber?: string;
        street?: string;
        locality?: string;
        district?: string;
        city?: string;
        state?: string;
        countrycode?: string;
      };
    }[];
  };

  return (json.features ?? [])
    .filter((f) => f.properties.countrycode === "KR")
    .map((f) => {
      const p = f.properties;
      const streetLine = joinAddress([p.street, p.housenumber]);
      return {
        id: `ph${p.osm_type ?? ""}${p.osm_id ?? Math.random()}`,
        name: p.name || streetLine || "이름 없는 장소",
        address: koreanAddress({
          wide: p.state ?? p.city,
          city: p.state ? p.city : undefined,
          district: p.locality ?? p.district,
          road: p.street,
          houseNumber: p.housenumber,
        }),
        category: p.osm_value,
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      };
    });
}

/**
 * 여러 곳을 동시에 물어 한 건씩 번갈아 합친다.
 * 어느 하나가 죽어도 나머지 결과는 그대로 보여 준다.
 *
 *   - 브이월드 — 키가 있을 때. 국내 도로명주소·건물명이 가장 정확하다
 *   - Nominatim — 주소를 정확히 적었을 때 잘 맞는다
 *   - Photon   — 상호·부분 입력에 강한 대신 엉뚱한 동네도 물어 온다
 */
async function search(q: string, bias: Bias, origin: string, signal: AbortSignal): Promise<PlaceHit[]> {
  const settled = await Promise.allSettled([
    vworld(q, origin, signal),
    nominatim(q, bias, signal),
    photon(q, bias, signal),
  ]);
  const groups = settled
    .filter((s) => s.status === "fulfilled")
    .map((s) => s.value)
    // 키가 없어 건너뛴 출처(null)와 결과가 없는 출처는 순번에서 뺀다
    .filter((v): v is PlaceHit[] => v !== null && v.length > 0);
  // 전부 죽었을 때만 오류로 본다
  if (!settled.some((s) => s.status === "fulfilled")) {
    throw new Error("검색 서버에 연결하지 못했습니다.");
  }
  return dedupe(interleave(groups)).slice(0, LIMIT);
}

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (raw.length < 1) return NextResponse.json({ hits: [] });

  const lng = Number(req.nextUrl.searchParams.get("lng"));
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const bias: Bias = Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;

  const q = normalizeRoadName(raw);
  const key = bias ? `${q}|${bias.lng.toFixed(2)},${bias.lat.toFixed(2)}` : q;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return NextResponse.json({ hits: cached.hits });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const hits =
      (await naverLocal(q, ctl.signal)) ?? (await search(q, bias, req.nextUrl.origin, ctl.signal));
    cache.set(key, { at: Date.now(), hits });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ hits });
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
