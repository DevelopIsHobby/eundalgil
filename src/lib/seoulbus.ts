/**
 * 서울특별시 버스 정보 (서울 TOPIS, 서버 전용).
 *
 * TAGO 에는 서울 시내버스가 거의 들어 있지 않다 (강남·사당 근처 몇 개뿐).
 * 서울은 TOPIS 계열 API 를 따로 써야 한다. 인증키는 공공데이터포털 것을 그대로 쓰되,
 * **"서울특별시_정류소정보조회 서비스" 와 "서울특별시_노선정보조회 서비스" 를 활용신청**해야
 * 열린다. 신청 전에는 401 이 온다.
 *
 *   1) stationinfo/getStationByPos   — 좌표 반경 정류소
 *   2) stationinfo/getRouteByStation — 그 정류소를 지나는 노선
 *   3) busRouteInfo/getStaionByRoute — 노선이 지나는 정류소 순서
 */

import { distMeters, type LngLat } from "./geo";
import {
  ARRIVAL_HORIZON_S,
  type Arrival,
  type Headway,
  type TransitPattern,
  type TransitStop,
} from "./transit";

const BASE = "http://ws.bus.go.kr/api/rest";
const TIMEOUT_MS = 7000;
const ROUTE_TTL = 12 * 60 * 60 * 1000;
const STOP_TTL = 60 * 60 * 1000;
const CONCURRENCY = 6;
const MAX_ROUTES = 48;
const MAX_STOPS_PER_END = 12;

export function seoulKey() {
  // `??` 로 이으면 SEOUL_BUS_KEY 가 **빈 문자열**일 때 TAGO 키로 넘어가지 않는다.
  // .env 에 이름만 적어 둔 경우가 그래서, 값이 비었으면 없는 것으로 친다.
  const own = (process.env.SEOUL_BUS_KEY ?? "").trim();
  return own || (process.env.TAGO_KEY ?? "").trim();
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

const num = (v: unknown) => Number(String(v ?? ""));
const str = (v: unknown) => String(v ?? "").trim();

/** TOPIS 응답: msgBody.itemList 가 배열이거나 객체 하나거나 없다 */
function itemsOf(json: unknown): Record<string, unknown>[] {
  const root = json as {
    msgHeader?: { headerCd?: string; headerMsg?: string };
    msgBody?: { itemList?: unknown };
  };
  const code = str(root?.msgHeader?.headerCd);
  // 0 / 4 (결과 없음) 외에는 오류다
  if (code && code !== "0" && code !== "4") {
    throw new Error(`서울버스 ${code}: ${str(root?.msgHeader?.headerMsg) || "알 수 없는 오류"}`);
  }
  const list = root?.msgBody?.itemList;
  if (!list) return [];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [list as Record<string, unknown>];
}

async function call(path: string, params: Record<string, string | number>) {
  const key = seoulKey();
  if (!key) throw new Error("서울버스 키 없음");

  const qs = Object.entries({ resultType: "json", ...params })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  // 인증키는 이미 URL 인코딩된 값이라 다시 인코딩하지 않는다
  const url = `${BASE}/${path}?serviceKey=${key}&${qs}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 401)
    throw new Error("서울특별시 버스 서비스 활용신청이 필요합니다 (data.go.kr)");
  if (!res.ok) throw new Error(`서울버스 ${path} ${res.status}`);

  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`서울버스 ${path}: XML 오류 응답`);
  return JSON.parse(text);
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
      } catch {
        /* 한 건이 실패해도 나머지는 쓴다 */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

type SeoulStop = TransitStop & { arsId: string };

async function nearbyStops(p: LngLat, radius: number): Promise<SeoulStop[]> {
  const key = `near:${p[0].toFixed(3)},${p[1].toFixed(3)}:${radius}`;
  const hit = getCached<SeoulStop[]>(key, STOP_TTL);
  if (hit) return hit;

  const json = await call("stationinfo/getStationByPos", {
    tmX: p[0].toFixed(6),
    tmY: p[1].toFixed(6),
    radius: Math.round(radius),
  });

  const stops = itemsOf(json)
    .map((it): SeoulStop | null => {
      const lng = num(it.gpsX);
      const lat = num(it.gpsY);
      const arsId = str(it.arsId);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || !arsId) return null;
      return {
        id: `sb${arsId}`,
        arsId,
        name: str(it.stationNm) || "이름 없는 정류장",
        p: [lng, lat],
        mode: "bus",
        live: { src: "seoul", arsId },
      };
    })
    .filter((s): s is SeoulStop => !!s);

  setCached(key, stops);
  return stops;
}

async function routesOfStop(stop: SeoulStop): Promise<{ routeId: string; routeNo: string }[]> {
  const key = `routes:${stop.arsId}`;
  const hit = getCached<{ routeId: string; routeNo: string }[]>(key, STOP_TTL);
  if (hit) return hit;

  const json = await call("stationinfo/getRouteByStation", { arsId: stop.arsId });
  const routes = itemsOf(json)
    .map((it) => ({ routeId: str(it.busRouteId), routeNo: str(it.busRouteAbrv || it.busRouteNm) }))
    .filter((r) => r.routeId);

  setCached(key, routes);
  return routes;
}

type RouteSeq = { stops: TransitStop[]; direction: string[] };

async function stopsOfRoute(routeId: string): Promise<RouteSeq | null> {
  const key = `seq:${routeId}`;
  const hit = getCached<RouteSeq>(key, ROUTE_TTL);
  if (hit) return hit;

  const json = await call("busRouteInfo/getStaionByRoute", { busRouteId: routeId });
  const rows = itemsOf(json)
    .map((it) => {
      // 노선 조회는 정류소 고유번호를 arsId 로 준다. 실시간 도착을 물어볼 때 이 번호가 필요하다
      const arsId = str(it.arsId) || str(it.station);
      return {
        seq: num(it.seq),
        direction: str(it.direction),
        stop: {
          id: `sb${arsId}`,
          name: str(it.stationNm) || "이름 없는 정류장",
          p: [num(it.gpsX), num(it.gpsY)] as LngLat,
          mode: "bus" as const,
          live: { src: "seoul" as const, arsId },
        },
      };
    })
    .filter((r) => Number.isFinite(r.stop.p[0]) && Number.isFinite(r.stop.p[1]))
    .sort((a, b) => a.seq - b.seq);

  if (rows.length < 2) return null;
  const value: RouteSeq = { stops: rows.map((r) => r.stop), direction: rows.map((r) => r.direction) };
  setCached(key, value);
  return value;
}

export type SeoulResult = { stops: TransitStop[]; patterns: TransitPattern[] };

/** 출발·도착 주변에서 탈 수 있는 서울 시내·마을버스 노선 */
export async function fetchSeoulBuses(
  origin: LngLat,
  destination: LngLat,
  radius: number
): Promise<SeoulResult> {
  const [nearA, nearB] = await Promise.all([
    nearbyStops(origin, radius),
    nearbyStops(destination, radius),
  ]);
  if (!nearA.length || !nearB.length) return { stops: [], patterns: [] };

  const closest = (list: SeoulStop[], p: LngLat) =>
    [...list].sort((x, y) => distMeters(p, x.p) - distMeters(p, y.p)).slice(0, MAX_STOPS_PER_END);

  const [routesA, routesB] = await Promise.all([
    pooled(closest(nearA, origin), routesOfStop),
    pooled(closest(nearB, destination), routesOfStop),
  ]);

  const toMap = (groups: { routeId: string; routeNo: string }[][]) => {
    const m = new Map<string, string>();
    for (const g of groups) for (const r of g) m.set(r.routeId, r.routeNo);
    return m;
  };
  const mapA = toMap(routesA);
  const mapB = toMap(routesB);

  // 양쪽에 다 서는 노선(직행 후보)을 먼저, 남는 자리에 환승용 노선을 채운다
  const both = [...mapA.keys()].filter((k) => mapB.has(k));
  const rest = [...new Set([...mapA.keys(), ...mapB.keys()])].filter((k) => !both.includes(k));
  const wanted = [...both, ...rest].slice(0, MAX_ROUTES);

  const stops = new Map<string, TransitStop>();
  const patterns: TransitPattern[] = [];

  const sequences = await pooled(wanted, async (routeId) => ({
    routeId,
    routeNo: mapA.get(routeId) ?? mapB.get(routeId) ?? "",
    seq: await stopsOfRoute(routeId),
  }));

  for (const { routeId, routeNo, seq } of sequences) {
    if (!seq) continue;
    // 상·하행이 한 응답에 같이 오면 방향별로 쪼갠다
    const dirs = new Set(seq.direction.filter(Boolean));
    const groups =
      dirs.size > 1
        ? [...dirs].map((d) => seq.stops.filter((_, i) => seq.direction[i] === d))
        : [seq.stops];

    groups.forEach((group, gi) => {
      if (group.length < 2) return;
      const ids: string[] = [];
      for (const s of group) {
        if (!stops.has(s.id)) stops.set(s.id, s);
        if (ids[ids.length - 1] !== s.id) ids.push(s.id);
      }
      if (ids.length < 2) return;
      patterns.push({
        id: `sb${routeId}_${gi}`,
        ref: routeNo,
        name: `${routeNo}번 버스`,
        mode: "bus",
        headsign: stops.get(ids[ids.length - 1])?.name,
        stops: ids,
        live: { src: "seoul", routeId },
      });
    });
  }

  return { stops: [...stops.values()], patterns };
}

export type LiveArrivals = { arrivals: Arrival[]; headways: Headway[] };

/**
 * 정류소 하나에 오는 **모든 노선**의 도착 예정을 한 번에 준다.
 * (노선별로 따로 부르면 호출 수가 노선 수만큼 늘어난다)
 *
 * 응답은 노선 한 줄에 다음 차 두 대를 담아 준다 — traTime1/2 가 남은 초,
 * arrmsg1/2 가 "2분후[2번째 전]" 같은 사람이 읽는 말이다.
 */
export async function fetchSeoulArrivals(stopId: string, arsId: string): Promise<LiveArrivals> {
  const json = await call("stationinfo/getStationByUid", { arsId });
  const arrivals: Arrival[] = [];
  const headways: Headway[] = [];

  for (const it of itemsOf(json)) {
    const routeId = str(it.busRouteId);
    if (!routeId) continue;

    // term 은 배차간격(분). 오는 차가 안 잡힐 때 평균 대기를 이 값으로 대신한다
    const term = num(it.term);
    if (Number.isFinite(term) && term > 0) headways.push({ stopId, routeId, minutes: term });

    // 이 정류소가 노선의 몇 번째인지 — 차가 있는 구간 번호와 빼면 "몇 정거장 전" 이다
    const staOrd = num(it.staOrd);

    for (const i of [1, 2] as const) {
      const raw = num(it[`traTime${i}`]);
      const message = str(it[`arrmsg${i}`]);
      if (!Number.isFinite(raw) || raw <= 0 || raw > ARRIVAL_HORIZON_S) continue;
      // 탈 수 없는 상태는 버린다
      if (/운행종료|출발대기/.test(message)) continue;
      /*
       * "곧 도착" 인데 traTime 은 3분쯤으로 오는 경우가 있다 (주행 예측이 늦게 따라온다).
       * 그 값을 그대로 믿으면 이미 떠난 차를 잡아 탄다고 계산하게 되므로 문구를 우선한다.
       */
      const sec = /곧 도착/.test(message) ? Math.min(raw, 30) : raw;
      const sectOrd = num(it[`sectOrd${i}`]);
      arrivals.push({
        stopId,
        routeId,
        sec,
        stopsAway:
          Number.isFinite(staOrd) && Number.isFinite(sectOrd)
            ? Math.max(0, staOrd - sectOrd)
            : undefined,
        message: message || undefined,
        full: str(it[`isFullFlag${i}`]) === "1",
        last: str(it[`isLast${i}`]) === "1",
        lowFloor: str(it[`busType${i}`]) === "1",
      });
    }
  }

  return { arrivals, headways };
}
