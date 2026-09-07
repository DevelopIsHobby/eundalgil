"use client";

import { useEffect } from "react";
import { useApp } from "./store";
import { useDebounced } from "./useDebounced";
import { fetchOsmBundle } from "./osm";
import { bboxOfPoints, distMeters, padBBox } from "./geo";
import { getSunState } from "./sun";
import { ShadeIndex, buildShadows } from "./shadow";
import { applyShade, buildGraph, findRoutes } from "./router";
import { SHADE_PRESETS } from "./config";

/** 도보 단독 경로 상한 — 이보다 멀면 데이터 양이 급증한다 */
const MAX_WALK_M = 5000;

export function useRouting() {
  const origin = useApp((s) => s.origin);
  const destination = useApp((s) => s.destination);
  const rawTimeMs = useApp((s) => s.timeMs);
  // 시각 슬라이더를 끄는 동안 매 프레임 재계산하지 않도록 잠깐 묶어 둔다
  const timeMs = useDebounced(rawTimeMs, 350);
  const shadePreset = useApp((s) => s.shadePreset);
  const avoidSteps = useApp((s) => s.avoidSteps);
  const showTrees = useApp((s) => s.showTrees);

  useEffect(() => {
    const store = useApp.getState();
    if (!origin || !destination) {
      if (store.routes.length) store.setRoutes([], null);
      return;
    }

    const straight = distMeters(origin.p, destination.p);
    if (straight > MAX_WALK_M) {
      store.setRoutes([], `도보 경로는 직선거리 ${MAX_WALK_M / 1000}km 이내에서만 안내합니다.`);
      return;
    }

    let cancelled = false;
    const ctl = new AbortController();
    store.setRouting(true);
    store.setRoutes([], null);

    (async () => {
      try {
        // 우회 경로까지 담기도록 두 지점 bbox를 넉넉히 넓힌다
        const box = padBBox(bboxOfPoints([origin.p, destination.p]), Math.max(400, straight * 0.45));
        const bundle = await fetchOsmBundle(
          [box.minLng, box.minLat, box.maxLng, box.maxLat],
          ctl.signal
        );
        if (cancelled) return;

        const mid: [number, number] = [
          (origin.p[0] + destination.p[0]) / 2,
          (origin.p[1] + destination.p[1]) / 2,
        ];
        const sun = getSunState(new Date(timeMs), mid);
        const shadeIndex = new ShadeIndex(
          buildShadows(bundle.buildings, showTrees ? bundle.trees : [], sun),
          mid[1]
        );

        const graph = buildGraph(bundle.ways, mid[1]);
        if (!graph.nodes.length) {
          useApp.getState().setRoutes([], "이 지역의 보행로 데이터가 없습니다.");
          return;
        }
        applyShade(graph, shadeIndex);

        const weight = SHADE_PRESETS.find((p) => p.id === shadePreset)?.weight ?? 0;
        const { routes, error } = findRoutes(graph, origin.p, destination.p, {
          shadeWeight: sun.isDay ? weight : 0,
          avoidSteps,
        });
        if (cancelled) return;
        useApp.getState().setRoutes(routes, error ?? null);
      } catch (err) {
        if (cancelled || (err as Error).name === "AbortError") return;
        useApp.getState().setRoutes([], (err as Error).message);
      } finally {
        if (!cancelled) useApp.getState().setRouting(false);
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [origin, destination, timeMs, shadePreset, avoidSteps, showTrees]);
}
