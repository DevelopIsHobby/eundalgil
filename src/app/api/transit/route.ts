import { NextRequest, NextResponse } from "next/server";
import {
  bboxContains,
  bboxOfPoints,
  distToSegment,
  EARTH_M_PER_DEG_LAT,
  mPerDegLon,
  padBBox,
  toOverpassBBox,
  type BBox,
  type LngLat,
} from "@/lib/geo";
import { chainPaths, shapePartly } from "@/lib/shape";
import {
  ACCESS_RADIUS_M,
  type TransitData,
  type TransitMode,
  type TransitPattern,
  type TransitStop,
} from "@/lib/transit";
import { overpass, type OverpassElement } from "@/lib/overpass";
import { fetchTagoBuses, hasTagoKey } from "@/lib/tago";
import { fetchSeoulBuses, seoulKey } from "@/lib/seoulbus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 30;
const cache = new Map<string, { at: number; data: TransitData }>();
/**
 * 지금 받아 오는 중인 요청. React strict mode 로 같은 조회가 두 번 들어와도
 * Overpass·TOPIS 를 두 번 부르지 않는다.
 */
const inflight = new Map<string, Promise<TransitData>>();

/** 정류장을 찾는 반경 상한(m) — 이보다 넓히면 Overpass 응답이 급격히 커진다 */
const MAX_RADIUS_M = 1200;

function bboxAround(p: LngLat, meters: number) {
  const dLat = meters / EARTH_M_PER_DEG_LAT;
  const dLng = meters / mPerDegLon(p[1]);
  // south,west,north,east
  return `${(p[1] - dLat).toFixed(6)},${(p[0] - dLng).toFixed(6)},${(p[1] + dLat).toFixed(6)},${(p[0] + dLng).toFixed(6)}`;
}

/**
 * 정류장으로 볼 수 있는 노드.
 * 버스는 highway=bus_stop, 지하철은 노선 관계가 승강장(platform)보다
 * 정차 지점(stop_position)을 멤버로 두는 경우가 많아 둘 다 넣는다.
 */
const STOP_SELECTORS = [
  'node["highway"="bus_stop"]',
  'node["public_transport"="platform"]',
  'node["public_transport"="stop_position"]',
  'node["railway"~"^(station|halt|tram_stop)$"]',
];

/** 출발·도착을 모두 감싸는 범위 — 타고 가는 구간의 선로·노선 길을 이 안에서만 받는다 */
function corridorBox(a: LngLat, b: LngLat, meters: number) {
  return padBBox(bboxOfPoints([a, b]), meters);
}

/**
 * 출발지·목적지 주변의 정류장을 먼저 찾고, 그 정류장을 지나는 노선 관계만 받아 온다.
 * 노선에 속한 나머지 정류장 좌표는 `node(r)` 재귀로 한 번에 따라온다.
 *
 * 마지막으로 그 노선의 **선로**를 출발·도착 사이 범위에서만 좌표까지 받는다.
 * 지하철이 지하로 가는지 지상으로 가는지는 선로의 tunnel 태그에만 적혀 있고
 * (역 노드에는 없다), 노선 전체를 받으면 응답이 지나치게 커진다.
 */
function buildQuery(a: LngLat, b: LngLat, radius: number) {
  const boxA = bboxAround(a, radius);
  const boxB = bboxAround(b, radius);
  const near = [...STOP_SELECTORS.map((s) => `${s}(${boxA});`), ...STOP_SELECTORS.map((s) => `${s}(${boxB});`)].join(
    "\n  "
  );
  return `[out:json][timeout:60];
(
  ${near}
)->.s;
.s out body qt;
rel(bn.s)["type"="route"]["route"~"^(bus|subway|light_rail|tram|train|monorail|trolleybus)$"]->.r;
.r out body qt;
node(r.r)->.rn;
.rn out body qt;
way(r.r)(${toOverpassBBox(corridorBox(a, b, radius))});
out geom;`;
}

/** 노선이 지나는 선로 한 토막 */
type TrackWay = { tunnel: boolean; geometry: LngLat[] };

/**
 * 노선의 선로 조각을 이어 붙이고, 그 위에 역·정류장을 얹는다.
 * 조각이 여럿으로 끊겨 오면(범위 밖이라 빠진 구간이 있으면) 긴 것부터 시도한다.
 */
function shapeOnTracks(tracks: TrackWay[], points: LngLat[], box: BBox) {
  if (!tracks.length || points.length < 2) return null;
  // 받아 온 범위 안에 있는 자리만 얹을 수 있다
  const wanted = points.map((p) => (bboxContains(box, p) ? p : null));
  const chains = chainPaths(tracks.map((w) => w.geometry)).sort((x, y) => y.length - x.length);
  for (const chain of chains) {
    const got = shapePartly(chain, wanted);
    if (got) return got;
  }
  return null;
}

/** 이보다 멀면 그 자리의 선로가 응답에 없는 것으로 본다 */
const TRACK_MATCH_M = 150;
/** 정류장 사이 한 구간을 판단할 때 찍어 보는 지점 수 */
const HOP_SAMPLES = 5;

/**
 * 정류장 사이 한 구간이 지상으로 달리는 비율(0~1).
 * 선로를 못 찾으면 null — "지하가 아니다" 가 아니라 "모른다" 이다.
 */
function hopSurfaceRatio(from: LngLat, to: LngLat, tracks: TrackWay[]): number | null {
  let surface = 0;
  let tunnel = 0;
  for (let s = 0; s < HOP_SAMPLES; s++) {
    const t = (s + 0.5) / HOP_SAMPLES;
    const p: LngLat = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    let bestD = TRACK_MATCH_M;
    let best: TrackWay | null = null;
    for (const w of tracks) {
      for (let i = 1; i < w.geometry.length; i++) {
        const d = distToSegment(p, w.geometry[i - 1], w.geometry[i]);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
    }
    if (!best) continue;
    if (best.tunnel) tunnel++;
    else surface++;
  }
  const seen = surface + tunnel;
  return seen ? surface / seen : null;
}

function modeOf(route: string | undefined): TransitMode | null {
  switch (route) {
    case "bus":
    case "trolleybus":
      return "bus";
    case "subway":
    case "light_rail":
    case "monorail":
      return "subway";
    case "tram":
      return "tram";
    case "train":
      return "train";
    default:
      return null;
  }
}

/**
 * 정류장으로 볼 수 있는 멤버 역할.
 *
 * 공개 교통 태깅 v2(PTv2)는 노선 하나가 한 방향만 담고, 그 방향의 정류장을
 * `stop` / `platform` 역할로 **지나는 순서대로** 적는다. 우리는 이 순서에 기대므로
 * 역할이 비어 있거나 `forward` / `backward` 인 옛 방식(양방향 한 관계)은 받지 않는다.
 * 그런 관계에서는 두 방향 정류장이 섞여 있어 "몇 번째 정류장" 자체가 성립하지 않는다.
 */
function isStopRole(role: string) {
  return role.startsWith("stop") || role.startsWith("platform");
}

/** 대략적인 두 점 사이 거리(m) — 정류장 순서 검증에만 쓰는 값이라 평면 근사로 충분하다 */
function roughMeters(a: LngLat, b: LngLat) {
  return Math.hypot((b[0] - a[0]) * mPerDegLon((a[1] + b[1]) / 2), (b[1] - a[1]) * EARTH_M_PER_DEG_LAT);
}

/**
 * 정류장이 정말 "지나는 순서" 인지 본다.
 * 순서가 뒤섞인 관계는 연속한 두 정류장이 몇 km 씩 튀므로, 그런 노선은 통째로 버린다.
 * 잘못된 순서를 그대로 쓰면 "타서 반대편으로 가는" 엉터리 안내가 나온다.
 */
function looksOrdered(points: LngLat[]) {
  if (points.length < 3) return true;
  let far = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = roughMeters(points[i - 1], points[i]);
    if (gap > 20000) return false; // 한 구간이 20km 넘게 튀면 볼 것도 없다
    if (gap > 3000) far++;
  }
  return far / (points.length - 1) <= 0.12;
}

export async function GET(req: NextRequest) {
  const parse = (raw: string | null): LngLat | null => {
    if (!raw) return null;
    const [lng, lat] = raw.split(",").map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  };

  const a = parse(req.nextUrl.searchParams.get("a"));
  const b = parse(req.nextUrl.searchParams.get("b"));
  if (!a || !b) return new NextResponse("a, b 좌표가 필요합니다", { status: 400 });

  const radius = Math.min(MAX_RADIUS_M, Number(req.nextUrl.searchParams.get("r")) || 800);
  const corridor = corridorBox(a, b, radius);

  const key = [...a, ...b].map((v) => v.toFixed(3)).join(",") + `@${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);

  const shared = inflight.get(key);
  if (shared) {
    try {
      return NextResponse.json(await shared);
    } catch (err) {
      return new NextResponse((err as Error).message, { status: 503 });
    }
  }

  const run = build(a, b, radius, corridor, key).finally(() => inflight.delete(key));
  inflight.set(key, run);
  try {
    return NextResponse.json(await run);
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 503 });
  }
}

async function build(
  a: LngLat,
  b: LngLat,
  radius: number,
  corridor: BBox,
  key: string
): Promise<TransitData> {

  /*
   * 지하철은 OSM, 버스는 TAGO·TOPIS 에서 온다.
   * Overpass 가 죽어도 버스 안내는 나가야 하므로 여기서 끝내지 않는다.
   */
  let elements: OverpassElement[] = [];
  let osmError: string | null = null;
  try {
    elements = await overpass(buildQuery(a, b, radius));
  } catch (err) {
    osmError = (err as Error).message;
    console.warn("[transit] overpass:", osmError);
  }

  const nodes = new Map<number, OverpassElement>();
  const relations: OverpassElement[] = [];
  const tracks = new Map<number, TrackWay>();
  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) nodes.set(el.id, el);
    else if (el.type === "relation") relations.push(el);
    else if (el.type === "way" && el.geometry?.length) {
      const t = el.tags ?? {};
      // covered 는 지붕만 덮은 경우지만 햇빛이 안 드는 건 터널과 같다
      const tunnel = (!!t.tunnel && t.tunnel !== "no") || (!!t.covered && t.covered !== "no");
      tracks.set(el.id, {
        tunnel,
        geometry: el.geometry.map((g) => [g.lon, g.lat] as LngLat),
      });
    }
  }

  /**
   * 지하철 정차 지점(stop_position)에는 이름이 없는 경우가 흔하다.
   * 같은 자리의 역·승강장 노드에서 이름을 빌려 온다.
   */
  const named: { p: LngLat; name: string }[] = [];
  for (const el of nodes.values()) {
    const t = el.tags ?? {};
    const name = t.name ?? t["name:ko"];
    if (!name) continue;
    if (t.railway === "station" || t.public_transport === "station" || t.public_transport === "platform" || t.highway === "bus_stop") {
      named.push({ p: [el.lon!, el.lat!], name });
    }
  }
  const borrowName = (p: LngLat) => {
    let best = "";
    let bestD = 200;
    for (const n of named) {
      // 200m 안에서만 빌린다 — 더 멀면 다른 역이다
      const d = Math.hypot((n.p[0] - p[0]) * 88000, (n.p[1] - p[1]) * 110574);
      if (d < bestD) {
        bestD = d;
        best = n.name;
      }
    }
    return best;
  };

  const stops = new Map<string, TransitStop>();
  const patterns: TransitPattern[] = [];

  for (const rel of relations) {
    const tags = rel.tags ?? {};
    const mode = modeOf(tags.route);
    if (!mode || !rel.members) continue;

    const ordered: string[] = [];
    for (const m of rel.members) {
      if (m.type !== "node" || !isStopRole(m.role)) continue;
      const node = nodes.get(m.ref);
      if (!node) continue;
      const id = `n${m.ref}`;
      if (!stops.has(id)) {
        const nt = node.tags ?? {};
        const p: LngLat = [node.lon!, node.lat!];
        const name = nt.name ?? nt["name:ko"] ?? borrowName(p);
        stops.set(id, { id, name: name || "이름 없는 정류장", p, mode });
      }
      // 같은 정류장이 연달아 두 번 들어간 데이터는 접는다
      if (ordered[ordered.length - 1] !== id) ordered.push(id);
    }
    if (ordered.length < 2) continue;
    if (!looksOrdered(ordered.map((id) => stops.get(id)!.p))) continue;

    /*
     * 정류장 사이 구간마다 지상으로 달리는 비율.
     * 선로를 받아 온 범위(출발~도착) 밖의 구간은 null 이 되는데, 어차피 타지 않는 구간이다.
     */
    const routeTracks = rel.members
      .filter((m) => m.type === "way")
      .map((m) => tracks.get(m.ref))
      .filter((w): w is TrackWay => !!w);
    const aboveGround = routeTracks.length
      ? ordered
          .slice(1)
          .map((id, i) => hopSurfaceRatio(stops.get(ordered[i])!.p, stops.get(id)!.p, routeTracks))
      : undefined;

    /*
     * 역·정류장을 선로 위에 얹는다. 좌표만 직선으로 이으면 지도에서 건물을 뚫고 가고
     * 거리도 실제보다 짧게 나온다.
     * 선로는 출발~도착 범위에서만 받아 오므로, 그 밖의 역은 얹을 수 없다(-1).
     */
    const shaped = shapeOnTracks(
      routeTracks,
      ordered.map((id) => stops.get(id)!.p),
      corridor
    );

    patterns.push({
      id: `r${rel.id}`,
      ref: tags.ref ?? tags["ref:ko"] ?? "",
      name: tags.name ?? tags.ref ?? "이름 없는 노선",
      mode,
      colour: tags.colour ?? tags.color,
      headsign: tags.to,
      stops: ordered,
      aboveGround,
      shape: shaped?.shape,
      stopIndex: shaped?.stopIndex,
    });
  }

  /*
   * 버스는 TAGO(국토교통부) 가 정답에 가깝다. OSM 에는 국내 시내·마을버스가 거의 없고,
   * 있어도 정류장 순서가 옛 방식이라 못 쓰는 경우가 많다.
   * TAGO 가 버스를 주면 OSM 버스는 통째로 버리고, 지하철만 OSM 것을 쓴다.
   */
  let busStops: TransitStop[] = [];
  let busPatterns: TransitPattern[] = [];

  /*
   * 서울은 TOPIS, 그 밖은 TAGO 다.
   * TAGO 에는 서울 시내버스가 거의 없어서(강남·사당 근처 몇 개뿐) 서울에서는 쓸 수 없고,
   * TOPIS 는 서울 전용이다. 둘 다 시도해 나오는 쪽을 쓴다.
   */
  // 반경은 지하철에 맞춰 넓게 들어온다. 버스는 그만큼 멀리 걸어가지 않으므로 좁혀 쓴다
  // (넓히면 노선 수만 늘어 응답이 느려진다)
  const busRadius = Math.min(radius, ACCESS_RADIUS_M.bus);
  const sources: [string, () => Promise<{ stops: TransitStop[]; patterns: TransitPattern[] }>][] = [];
  if (seoulKey()) sources.push(["seoul", () => fetchSeoulBuses(a, b, busRadius)]);
  if (hasTagoKey()) sources.push(["tago", () => fetchTagoBuses(a, b, busRadius)]);

  let busNotice: string | undefined;
  for (const [name, run] of sources) {
    try {
      const got = await run();
      if (got.patterns.length) {
        busStops = got.stops;
        busPatterns = got.patterns;
        busNotice = undefined;
        break;
      }
    } catch (err) {
      // 버스를 못 받아도 지하철 안내는 그대로 나가야 한다. 이유는 화면에 전한다
      const msg = (err as Error).message;
      console.warn(`[transit] ${name}:`, msg);
      busNotice ??= msg;
    }
  }
  if (!sources.length) busNotice = "버스 정보 키가 없어 지하철만 안내합니다. (.env.local 의 TAGO_KEY)";

  const osmPatterns = busPatterns.length ? patterns.filter((p) => p.mode !== "bus") : patterns;

  // 실제로 쓰이는 정류장만 남긴다
  const used = new Set(osmPatterns.flatMap((p) => p.stops));
  const data: TransitData = {
    stops: [...[...stops.values()].filter((s) => used.has(s.id)), ...busStops],
    patterns: [...osmPatterns, ...busPatterns],
    notice: busPatterns.length ? undefined : busNotice,
    fetchedAt: Date.now(),
  };

  // 지하철도 버스도 못 받았으면 그건 실패다
  if (osmError && !busPatterns.length) throw new Error(osmError);

  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return data;
}
