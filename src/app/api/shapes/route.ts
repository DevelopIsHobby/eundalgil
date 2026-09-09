/**
 * 노선 형상 — 버스가 실제로 지나는 길의 좌표열.
 *
 * 근처 노선을 통째로 받으면(한 노선에 400~1500점) 응답도 시간도 감당이 안 된다.
 * 그래서 `/api/transit` 은 정류장 순서만 주고, 화면에 실제로 안내할 노선이 정해진
 * 다음에 그 노선들만 여기서 받는다.
 *
 * 형상이 없으면 정류장을 직선으로 잇는다. 그림이 거칠 뿐 안내는 나간다.
 */

import { NextRequest, NextResponse } from "next/server";
import type { LngLat } from "@/lib/geo";
import type { PatternLive } from "@/lib/transit";
import { fetchSeoulShape } from "@/lib/seoulbus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 한 번에 물어볼 노선 수 상한 — 후보 4개 × 환승 2구간이면 넉넉하다 */
const MAX_PATTERNS = 12;
const CONCURRENCY = 4;

type Req = { id: string; live: PatternLive; stops: LngLat[] };

export type ShapeResult = { id: string; shape: LngLat[]; stopIndex: number[] };

function parse(body: unknown): Req[] {
  const list = (body as { patterns?: unknown })?.patterns;
  if (!Array.isArray(list)) return [];
  const out: Req[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = raw as Partial<Req>;
    if (typeof p.id !== "string" || !p.live?.routeId || !Array.isArray(p.stops)) continue;
    if (p.stops.length < 2 || seen.has(p.id)) continue;
    const stops = p.stops.filter(
      (s): s is LngLat => Array.isArray(s) && s.length === 2 && s.every(Number.isFinite)
    );
    if (stops.length !== p.stops.length) continue;
    seen.add(p.id);
    out.push({ id: p.id, live: p.live, stops });
    if (out.length >= MAX_PATTERNS) break;
  }
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
  const out: ShapeResult[] = [];
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= wanted.length) return;
        const { id, live, stops } = wanted[i];
        // 형상을 주는 건 서울 TOPIS 뿐이다. TAGO 에는 해당 API 가 없다
        if (live.src !== "seoul") continue;
        try {
          const got = await fetchSeoulShape(live.routeId, stops);
          if (got) out.push({ id, ...got });
        } catch (err) {
          // 한 노선이 실패해도 나머지는 쓴다. 그 노선만 직선으로 그려진다
          console.warn("[shapes]", (err as Error).message);
        }
      }
    })
  );

  return NextResponse.json({ shapes: out });
}
