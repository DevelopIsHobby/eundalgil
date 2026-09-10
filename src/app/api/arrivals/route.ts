/**
 * 실시간 버스 도착정보.
 *
 * 정류장 목록을 받아, 그 정류장에 오는 **모든 노선**의 도착 예정을 한 번에 돌려준다.
 * 노선 정보(`/api/transit`)와 달리 몇십 초 만에 값이 바뀌므로 캐시를 아주 짧게 둔다.
 *
 * 실패는 조용히 넘긴다 — 실시간을 못 받으면 화면은 평균 배차로 되돌아갈 뿐이다.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Arrival, ArrivalData, Headway, StopLive } from "@/lib/transit";
import { fetchSeoulArrivals } from "@/lib/seoulbus";
import { fetchTagoArrivals } from "@/lib/tago";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 국내 공공 API 는 해외 IP 에서 끊긴다 — 함수를 서울에서 돌린다 (README "왜 서울 리전인가") */
export const preferredRegion = ["icn1"];

/** 실시간이므로 아주 짧게만 묶어 둔다 (연달아 그리는 동안 같은 정류장을 두 번 묻지 않을 정도) */
const CACHE_TTL_MS = 20 * 1000;
const CACHE_MAX = 200;
/** 한 번에 물어볼 정류장 수 상한 — 후보 4개 × 환승 2구간이면 8곳이면 충분하다 */
const MAX_STOPS = 12;
const CONCURRENCY = 6;

type Entry = { at: number; value: { arrivals: Arrival[]; headways: Headway[] } };
const cache = new Map<string, Entry>();

function cacheKey(live: StopLive) {
  return live.src === "seoul" ? `seoul:${live.arsId}` : `tago:${live.cityCode}:${live.nodeId}`;
}

type Req = { id: string; live: StopLive };

function parse(body: unknown): Req[] {
  const stops = (body as { stops?: unknown })?.stops;
  if (!Array.isArray(stops)) return [];
  const out: Req[] = [];
  const seen = new Set<string>();
  for (const raw of stops) {
    const s = raw as Partial<Req>;
    const live = s.live;
    if (typeof s.id !== "string" || !live) continue;
    if (live.src === "seoul" ? !live.arsId : !(live.cityCode && live.nodeId)) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, live });
    if (out.length >= MAX_STOPS) break;
  }
  return out;
}

async function pooled<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out.push(await run(items[i]));
      } catch (err) {
        // 한 정류장이 실패해도 나머지는 쓴다. 그 정류장만 평균 배차로 안내된다
        console.warn("[arrivals]", (err as Error).message);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse("JSON 본문이 필요합니다", { status: 400 });
  }

  const wanted = parse(body);
  if (!wanted.length) {
    return NextResponse.json({ arrivals: [], headways: [], fetchedAt: Date.now() } as ArrivalData);
  }

  const now = Date.now();
  const results = await pooled(wanted, async ({ id, live }) => {
    const key = cacheKey(live);
    const hit = cache.get(key);
    // 캐시에 담긴 건 정류장 id 가 다를 수 있으니(같은 정류소를 다른 후보가 쓴다) 여기서 갈아 끼운다
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return {
        arrivals: hit.value.arrivals.map((a) => ({ ...a, stopId: id })),
        headways: hit.value.headways.map((h) => ({ ...h, stopId: id })),
      };
    }
    const got =
      live.src === "seoul"
        ? await fetchSeoulArrivals(id, live.arsId)
        : await fetchTagoArrivals(id, live.cityCode, live.nodeId);
    cache.set(key, { at: now, value: got });
    if (cache.size > CACHE_MAX) {
      const oldest = [...cache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return got;
  });

  const data: ArrivalData = {
    arrivals: results.flatMap((r) => r.arrivals),
    headways: results.flatMap((r) => r.headways),
    fetchedAt: Date.now(),
    notice: results.length ? undefined : "실시간 도착정보를 받지 못해 평균 배차로 안내합니다.",
  };
  return NextResponse.json(data);
}
