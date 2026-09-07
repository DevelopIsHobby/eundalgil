import { NextRequest, NextResponse } from "next/server";
import { estimateHeight } from "@/lib/shadow";
import type { LngLat } from "@/lib/geo";
import type { OsmBundle, RawBuilding, RawTree, SafetyPoint, WalkWay } from "@/lib/osm";
import { overpass, type OverpassElement } from "@/lib/overpass";

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
  node["highway"="street_lamp"](${bb});
  node["man_made"="surveillance"](${bb});
  node["emergency"="phone"](${bb});
);
out geom qt;`;
}

function wayKind(tags: Record<string, string>): WalkWay["kind"] {
  const h = tags.highway;
  if (h === "steps") return "steps";
  if (tags.footway === "crossing" || tags.crossing) return "crossing";
  if (h === "footway" || h === "path" || h === "pedestrian" || h === "cycleway") return "footway";
  if (tags.leisure === "park") return "park";
  return "road";
}

function walkable(tags: Record<string, string>) {
  if (tags.foot === "no" || tags.access === "private" || tags.access === "no") return false;
  if (tags.indoor === "yes") return false;
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
          kind: wayKind(tags),
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
