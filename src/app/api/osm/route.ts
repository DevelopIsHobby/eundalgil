import { NextRequest, NextResponse } from "next/server";
import { estimateHeight } from "@/lib/shadow";
import {
  bboxContains,
  bboxIntersects,
  bboxOfPoints,
  pointInRing,
  resample,
  type BBox,
  type LngLat,
} from "@/lib/geo";
import type { Entrance, OsmBundle, RawBuilding, RawTree, SafetyPoint, WalkWay } from "@/lib/osm";
import { overpass, type OverpassElement } from "@/lib/overpass";
import { readCachedBundle, writeCachedBundle } from "@/lib/osmCache";
import { fetchVWorldBuildings, hasVWorldBuildings } from "@/lib/vworldBuildings";
import { loadElevation, smoothProfile } from "@/lib/elevation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** bbox 한 변의 최대 길이(도). 약 3km 정도로 제한해 Overpass 과부하를 막는다. */
const MAX_SPAN_LAT = 0.028;
const MAX_SPAN_LNG = 0.035;

/**
 * 건물·길·가로수는 좀처럼 바뀌지 않는다. 반면 Overpass 는 느리고 자주 거절한다.
 * 그러니 오래 들고 있는 편이 낫다 — 같은 동네를 다시 찾을 때 즉시 답한다.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 32;
const cache = new Map<string, { at: number; data: OsmBundle }>();

/**
 * 요청 범위를 이 격자에 맞춰 넓힌다 (약 400m).
 * 출발지를 조금만 옮겨도 범위가 달라져 캐시가 통째로 빗나가던 것을 막는다.
 */
const SNAP_DEG = 0.004;
/** 한 번에 받을 범위 수 — 출발·도착·환승 두어 곳이면 충분하다 */
const MAX_BOXES = 6;

/**
 * 지금 받아 오는 중인 요청. 같은 범위를 동시에 물으면 하나로 합친다.
 *
 * React strict mode 는 이펙트를 두 번 돌린다. 클라이언트가 첫 요청을 곧바로 끊어도
 * 서버는 이미 시작한 Overpass 쿼리를 끝까지 돌리므로, 검색 한 번에 무거운 쿼리가
 * 두 번 나간다 — 그러다 미러에 거절당하면 그때부터 훨씬 느려진다.
 */
const inflight = new Map<string, Promise<(OsmBundle | null)[]>>();

const WALK_HIGHWAY =
  "^(footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway|road)$";

/**
 * 범위 하나짜리 쿼리.
 *
 * 여러 범위를 union 으로 묶어 한 번에 물어봤더니 미러가 50초 만에 504 로 끊었다.
 * Overpass 는 쿼리가 무거워지면 급격히 느려진다 — 나눠서 **동시에** 묻는 편이 낫다.
 */
function buildQuery(b: BBox, withBuildings: boolean) {
  const bb = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  return `[out:json][timeout:40];
(
  ${withBuildings ? `way["building"](${bb});` : ""}
  node["natural"="tree"](${bb});
  way["natural"="tree_row"](${bb});
  way["highway"~"${WALK_HIGHWAY}"]["area"!~"yes"](${bb});
  way["natural"~"^(wood|scrub)$"](${bb});
  way["landuse"~"^(forest)$"](${bb});
  node["railway"="subway_entrance"](${bb});
  node["highway"="street_lamp"](${bb});
  node["man_made"="surveillance"](${bb});
  node["emergency"="phone"](${bb});
);
out geom qt;`;
}

function wayKind(tags: Record<string, string>, inWood: boolean): WalkWay["kind"] {
  const h = tags.highway;
  if (h === "steps") return "steps";
  // 램프(연결로)는 차만 다니는 갈래길이라 따로 표시해 둔다
  if (h?.endsWith("_link")) return "ramp";
  if (tags.footway === "crossing" || tags.crossing) return "crossing";
  /*
   * 태그가 거의 없는 highway=path·track 은 대개 포장 안 된 산길이다.
   * 상도동 국사봉 자락의 숲(natural=wood) 을 가로지르는 147m 짜리 path 가 그랬는데,
   * 인도와 똑같이 취급하니 36m 를 올라갔다 내려오는 길을 최단 경로라고 안내했다.
   * 포장 표기가 있으면 보통 정비된 산책로이므로 인도로 본다.
   */
  if (h === "path" || h === "track") {
    const paved = PAVED.test(tags.surface ?? "");
    return inWood && !paved ? "trail" : "footway";
  }
  if (h === "footway" || h === "path" || h === "pedestrian" || h === "cycleway") return "footway";
  if (tags.leisure === "park") return "park";
  return "road";
}

/** 포장된 노면 — 이게 붙어 있으면 정비된 길로 본다 */
const PAVED = /^(paved|asphalt|concrete|paving_stones|sett|metal|wood)$/;

/** 차가 다니는 등급의 도로 */
const MOTOR_ROAD = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;

/** 왕복 차선이 많거나 간선도로인 길 — 조용한 길을 원하는 사람에게는 피할 대상이다 */
const MAJOR_HIGHWAY = new Set(["trunk", "primary", "secondary", "trunk_link", "primary_link", "secondary_link"]);

function isMajor(tags: Record<string, string>) {
  return MAJOR_HIGHWAY.has(tags.highway ?? "") || Number(tags.lanes ?? 0) >= 6;
}

/**
 * 차도 터널의 보도인지.
 *
 * 처음에는 차도 터널을 통째로 뺐다. 언덕을 뚫은 터널은 거리로만 보면 가장 곧은 길이라
 * 경로가 그리로 빨려 들어가기 때문이다. 그런데 상도터널처럼 **실제로 사람이 걸어 다니는**
 * 터널까지 막으니, 상도동 ↔ 흑석동이 통째로 끊겨 산을 넘는 2.2km 경로가 나왔다.
 * 그래서 빼는 대신 따로 표시해 두고, 비용에서 크게 눌러 마지막에 고르게 한다.
 * `foot=no` 로 걷기를 금지한 터널만 뺀다.
 */
function isRoadTunnel(tags: Record<string, string>) {
  const inTunnel = tags.tunnel && tags.tunnel !== "no";
  return !!inTunnel && MOTOR_ROAD.test(tags.highway ?? "");
}

function walkable(tags: Record<string, string>) {
  if (tags.foot === "no" || tags.access === "private" || tags.access === "no") return false;
  if (tags.indoor === "yes") return false;
  return true;
}

type Wood = { ring: LngLat[]; bbox: BBox };

/** 숲 폴리곤 — 태그 없는 산길을 가려내는 데 쓴다 */
function woodsOf(elements: OverpassElement[]): Wood[] {
  const out: Wood[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    if (!/^(wood|scrub)$/.test(t.natural ?? "") && t.landuse !== "forest") continue;
    const ring: LngLat[] = el.geometry.map((g) => [g.lon, g.lat]);
    out.push({ ring, bbox: bboxOfPoints(ring) });
  }
  return out;
}

/** 한 번에 받은 요소들 중 이 범위에 걸리는 것만 골라 번들 하나로 만든다 */
function bundleOf(elements: OverpassElement[], box: BBox, woods: Wood[]): OsmBundle {
  const buildings: RawBuilding[] = [];
  const trees: RawTree[] = [];
  const ways: WalkWay[] = [];
  const safety: SafetyPoint[] = [];
  const entrances: Entrance[] = [];

  const inWood = (p: LngLat) => woods.some((w) => bboxContains(w.bbox, p) && pointInRing(p, w.ring));

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
      const path: LngLat[] = el.geometry.map((g) => [g.lon, g.lat]);
      // 걸치기만 해도 넣는다 — 경계에서 잘린 건물·길은 그늘도 경로도 어긋나게 만든다
      if (!bboxIntersects(box, bboxOfPoints(path))) continue;
      if (tags.natural === "tree_row") {
        /*
         * 가로수를 한 그루씩 찍어 둔 곳은 드물고, 줄로 그어 둔 곳(tree_row)이 더 흔하다.
         * 선을 8m 간격으로 끊어 그 자리에 나무가 서 있는 것으로 친다 —
         * 가로수 간격이 대개 6~10m 다.
         */
        const h = parseFloat(tags.height ?? "") || 8;
        const crown = parseFloat(tags["diameter_crown"] ?? "") / 2 || 3;
        resample(path, 8).forEach((p, i) => {
          trees.push({ id: `r${el.id}_${i}`, p, height: h, crown: Math.max(1.5, crown) });
        });
      } else if (tags.building) {
        if (path.length >= 4) {
          buildings.push({
            id: `w${el.id}`,
            ring: path.slice(0, -1), // 마지막 중복점 제거
            height: estimateHeight(tags),
          });
        }
      } else if (tags.highway && walkable(tags)) {
        ways.push({
          id: `w${el.id}`,
          path,
          kind: isRoadTunnel(tags)
            ? "tunnel"
            : wayKind(tags, inWood(path[Math.floor(path.length / 2)])),
          incline: tags.incline,
          major: isMajor(tags),
          name: tags.name,
          // 터널 안은 해가 들지 않는다 (지붕·아케이드와 같은 취급)
          covered: tags.covered === "yes" || !!(tags.tunnel && tags.tunnel !== "no"),
        });
      }
    } else if (el.type === "node" && el.lat != null && el.lon != null) {
      const p: LngLat = [el.lon, el.lat];
      if (!bboxContains(box, p)) continue;
      if (tags.natural === "tree") {
        const h = parseFloat(tags.height ?? "") || 8;
        const crown = parseFloat(tags["diameter_crown"] ?? "") / 2 || 3;
        trees.push({ id: `n${el.id}`, p, height: h, crown: Math.max(1.5, crown) });
      } else if (tags.railway === "subway_entrance") {
        entrances.push({ id: `n${el.id}`, p, name: tags.name ?? tags.ref });
      } else if (tags.highway === "street_lamp") {
        safety.push({ id: `n${el.id}`, p, kind: "lamp" });
      } else if (tags.man_made === "surveillance") {
        safety.push({ id: `n${el.id}`, p, kind: "cctv" });
      } else if (tags.emergency === "phone") {
        safety.push({ id: `n${el.id}`, p, kind: "emergency" });
      }
    }
  }

  return {
    buildings,
    trees,
    ways,
    safety,
    entrances,
    bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat],
    fetchedAt: Date.now(),
  };
}

/** 요청 범위를 격자에 맞춰 넓힌다 — 조금씩 다른 범위가 같은 캐시를 쓰게 된다 */
function snap(b: BBox): BBox {
  const f = (v: number, dir: -1 | 1) =>
    (dir < 0 ? Math.floor(v / SNAP_DEG) : Math.ceil(v / SNAP_DEG)) * SNAP_DEG;
  return {
    minLng: f(b.minLng, -1),
    minLat: f(b.minLat, -1),
    maxLng: f(b.maxLng, 1),
    maxLat: f(b.maxLat, 1),
  };
}

/** 너무 넓은 범위는 가운데를 기준으로 잘라 Overpass 과부하를 막는다 */
function clamp(b: BBox): BBox {
  const cLng = (b.minLng + b.maxLng) / 2;
  const cLat = (b.minLat + b.maxLat) / 2;
  const out = { ...b };
  if (b.maxLng - b.minLng > MAX_SPAN_LNG) {
    out.minLng = cLng - MAX_SPAN_LNG / 2;
    out.maxLng = cLng + MAX_SPAN_LNG / 2;
  }
  if (b.maxLat - b.minLat > MAX_SPAN_LAT) {
    out.minLat = cLat - MAX_SPAN_LAT / 2;
    out.maxLat = cLat + MAX_SPAN_LAT / 2;
  }
  return out;
}

const keyOf = (b: BBox) =>
  [b.minLng, b.minLat, b.maxLng, b.maxLat].map((v) => v.toFixed(4)).join(",");

/**
 * 범위마다 번들 하나. **여러 범위를 Overpass 한 번으로 받는다.**
 *
 * 공개 미러는 붐빌 때 요청 하나에 수십 초씩 걸리고 거절도 잦다. 실제로 재 보면
 * 걸리는 시간이 범위 크기와 거의 상관없다 — 줄 서는 시간이 대부분이다.
 * 그래서 출발지·목적지·환승지를 따로 부르면 그 줄서기가 그대로 쌓인다.
 */
export async function GET(req: NextRequest) {
  const raws = req.nextUrl.searchParams.getAll("bbox");
  if (!raws.length) return new NextResponse("bbox 파라미터가 필요합니다", { status: 400 });
  if (raws.length > MAX_BOXES)
    return new NextResponse(`범위는 한 번에 ${MAX_BOXES}개까지입니다`, { status: 400 });

  const boxes: BBox[] = [];
  for (const raw of raws) {
    const n = raw.split(",").map(Number);
    if (n.length !== 4 || n.some((v) => !Number.isFinite(v)))
      return new NextResponse("bbox 형식이 올바르지 않습니다", { status: 400 });
    boxes.push(snap(clamp({ minLng: n[0], minLat: n[1], maxLng: n[2], maxLat: n[3] })));
  }

  const wanted = boxes.map(keyOf).join(";");
  const shared = inflight.get(wanted);
  if (shared) return NextResponse.json({ bundles: await shared });

  // 브이월드 키는 등록한 도메인에서만 통한다. 서버에서 부를 때는 Referer 로 알려 줘야 한다
  const referer = process.env.VWORLD_REFERER || req.nextUrl.origin;
  const run = collect(boxes, referer).finally(() => inflight.delete(wanted));
  inflight.set(wanted, run);

  try {
    return NextResponse.json({ bundles: await run });
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 503 });
  }
}

async function collect(boxes: BBox[], referer: string): Promise<(OsmBundle | null)[]> {
  const now = Date.now();
  const bundles: (OsmBundle | null)[] = boxes.map((b) => {
    const hit = cache.get(keyOf(b));
    return hit && now - hit.at < CACHE_TTL_MS ? hit.data : null;
  });

  // 메모리에 없으면 디스크를 본다 (서버를 다시 띄워도 가 본 동네는 그대로 쓴다)
  await Promise.all(
    boxes.map(async (box, i) => {
      if (bundles[i]) return;
      const saved = await readCachedBundle(keyOf(box));
      if (saved) {
        bundles[i] = saved;
        cache.set(keyOf(box), { at: now, data: saved });
      }
    })
  );

  // 그래도 없는 범위만 Overpass 에 묻는다. 하나가 실패해도 나머지는 쓴다
  await Promise.all(
    boxes.map(async (box, i) => {
      if (bundles[i]) return;
      let data: OsmBundle;
      try {
        /*
         * 건물은 브이월드(정부 건물통합정보)에서 받는다 — 훨씬 빠르고 층수까지 있다.
         * Overpass 에서 건물을 빼면 남은 질의도 그만큼 가벼워지므로, 둘을 동시에 부른다.
         * 브이월드가 안 되면 그때 Overpass 로 건물까지 다시 받는다.
         */
        const useVWorld = hasVWorldBuildings();
        const [elements, vwBuildings] = await Promise.all([
          overpass(buildQuery(box, !useVWorld)),
          useVWorld ? fetchVWorldBuildings(box, referer) : Promise.resolve(null),
        ]);
        data = bundleOf(elements, box, woodsOf(elements));
        if (useVWorld) {
          if (vwBuildings?.length) data.buildings = vwBuildings;
          else {
            console.warn("[osm] 브이월드 건물을 못 받아 OSM 으로 되돌아갑니다");
            data.buildings = bundleOf(await overpass(buildQuery(box, true)), box, woodsOf(elements)).buildings;
          }
        }
      } catch (err) {
        console.warn("[osm]", (err as Error).message);
        /*
         * 공개 Overpass 는 붐비면 통째로 못 쓰는 때가 있다. 그럴 때 "지도 없음" 으로
         * 끝내는 대신, 지난번에 받아 둔 것을 (좀 지났더라도) 그대로 쓴다.
         * 건물과 길이 며칠 사이에 달라지지는 않는다.
         */
        const stale = await readCachedBundle(keyOf(box), true);
        if (stale) {
          console.warn("[osm] 지난번에 받아 둔 자료로 대신합니다");
          bundles[i] = stale;
        }
        return;
      }

      // 보행로 좌표마다 고도를 붙인다. DEM 을 못 받으면 그냥 없이 간다
      const elevation = await loadElevation([box.minLng, box.minLat, box.maxLng, box.maxLat]);
      if (!elevation)
        console.warn("[osm] 고도 없이 응답합니다 — 언덕을 넘는 경로가 나올 수 있습니다");
      else
        for (const w of data.ways)
          w.elev = smoothProfile(w.path.map(([lng, lat]) => elevation(lng, lat)));

      bundles[i] = data;
      // 길도 건물도 없으면 제대로 받은 게 아니다. 12시간 캐시에 남기면 두고두고 잘못 안내한다
      if (data.ways.length || data.buildings.length) {
        cache.set(keyOf(box), { at: now, data });
        void writeCachedBundle(keyOf(box), data);
      }
    })
  );

  while (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    cache.delete(oldest[0]);
  }

  return bundles;
}
