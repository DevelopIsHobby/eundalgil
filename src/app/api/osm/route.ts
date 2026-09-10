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
import { readTile, writeTile } from "@/lib/tileStore";
import { inSeoul, tileBBox, tileKey, tilesCovering, type Tile } from "@/lib/tiles";
import { fetchVWorldBuildings, hasVWorldBuildings } from "@/lib/vworldBuildings";
import { loadElevation, smoothProfile } from "@/lib/elevation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * bbox 한 변의 최대 길이(도).
 *
 * 3km 로 묶어 두던 시절에는 이 범위를 그대로 Overpass 에 물었기 때문이다. 지금은
 * 미리 받아 둔 타일을 합쳐 줄 뿐이라, 넓어지면 합칠 타일이 몇 장 늘 뿐이다.
 *
 * 그런데 이 상한이 **도보 단독 안을 조용히 망가뜨리고 있었다.** 도보용 지도는 직선
 * 양옆으로 여유를 두고 받는데, 그 네모가 3km 를 넘으면 가운데만 남기고 잘려서
 * 출발지·도착지가 범위 밖으로 나갔다. 그래서 도보 안은 1.6km 까지만 나왔다 —
 * MAX_WALK_M 은 5km 라고 적혀 있는데도.
 *
 * 산책까지 감당하도록 12km 쯤으로 연다 (10km 도보의 네모가 들어간다).
 */
const MAX_SPAN_LAT = 0.11;
const MAX_SPAN_LNG = 0.13;




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

/**
 * 타일 하나를 갖춰 둔다 — 파일에 있으면 그걸 쓰고, 없으면 받아서 남긴다.
 *
 * 미리 받아 둔 서울이라면 여기서 파일만 읽고 끝난다. 공개 Overpass 를 부르는 건
 * 아직 안 받아 둔 타일뿐이다 (개발 중이거나 미리받기를 돌리는 중).
 */
async function loadTile(t: Tile, referer: string): Promise<OsmBundle | null> {
  const saved = await readTile(t);
  if (saved) return saved;

  const box = tileBBox(t);
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
    console.warn("[osm]", tileKey(t), (err as Error).message);
    return null;
  }

  // 보행로 좌표마다 고도를 붙인다. 타일에 함께 저장하므로 한 번만 계산한다
  const elevation = await loadElevation([box.minLng, box.minLat, box.maxLng, box.maxLat]);
  if (!elevation) console.warn("[osm] 고도 없이 저장합니다 — 언덕을 넘는 경로가 나올 수 있습니다");
  else for (const w of data.ways) w.elev = smoothProfile(w.path.map(([lng, lat]) => elevation(lng, lat)));

  // 길도 건물도 없으면 제대로 받은 게 아니다. 남겨 두면 두고두고 잘못 안내한다
  if (!data.ways.length && !data.buildings.length) return null;
  await writeTile(t, data);
  return data;
}

/** 타일 몇 장을 요청한 범위 하나로 합친다 */
function assemble(box: BBox, parts: OsmBundle[]): OsmBundle {
  const ways: WalkWay[] = [];
  const buildings: RawBuilding[] = [];
  const trees: RawTree[] = [];
  const safety: SafetyPoint[] = [];
  const entrances: Entrance[] = [];
  // 타일 경계에 걸친 길·건물은 양쪽 타일에 모두 들어 있다. id 로 한 번만 담는다
  const seen = new Set<string>();
  const once = <T extends { id: string }>(src: T[], into: T[], hit: (v: T) => boolean) => {
    for (const v of src) {
      if (seen.has(v.id) || !hit(v)) continue;
      seen.add(v.id);
      into.push(v);
    }
  };

  for (const p of parts) {
    once(p.ways, ways, (w) => bboxIntersects(box, bboxOfPoints(w.path)));
    once(p.buildings, buildings, (b) => bboxIntersects(box, bboxOfPoints(b.ring)));
    once(p.trees, trees, (v) => bboxContains(box, v.p));
    once(p.safety, safety, (v) => bboxContains(box, v.p));
    once(p.entrances, entrances, (v) => bboxContains(box, v.p));
  }

  return {
    ways,
    buildings,
    trees,
    safety,
    entrances,
    bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat],
    fetchedAt: Date.now(),
  };
}

/** 너무 넓은 범위는 가운데를 기준으로 잘라, 한 요청이 타일을 지나치게 많이 끌지 않게 한다 */
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
    boxes.push(clamp({ minLng: n[0], minLat: n[1], maxLng: n[2], maxLat: n[3] }));
  }

  if (!boxes.some(inSeoul))
    return new NextResponse("아직 서울 안에서만 길을 찾을 수 있습니다", { status: 422 });

  const wanted = boxes.map((b) => tilesCovering(b).map(tileKey).join(",")).join(";");
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
  // 여러 범위가 같은 타일을 쓰는 일이 흔하다. 타일 단위로 한 번씩만 갖춘다
  const need = new Map<string, Tile>();
  for (const b of boxes) {
    if (!inSeoul(b)) continue;
    for (const t of tilesCovering(b)) need.set(tileKey(t), t);
  }

  const ready = new Map<string, OsmBundle>();
  await Promise.all(
    [...need.values()].map(async (t) => {
      const data = await loadTile(t, referer);
      if (data) ready.set(tileKey(t), data);
    })
  );

  return boxes.map((b) => {
    if (!inSeoul(b)) return null;
    const parts = tilesCovering(b)
      .map((t) => ready.get(tileKey(t)))
      .filter((d): d is OsmBundle => !!d);
    return parts.length ? assemble(b, parts) : null;
  });
}
