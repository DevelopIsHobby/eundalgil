/**
 * 국토교통부 TAGO 버스 정보 (서버 전용).
 *
 * OpenStreetMap 에는 국내 시내·마을버스 노선이 거의 없다. 정부가 여는 TAGO 는
 * **좌표로 가까운 정류소**를 찾고, **노선이 지나는 정류소를 순서대로** 주기 때문에
 * 우리가 쓰는 모양(정류장 + 지나는 순서)에 그대로 맞는다.
 *
 *   1) 정류소정보 getCrdntPrxmtSttnList  — 좌표 주변 정류소
 *   2) 정류소정보 getSttnThrghRouteList  — 그 정류소를 지나는 노선
 *   3) 노선정보   getRouteAcctoThrghSttnList — 노선이 지나는 정류소 순서
 *
 * 인증키는 공공데이터포털이 주는 "Encoding" 값(%2B·%3D 가 섞인 문자열)을 **그대로** 붙인다.
 * URLSearchParams 에 넣으면 다시 인코딩돼 키가 깨지므로 쿼리 문자열을 직접 잇는다.
 */

import { distMeters, type LngLat } from "./geo";
import { readJson, writeJson } from "./diskCache";
import { tagoBusColor } from "./busColor";
import {
  ARRIVAL_HORIZON_S,
  type Arrival,
  type Headway,
  type TransitPattern,
  type TransitStop,
} from "./transit";

const BASE_STOP = "https://apis.data.go.kr/1613000/BusSttnInfoInqireService";
const BASE_ROUTE = "https://apis.data.go.kr/1613000/BusRouteInfoInqireService";
const BASE_ARRIVAL = "https://apis.data.go.kr/1613000/ArvlInfoInqireService";

const TIMEOUT_MS = 7000;
/** 노선이 지나는 정류소 순서는 거의 바뀌지 않는다 */
const ROUTE_TTL = 12 * 60 * 60 * 1000;
const STOP_TTL = 60 * 60 * 1000;
/** 한 번에 열어 두는 요청 수 — 공공 API 라 너무 몰아붙이지 않는다 */
const CONCURRENCY = 6;
/** 정류소 하나당 노선, 노선 하나당 정류소 상한 */
const MAX_ROWS = 200;
/** 정류장 순서를 받아 올 노선 수 상한 */
const MAX_ROUTES = 48;

export function hasTagoKey() {
  return !!process.env.TAGO_KEY?.trim();
}

type Cached<T> = { at: number; value: T };
const cache = new Map<string, Cached<unknown>>();

function getCached<T>(key: string, ttl: number): T | undefined {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > ttl) return undefined;
  return hit.value as T;
}

function setCached<T>(key: string, value: T) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 3000) cache.delete(cache.keys().next().value as string);
}

/** TAGO 응답 껍데기: response.body.items.item 이 배열이거나 객체 하나거나 빈 문자열이다 */
function itemsOf(json: unknown): Record<string, unknown>[] {
  const body = (json as { response?: { body?: { items?: unknown } } })?.response?.body;
  const items = body?.items;
  if (!items || typeof items === "string") return [];
  const item = (items as { item?: unknown }).item ?? items;
  if (Array.isArray(item)) return item as Record<string, unknown>[];
  return item ? [item as Record<string, unknown>] : [];
}

async function call(base: string, op: string, params: Record<string, string | number>) {
  const key = process.env.TAGO_KEY?.trim();
  if (!key) throw new Error("TAGO_KEY 없음");

  const qs = Object.entries({ _type: "json", ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  // serviceKey 는 이미 URL 인코딩된 값이라 다시 인코딩하지 않는다
  const url = `${base}/${op}?serviceKey=${key}&${qs}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`TAGO ${op} ${res.status}`);

  const text = await res.text();
  // 키가 막히거나 호출 한도를 넘기면 JSON 을 달라고 해도 XML 오류를 준다
  if (text.trimStart().startsWith("<")) {
    const reason = text.match(/<returnAuthMsg>([^<]*)<|<errMsg>([^<]*)</)?.slice(1).find(Boolean);
    throw new Error(`TAGO ${op}: ${reason ?? "XML 오류 응답"}`);
  }
  return JSON.parse(text);
}

/** 동시에 여러 개를 부르되 한 번에 CONCURRENCY 개까지만 */
async function pooled<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out.push(await run(items[i]));
      } catch {
        /* 한 건이 실패해도 나머지는 쓴다 */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const num = (v: unknown) => Number(String(v ?? ""));
const str = (v: unknown) => String(v ?? "").trim();

export type TagoStop = TransitStop & { cityCode: string; nodeId: string };

/** 좌표 주변 정류소 */
async function nearbyStops(p: LngLat, radius: number): Promise<TagoStop[]> {
  const key = `near:${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const hit = getCached<TagoStop[]>(key, STOP_TTL);
  if (hit) return hit;

  const json = await call(BASE_STOP, "getCrdntPrxmtSttnList", {
    gpsLati: p[1].toFixed(6),
    gpsLong: p[0].toFixed(6),
    numOfRows: 60,
    pageNo: 1,
  });

  const stops = itemsOf(json)
    .map((it): TagoStop | null => {
      const lat = num(it.gpslati);
      const lng = num(it.gpslong);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const nodeId = str(it.nodeid);
      return {
        id: `tago${nodeId}`,
        nodeId,
        cityCode: str(it.citycode),
        name: str(it.nodenm) || "이름 없는 정류장",
        p: [lng, lat],
        mode: "bus",
      };
    })
    .filter((s): s is TagoStop => !!s && distMeters(p, s.p) <= radius);

  setCached(key, stops);
  return stops;
}

/** 정류소를 지나는 노선 */
type TagoRoute = { routeId: string; routeNo: string; cityCode: string; routeType: string };

async function routesOfStop(stop: TagoStop): Promise<TagoRoute[]> {
  const key = `routes:${stop.cityCode}:${stop.nodeId}`;
  const hit = getCached<TagoRoute[]>(key, STOP_TTL);
  if (hit) return hit;

  const json = await call(BASE_STOP, "getSttnThrghRouteList", {
    cityCode: stop.cityCode,
    nodeid: stop.nodeId,
    numOfRows: MAX_ROWS,
    pageNo: 1,
  });

  const routes = itemsOf(json)
    .map((it) => ({
      routeId: str(it.routeid),
      routeNo: str(it.routeno),
      cityCode: stop.cityCode,
      // "일반버스" · "직행좌석버스" 처럼 말로 온다. 화면 색이 여기서 갈린다
      routeType: str(it.routetp),
    }))
    .filter((r) => r.routeId);

  setCached(key, routes);
  return routes;
}

type RouteStops = { stops: TagoStop[]; ord: number[]; updown: string[] };

/** 노선이 지나는 정류소 순서 */
async function stopsOfRoute(cityCode: string, routeId: string): Promise<RouteStops | null> {
  const key = `seq:${cityCode}:${routeId}`;
  const hit = getCached<RouteStops>(key, ROUTE_TTL);
  if (hit) return hit;

  const saved = await readJson<RouteStops>("tago", key, ROUTE_TTL);
  if (saved) {
    setCached(key, saved);
    return saved;
  }

  const json = await call(BASE_ROUTE, "getRouteAcctoThrghSttnList", {
    cityCode,
    routeId,
    numOfRows: MAX_ROWS,
    pageNo: 1,
  });

  const rows = itemsOf(json)
    .map((it) => ({
      ord: num(it.nodeord),
      updown: str(it.updowncd),
      stop: {
        id: `tago${str(it.nodeid)}`,
        nodeId: str(it.nodeid),
        cityCode,
        name: str(it.nodenm) || "이름 없는 정류장",
        p: [num(it.gpslong), num(it.gpslati)] as LngLat,
        mode: "bus" as const,
      },
    }))
    .filter((r) => Number.isFinite(r.stop.p[0]) && Number.isFinite(r.stop.p[1]))
    .sort((a, b) => a.ord - b.ord);

  if (rows.length < 2) return null;
  const value: RouteStops = {
    stops: rows.map((r) => r.stop),
    ord: rows.map((r) => r.ord),
    updown: rows.map((r) => r.updown),
  };
  setCached(key, value);
  void writeJson("tago", key, value);
  return value;
}

export type TagoResult = { stops: TransitStop[]; patterns: TransitPattern[] };

/**
 * 출발·도착 주변에서 탈 수 있는 버스 노선을 정류장 순서까지 갖춰 돌려준다.
 * 양쪽 모두에 걸치는 노선을 먼저 가져오고, 남는 자리에 한쪽만 걸치는 노선(환승용)을 채운다.
 */
export async function fetchTagoBuses(
  origin: LngLat,
  destination: LngLat,
  radius: number
): Promise<TagoResult> {
  const [nearA, nearB] = await Promise.all([
    nearbyStops(origin, radius),
    nearbyStops(destination, radius),
  ]);
  if (!nearA.length || !nearB.length) return { stops: [], patterns: [] };

  const pick = (list: TagoStop[]) =>
    [...list].sort((x, y) => distMeters(origin, x.p) - distMeters(origin, y.p)).slice(0, 12);

  const [routesA, routesB] = await Promise.all([
    pooled(pick(nearA), routesOfStop),
    pooled(pick(nearB), routesOfStop),
  ]);

  const flat = (groups: TagoRoute[][]) => {
    const m = new Map<string, TagoRoute>();
    for (const g of groups) for (const r of g) m.set(`${r.cityCode}:${r.routeId}`, r);
    return m;
  };
  const mapA = flat(routesA);
  const mapB = flat(routesB);

  // 양쪽에 다 서는 노선이 곧 직행 후보다. 그걸 먼저 채운다
  const both = [...mapA.keys()].filter((k) => mapB.has(k));
  const rest = [...new Set([...mapA.keys(), ...mapB.keys()])].filter((k) => !both.includes(k));
  const wanted = [...both, ...rest].slice(0, MAX_ROUTES).map((k) => mapA.get(k) ?? mapB.get(k)!);

  const stops = new Map<string, TransitStop>();
  const patterns: TransitPattern[] = [];

  const sequences = await pooled(wanted, async (r) => ({
    route: r,
    seq: await stopsOfRoute(r.cityCode, r.routeId),
  }));

  for (const { route, seq } of sequences) {
    if (!seq) continue;
    // 상·하행이 한 응답에 같이 오면 방향별로 쪼갠다 (섞으면 "몇 번째 정류장" 이 무너진다)
    const dirs = new Set(seq.updown.filter(Boolean));
    const groups =
      dirs.size > 1
        ? [...dirs].map((d) => seq.stops.filter((_, i) => seq.updown[i] === d))
        : [seq.stops];

    groups.forEach((group, gi) => {
      if (group.length < 2) return;
      const ids: string[] = [];
      for (const s of group) {
        if (!stops.has(s.id))
          stops.set(s.id, {
            id: s.id,
            name: s.name,
            p: s.p,
            mode: "bus",
            live: { src: "tago", cityCode: s.cityCode, nodeId: s.nodeId },
          });
        if (ids[ids.length - 1] !== s.id) ids.push(s.id);
      }
      if (ids.length < 2) return;
      patterns.push({
        id: `tago${route.cityCode}_${route.routeId}_${gi}`,
        ref: route.routeNo,
        name: `${route.routeNo}번 버스`,
        mode: "bus",
        colour: tagoBusColor(route.routeType),
        headsign: stops.get(ids[ids.length - 1])?.name,
        stops: ids,
        live: { src: "tago", routeId: route.routeId },
      });
    });
  }

  return { stops: [...stops.values()], patterns };
}

/**
 * 정류소 하나에 오는 **모든 노선**의 도착 예정.
 * 서울 TOPIS 와 달리 배차간격은 주지 않고, 차 한 대가 한 줄로 온다.
 */
export async function fetchTagoArrivals(
  stopId: string,
  cityCode: string,
  nodeId: string
): Promise<{ arrivals: Arrival[]; headways: Headway[] }> {
  const json = await call(BASE_ARRIVAL, "getSttnAcctoArvlPrearngeInfoList", {
    cityCode,
    nodeId,
    numOfRows: 60,
    pageNo: 1,
  });

  const arrivals: Arrival[] = [];
  for (const it of itemsOf(json)) {
    const routeId = str(it.routeid);
    const sec = num(it.arrtime);
    if (!routeId || !Number.isFinite(sec) || sec <= 0 || sec > ARRIVAL_HORIZON_S) continue;
    const away = num(it.arrprevstationcnt);
    arrivals.push({
      stopId,
      routeId,
      sec,
      stopsAway: Number.isFinite(away) ? away : undefined,
      lowFloor: str(it.vehicletp).includes("저상"),
    });
  }
  return { arrivals, headways: [] };
}
