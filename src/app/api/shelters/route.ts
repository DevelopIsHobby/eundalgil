/**
 * 무더위쉼터 (서울 열린데이터광장 `TbGtnHwcwP`).
 *
 * 그늘을 밟고 걷는 앱이라면, 그늘이 끊기는 구간에서 **잠깐 들어가 쉴 곳**까지 알려 주는 게 맞다.
 * 서울에 4,000곳 넘게 있고 좌표·운영요일·운영시간이 다 들어 있어서
 * "지금 문 연 곳" 만 골라 줄 수 있다.
 *
 * 목록이 통째로 4천 건이라 범위로 잘라 주지 않는다. 그래서 한 번 통째로 받아 두고
 * 메모리에 담은 뒤, 요청한 범위만 잘라서 돌려준다. (하루에 한 번이면 충분하다)
 */

import { NextRequest, NextResponse } from "next/server";
import type { LngLat } from "@/lib/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = "http://openapi.seoul.go.kr:8088";
const SERVICE = "TbGtnHwcwP";
/** 열린데이터광장은 한 번에 1,000행까지 준다 */
const PAGE = 1000;
const MAX_PAGES = 6;
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

export type Shelter = {
  id: string;
  name: string;
  /** "경로당" · "주민센터" 처럼 짧게 */
  kind: string;
  address: string;
  p: LngLat;
  /** 오늘 이 시각에 문을 열고 있는지 */
  openNow: boolean;
  /** "09:00~18:00" — 오늘 기준 */
  hours: string;
};

function seoulKey() {
  return (
    process.env.SEOUL_OPENAPI_KEY?.trim() ||
    process.env.SEOUL_CITYDATA_KEY?.trim() ||
    ""
  );
}

type Row = Record<string, string>;
let cache: { at: number; rows: Row[] } | null = null;
let inflight: Promise<Row[]> | null = null;

async function fetchPage(key: string, from: number, to: number): Promise<Row[]> {
  const res = await fetch(`${BASE}/${key}/json/${SERVICE}/${from}/${to}/`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`무더위쉼터 ${res.status}`);
  const json = (await res.json()) as Record<string, { row?: Row[]; RESULT?: { CODE?: string; MESSAGE?: string } }>;
  const body = json[SERVICE];
  const code = body?.RESULT?.CODE ?? (json.RESULT as { CODE?: string } | undefined)?.CODE;
  if (code && code !== "INFO-000") {
    throw new Error(`무더위쉼터 ${code}: ${body?.RESULT?.MESSAGE ?? "알 수 없는 오류"}`);
  }
  return body?.row ?? [];
}

async function allRows(): Promise<Row[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  if (inflight) return inflight;

  const key = seoulKey();
  if (!key) throw new Error("서울 열린데이터광장 키가 없습니다 (환경 변수 SEOUL_OPENAPI_KEY)");

  inflight = (async () => {
    const rows: Row[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await fetchPage(key, page * PAGE + 1, (page + 1) * PAGE);
      rows.push(...got);
      if (got.length < PAGE) break;
    }
    cache = { at: Date.now(), rows };
    return rows;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

function minutesOf(hhmm: string) {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 오늘 이 시각에 문을 열었는지 — 연장·추가 운영도 함께 본다 */
function openAt(row: Row, at: Date) {
  const day = DAYS[at.getDay()];
  const now = at.getHours() * 60 + at.getMinutes();

  const windows: [string, string, string][] = [
    [row.OPR_DAYS ?? "", row.OPR_START_TIME ?? "", row.OPR_END_TIME ?? ""],
  ];
  if (row.EXT_OPR_YN === "Y")
    windows.push([row.EXT_OPR_DAYS ?? "", row.EXT_OPR_START_TIME ?? "", row.EXT_OPR_END_TIME ?? ""]);
  if (row.ADD_OPR_YN === "Y")
    windows.push([row.ADD_OPR_DAYS ?? "", row.ADD_OPR_START_TIME ?? "", row.ADD_OPR_END_TIME ?? ""]);

  let open = false;
  let hours = "";
  for (const [days, start, end] of windows) {
    if (!days.includes(day)) continue;
    const s = minutesOf(start);
    const e = minutesOf(end);
    if (s == null || e == null) continue;
    if (!hours) hours = `${start}~${end}`;
    if (now >= s && now <= e) {
      open = true;
      hours = `${start}~${end}`;
      break;
    }
  }
  return { open, hours };
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("bbox");
  if (!raw) return new NextResponse("bbox 파라미터가 필요합니다", { status: 400 });
  const n = raw.split(",").map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)))
    return new NextResponse("bbox 형식이 올바르지 않습니다", { status: 400 });
  const [minLng, minLat, maxLng, maxLat] = n;

  const atMs = Number(req.nextUrl.searchParams.get("at"));
  const at = Number.isFinite(atMs) ? new Date(atMs) : new Date();

  let rows: Row[];
  try {
    rows = await allRows();
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 503 });
  }

  const shelters: Shelter[] = [];
  for (const row of rows) {
    const lng = Number(row.LON);
    const lat = Number(row.LAT);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;

    const { open, hours } = openAt(row, at);
    shelters.push({
      id: `${row.AREA_CD ?? ""}${row.R_AREA_NM ?? ""}${lng.toFixed(5)}`,
      name: row.R_AREA_NM ?? "무더위쉼터",
      kind: row.FACILITY_TYPE2 || row.FACILITY_TYPE1 || "쉼터",
      address: row.R_DETL_ADD ?? row.LOTNO_ADDR ?? "",
      p: [lng, lat],
      openNow: open,
      hours,
    });
  }

  return NextResponse.json({ shelters, total: rows.length });
}
