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

const cache = new Map<string, { at: number; hits: PlaceHit[] }>();
const TTL = 5 * 60 * 1000;

/** 네이버 지역 검색 API (선택). 키가 없으면 Nominatim으로 폴백한다. */
async function naverLocal(q: string): Promise<PlaceHit[] | null> {
  const id = process.env.NAVER_SEARCH_CLIENT_ID;
  const secret = process.env.NAVER_SEARCH_CLIENT_SECRET;
  if (!id || !secret) return null;

  const url = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(q)}&display=8&sort=random`;
  const res = await fetch(url, {
    headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
    signal: AbortSignal.timeout(8000),
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

async function nominatim(q: string): Promise<PlaceHit[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=ko` +
    `&countrycodes=kr&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "eundalgil-shade-walk/0.1 (dev)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`검색 서버 오류 (${res.status})`);

  const json = (await res.json()) as {
    place_id: number;
    name?: string;
    display_name: string;
    lon: string;
    lat: string;
    type?: string;
  }[];

  return json.map((it) => {
    const parts = it.display_name.split(",").map((s) => s.trim());
    return {
      id: `nm${it.place_id}`,
      name: it.name || parts[0],
      address: parts.slice(1, 4).reverse().join(" ") || it.display_name,
      category: it.type,
      lng: Number(it.lon),
      lat: Number(it.lat),
    };
  });
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ hits: [] });

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json({ hits: hit.hits });

  try {
    const hits = (await naverLocal(q)) ?? (await nominatim(q));
    cache.set(q, { at: Date.now(), hits });
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ hits });
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 502 });
  }
}
