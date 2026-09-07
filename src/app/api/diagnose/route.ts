import { NextResponse } from "next/server";
import { getSunState } from "@/lib/sun";
import { ShadeIndex, buildShadows } from "@/lib/shadow";
import { applyShade, buildGraph, findRoutes } from "@/lib/router";
import { bboxOfPoints, padBBox, distMeters } from "@/lib/geo";
import type { OsmBundle } from "@/lib/osm";
import type { LngLat } from "@/lib/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const t0 = Date.now();
  const url = new URL(req.url);
  const origin: LngLat = [126.9769, 37.5759]; // 광화문
  const dest: LngLat = [126.9895, 37.5704];   // 을지로입구
  const when = new Date();
  when.setHours(Number(url.searchParams.get("h") ?? 15), 0, 0, 0);

  const box = padBBox(bboxOfPoints([origin, dest]), 500);
  const base = `${url.protocol}//${url.host}`;
  const res = await fetch(
    `${base}/api/osm?bbox=${[box.minLng, box.minLat, box.maxLng, box.maxLat].join(",")}`
  );
  if (!res.ok) return new NextResponse(await res.text(), { status: 500 });
  const bundle = (await res.json()) as OsmBundle;
  const tFetch = Date.now();

  const mid: LngLat = [(origin[0] + dest[0]) / 2, (origin[1] + dest[1]) / 2];
  const sun = getSunState(when, mid);
  const shadows = buildShadows(bundle.buildings, bundle.trees, sun);
  const idx = new ShadeIndex(shadows, mid[1]);
  const tShadow = Date.now();

  const graph = buildGraph(bundle.ways, mid[1]);
  applyShade(graph, idx);
  const tGraph = Date.now();

  const r = findRoutes(graph, origin, dest, { shadeWeight: 1.4, avoidSteps: false });
  const tRoute = Date.now();

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
    })),
    error: r.error ?? null,
    msec: { fetch: tFetch - t0, shadow: tShadow - tFetch, graph: tGraph - tShadow, route: tRoute - tGraph },
  });
}
