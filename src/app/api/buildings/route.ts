/**
 * 건물만 가볍게 주는 창구.
 *
 * `/api/osm` 은 보행로·가로수·방범시설까지 한 덩어리로 주므로 Overpass 를 기다려야 한다.
 * 버스가 지나는 구간의 그늘처럼 **건물만 있으면 되는 곳**에서는 그 기다림이 아깝다.
 * 브이월드는 같은 범위를 1초 남짓에 주므로 따로 열어 둔다.
 */

import { NextRequest, NextResponse } from "next/server";
import { EARTH_M_PER_DEG_LAT, mPerDegLon, type BBox } from "@/lib/geo";
import { fetchVWorldBuildings, hasVWorldBuildings } from "@/lib/vworldBuildings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 한 번에 받을 수 있는 범위 상한 — 이보다 넓으면 건물이 수만 동이 된다 */
const MAX_SPAN_LAT = 0.05;
const MAX_SPAN_LNG = 0.06;

/** 격자에 맞춰 잘라 두면 조금씩 다른 범위가 같은 캐시를 쓴다 */
const GRID = 0.004;
function snap(b: BBox): BBox {
  return {
    minLng: Math.floor(b.minLng / GRID) * GRID,
    minLat: Math.floor(b.minLat / GRID) * GRID,
    maxLng: Math.ceil(b.maxLng / GRID) * GRID,
    maxLat: Math.ceil(b.maxLat / GRID) * GRID,
  };
}

export async function GET(req: NextRequest) {
  if (!hasVWorldBuildings())
    return new NextResponse("브이월드 키가 없습니다 (.env.local 의 VWORLD_KEY)", { status: 503 });

  const raw = req.nextUrl.searchParams.get("bbox");
  if (!raw) return new NextResponse("bbox 파라미터가 필요합니다", { status: 400 });
  const n = raw.split(",").map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)))
    return new NextResponse("bbox 형식이 올바르지 않습니다", { status: 400 });

  let box: BBox = { minLng: n[0], minLat: n[1], maxLng: n[2], maxLat: n[3] };
  if (box.maxLat - box.minLat > MAX_SPAN_LAT || box.maxLng - box.minLng > MAX_SPAN_LNG)
    return new NextResponse("범위가 너무 넓습니다", { status: 400 });
  box = snap(box);

  const referer = process.env.VWORLD_REFERER || req.nextUrl.origin;
  const buildings = await fetchVWorldBuildings(box, referer);
  if (!buildings) return new NextResponse("건물을 불러오지 못했습니다", { status: 503 });

  // 지도에 그리는 게 아니라 그늘 계산에만 쓰므로 좌표는 그대로 둔다
  return NextResponse.json({ buildings, bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat] });
}

/** 미터 단위로 범위를 넓힌다 (부르는 쪽 편의를 위해 여기 둔다) */
export function padBox(b: BBox, meters: number): BBox {
  const dLat = meters / EARTH_M_PER_DEG_LAT;
  const dLng = meters / mPerDegLon((b.minLat + b.maxLat) / 2);
  return {
    minLng: b.minLng - dLng,
    minLat: b.minLat - dLat,
    maxLng: b.maxLng + dLng,
    maxLat: b.maxLat + dLat,
  };
}
