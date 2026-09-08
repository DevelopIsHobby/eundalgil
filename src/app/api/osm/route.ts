import { NextRequest, NextResponse } from "next/server";
import { estimateHeight } from "@/lib/shadow";
import { bboxContains, bboxOfPoints, pointInRing, type BBox, type LngLat } from "@/lib/geo";
import type { OsmBundle, RawBuilding, RawTree, SafetyPoint, WalkWay } from "@/lib/osm";
import { overpass, type OverpassElement } from "@/lib/overpass";
import { loadElevation, smoothProfile } from "@/lib/elevation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** bbox 한 변의 최대 길이(도). 약 3km 정도로 제한해 Overpass 과부하를 막는다. */
const MAX_SPAN_LAT = 0.028;
const MAX_SPAN_LNG = 0.035;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 40;
const cache = new Map<string, { at: number; data: OsmBundle }>();

const WALK_HIGHWAY =
  "^(footway|path|pedestrian|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway|road)$";

function buildQuery(s: number, w: number, n: number, e: number) {
  const bb = `${s},${w},${n},${e}`;
  return `[out:json][timeout:40];
(
  way["building"](${bb});
  node["natural"="tree"](${bb});
  way["highway"~"${WALK_HIGHWAY}"]["area"!~"yes"](${bb});
  way["natural"~"^(wood|scrub)$"](${bb});
  way["landuse"~"^(forest)$"](${bb});
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

function walkable(tags: Record<string, string>) {
  if (tags.foot === "no" || tags.access === "private" || tags.access === "no") return false;
  if (tags.indoor === "yes") return false;

  /*
   * 차도 터널은 걸어 들어가는 길이 아니다.
   * 상도동 양녕로처럼 언덕을 뚫은 터널이 있으면, 거리로만 보면 가장 곧은 길이라
   * 경로가 그리로 빨려 들어간다. 실제로는 아무도 그렇게 걷지 않는다.
   * 보행자용 지하도(footway·steps·path 에 붙은 tunnel)는 그대로 쓴다.
   */
  const inTunnel = tags.tunnel && tags.tunnel !== "no";
  if (inTunnel && MOTOR_ROAD.test(tags.highway ?? "") && tags.foot !== "yes" && !tags.sidewalk) {
    return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("bbox");
  if (!raw) return new NextResponse("bbox 파라미터가 필요합니다", { status: 400 });

  const nums = raw.split(",").map(Number);
  if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v)))
    return new NextResponse("bbox 형식이 올바르지 않습니다", { status: 400 });

  let [minLng, minLat, maxLng, maxLat] = nums;
  // 과도한 요청 범위는 중심 기준으로 잘라낸다
  const cLng = (minLng + maxLng) / 2;
  const cLat = (minLat + maxLat) / 2;
  if (maxLng - minLng > MAX_SPAN_LNG) {
    minLng = cLng - MAX_SPAN_LNG / 2;
    maxLng = cLng + MAX_SPAN_LNG / 2;
  }
  if (maxLat - minLat > MAX_SPAN_LAT) {
    minLat = cLat - MAX_SPAN_LAT / 2;
    maxLat = cLat + MAX_SPAN_LAT / 2;
  }

  const key = [minLng, minLat, maxLng, maxLat].map((v) => v.toFixed(4)).join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.data);
  }

  let elements: OverpassElement[];
  try {
    elements = await overpass(buildQuery(minLat, minLng, maxLat, maxLng));
  } catch (err) {
    return new NextResponse((err as Error).message, { status: 503 });
  }

  const buildings: RawBuilding[] = [];
  const trees: RawTree[] = [];
  const ways: WalkWay[] = [];
  const safety: SafetyPoint[] = [];

  /*
   * 태그 없는 highway=path 를 무조건 산길로 보면, 아파트 단지 안 보행로까지 산길이 된다.
   * (상도역롯데캐슬파크엘 단지 내 길 357m 가 실제로 그렇게 잡혔다)
   * 그래서 숲 폴리곤을 같이 받아 두고, 그 안에 있는 비포장 길만 산길로 본다.
   */
  const woods: { ring: LngLat[]; bbox: BBox }[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type !== "way" || !el.geometry || el.geometry.length < 4) continue;
    if (!/^(wood|scrub)$/.test(t.natural ?? "") && t.landuse !== "forest") continue;
    const ring: LngLat[] = el.geometry.map((g) => [g.lon, g.lat]);
    woods.push({ ring, bbox: bboxOfPoints(ring) });
  }
  const inWood = (p: LngLat) =>
    woods.some((w) => bboxContains(w.bbox, p) && pointInRing(p, w.ring));

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
      const path: LngLat[] = el.geometry.map((g) => [g.lon, g.lat]);
      if (tags.building) {
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
          kind: wayKind(tags, inWood(path[Math.floor(path.length / 2)])),
          incline: tags.incline,
          name: tags.name,
          covered: tags.covered === "yes" || tags.tunnel === "building_passage",
        });
      }
    } else if (el.type === "node" && el.lat != null && el.lon != null) {
      const p: LngLat = [el.lon, el.lat];
      if (tags.natural === "tree") {
        const h = parseFloat(tags.height ?? "") || 8;
        const crown = parseFloat(tags["diameter_crown"] ?? "") / 2 || 3;
        trees.push({ id: `n${el.id}`, p, height: h, crown: Math.max(1.5, crown) });
      } else if (tags.highway === "street_lamp") {
        safety.push({ id: `n${el.id}`, p, kind: "lamp" });
      } else if (tags.man_made === "surveillance") {
        safety.push({ id: `n${el.id}`, p, kind: "cctv" });
      } else if (tags.emergency === "phone") {
        safety.push({ id: `n${el.id}`, p, kind: "emergency" });
      }
    }
  }

  // 보행로 좌표마다 고도를 붙인다. DEM 을 못 받으면 그냥 없이 간다
  const elevation = await loadElevation([minLng, minLat, maxLng, maxLat]);
  if (!elevation) console.warn("[osm] 고도 없이 응답합니다 — 언덕을 넘는 경로가 나올 수 있습니다");
  if (elevation) {
    for (const w of ways) {
      w.elev = smoothProfile(w.path.map(([lng, lat]) => elevation(lng, lat)));
    }
  }

  const data: OsmBundle = {
    buildings,
    trees,
    ways,
    safety,
    bbox: [minLng, minLat, maxLng, maxLat],
    fetchedAt: Date.now(),
  };

  cache.set(key, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }

  return NextResponse.json(data);
}
