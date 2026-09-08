import { NextRequest, NextResponse } from "next/server";
import { EARTH_M_PER_DEG_LAT, mPerDegLon, type LngLat } from "@/lib/geo";
import type { TransitData, TransitMode, TransitPattern, TransitStop } from "@/lib/transit";
import { overpass, type OverpassElement } from "@/lib/overpass";
import { fetchTagoBuses, hasTagoKey } from "@/lib/tago";
import { fetchSeoulBuses, seoulKey } from "@/lib/seoulbus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 30;
const cache = new Map<string, { at: number; data: TransitData }>();

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

/**
 * 출발지·목적지 주변의 정류장을 먼저 찾고, 그 정류장을 지나는 노선 관계만 받아 온다.
 * 노선에 속한 나머지 정류장 좌표는 `node(r)` 재귀로 한 번에 따라온다.
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
.rn out body qt;`;
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

  const key = [...a, ...b].map((v) => v.toFixed(3)).join(",") + `@${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);

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
  for (const el of elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) nodes.set(el.id, el);
    else if (el.type === "relation") relations.push(el);
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

    patterns.push({
      id: `r${rel.id}`,
      ref: tags.ref ?? tags["ref:ko"] ?? "",
      name: tags.name ?? tags.ref ?? "이름 없는 노선",
      mode,
      colour: tags.colour ?? tags.color,
      headsign: tags.to,
      stops: ordered,
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
  const sources: [string, () => Promise<{ stops: TransitStop[]; patterns: TransitPattern[] }>][] = [];
  if (seoulKey()) sources.push(["seoul", () => fetchSeoulBuses(a, b, radius)]);
  if (hasTagoKey()) sources.push(["tago", () => fetchTagoBuses(a, b, radius)]);

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
  if (osmError && !busPatterns.length) return new NextResponse(osmError, { status: 503 });

  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((x, y) => x[1].at - y[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return NextResponse.json(data);
}
