import { NextResponse } from "next/server";
import { getSunState } from "@/lib/sun";
import { ShadeIndex, buildShadows } from "@/lib/shadow";
import { applyShade, buildGraph, findRoutes } from "@/lib/router";
import { DEFAULT_PREFS, weightsFromPrefs, type Prefs } from "@/lib/prefs";
import { planTransit, type TransitData } from "@/lib/transit";
import { cacheStats } from "@/lib/osmCache";
import { bboxOfPoints, padBBox, distMeters } from "@/lib/geo";
import type { OsmBundle } from "@/lib/osm";
import type { LngLat } from "@/lib/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  // from/to 를 주면 그 구간을, 없으면 광화문 → 을지로입구를 본다. (형식: lng,lat)
  const parse = (v: string | null, fallback: LngLat): LngLat => {
    const [lng, lat] = (v ?? "").split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : fallback;
  };
  const origin = parse(url.searchParams.get("from"), [126.9769, 37.5759]);
  const dest = parse(url.searchParams.get("to"), [126.9895, 37.5704]);
  const when = new Date();
  when.setHours(Number(url.searchParams.get("h") ?? 15), 0, 0, 0);

  // 앱(useRouting)과 같은 범위를 써야 여기서 본 결과가 화면과 일치한다.
  // pad 를 주면 그 값(m)으로 넓혀 본다 — 경로가 끊길 때 범위 탓인지 가리는 데 쓴다.
  const straight = distMeters(origin, dest);
  const padM = Number(url.searchParams.get("pad")) || Math.max(400, straight * 0.45);
  const box = padBBox(bboxOfPoints([origin, dest]), padM);
  const base = `${url.protocol}//${url.host}`;
  const res = await fetch(
    `${base}/api/osm?bbox=${[box.minLng, box.minLat, box.maxLng, box.maxLat].join(",")}`
  );
  if (!res.ok) return new NextResponse(await res.text(), { status: 500 });
  // /api/osm 은 bbox 를 여러 개 받고 `{ bundles: [...] }` 로 돌려준다.
  // 여기서는 한 덩어리만 쓰므로 첫 칸을 꺼낸다 (실패한 칸은 null 이다).
  const { bundles } = (await res.json()) as { bundles?: (OsmBundle | null)[] };
  const bundle = bundles?.[0];
  if (!bundle) {
    return new NextResponse("이 범위의 지도 데이터를 받지 못했습니다 (Overpass 응답 없음)", {
      status: 503,
    });
  }
  const tFetch = Date.now();

  const mid: LngLat = [(origin[0] + dest[0]) / 2, (origin[1] + dest[1]) / 2];
  const sun = getSunState(when, mid);
  const shadows = buildShadows(bundle.buildings, bundle.trees, sun);
  const idx = new ShadeIndex(shadows, mid[1]);
  const tShadow = Date.now();

  const graph = buildGraph(bundle.ways, mid[1]);
  applyShade(graph, idx);
  const tGraph = Date.now();

  // 화면의 설정을 그대로 재현할 수 있게 취향을 파라미터로 열어 둔다
  const pick = <T extends string>(name: string, fallback: T) =>
    (url.searchParams.get(name) as T | null) ?? fallback;
  const prefs: Prefs = {
    ...DEFAULT_PREFS,
    sun: pick("sun", DEFAULT_PREFS.sun),
    hill: pick("hill", DEFAULT_PREFS.hill),
    steps: pick("steps", DEFAULT_PREFS.steps),
    vibe: pick("vibe", DEFAULT_PREFS.vibe),
    detour: pick("detour", DEFAULT_PREFS.detour),
    excludeSteps: url.searchParams.get("excludeSteps") === "1",
  };
  const r = findRoutes(graph, origin, dest, weightsFromPrefs(prefs, sun.isDay));
  const tRoute = Date.now();

  /* 대중교통은 따로 켠다 — Overpass 를 한 번 더 부르기 때문이다 */
  let transit: unknown = null;
  if (url.searchParams.get("transit") === "1") {
    const tRes = await fetch(
      `${base}/api/transit?a=${origin.join(",")}&b=${dest.join(",")}&r=800`
    );
    if (tRes.ok) {
      const data = (await tRes.json()) as TransitData;
      const cands = planTransit(data, origin, dest, 4);
      transit = {
        stops: data.stops.length,
        patterns: data.patterns.length,
        candidates: cands.map((c) => ({
          minutes: +(c.estimateSec / 60).toFixed(1),
          transfers: c.rides.length - 1,
          rides: c.rides.map(
            (ride) =>
              `${ride.pattern.ref || ride.pattern.name}: ${ride.from.name} → ${ride.to.name} (${ride.stopCount}개 정류장)`
          ),
          accessM: Math.round(c.accessMeters),
          egressM: Math.round(c.egressMeters),
        })),
      };
    } else {
      transit = { error: await tRes.text() };
    }
  }

  return NextResponse.json({
    straightLineM: Math.round(distMeters(origin, dest)),
    counts: {
      buildings: bundle.buildings.length,
      trees: bundle.trees.length,
      ways: bundle.ways.length,
      safety: bundle.safety.length,
      shadowPolys: shadows.length,
      graphNodes: graph.nodes.length,
      graphEdges: graph.adj.reduce((a, b) => a + b.length, 0) / 2,
    },
    // 고도를 실제로 받았는지 — false 면 오르막이 비용에 안 들어간 것이다
    elevationOk: bundle.ways.some((w) => w.elev && w.elev.length > 0),
    sun: {
      altitude: +sun.altitudeDeg.toFixed(1),
      azimuth: +sun.azimuthDeg.toFixed(1),
      shadowRatio: +sun.shadowRatio.toFixed(2),
    },
    routes: r.routes.map((x) => ({
      id: x.id,
      distance: Math.round(x.distance),
      minutes: +(x.duration / 60).toFixed(1),
      shade: +(x.shadeRatio * 100).toFixed(1),
      segments: x.segments.length,
      steps: Math.round(x.stepsMeters),
      crossings: x.crossings,
      ascent: x.ascent,
      // "왜 이런 길로 가지?" 를 바로 볼 수 있게 지나는 길을 나열한다
      streets: x.streets.filter((st) => st.meters >= 5).map((st) => `${st.name} (${st.kind}) ${st.meters}m`),
      // 고도·경사를 따로 재 보려고 좌표를 성기게 실어 준다
      path: x.path.filter((_, i) => i % 5 === 0 || i === x.path.length - 1),
    })),
    prefs,
    // 디스크 캐시가 얼마나 쌓였는지 — 느릴 때 캐시 탓인지 Overpass 탓인지 가른다
    osmCache: await cacheStats(),
    transit,
    error: r.error ?? null,
    msec: { fetch: tFetch - t0, shadow: tShadow - tFetch, graph: tGraph - tShadow, route: tRoute - tGraph },
  });
}
