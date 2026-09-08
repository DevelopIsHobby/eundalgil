"use client";

import { useEffect } from "react";
import { useApp } from "./store";
import { useDebounced } from "./useDebounced";
import { fetchOsmBundle, type OsmBundle } from "./osm";
import { bboxContains, bboxOfPoints, distMeters, padBBox, type BBox, type LngLat } from "./geo";
import { getSunState } from "./sun";
import { ShadeIndex, buildShadows } from "./shadow";
import { SafetyIndex } from "./safety";
import {
  applySafety,
  applyShade,
  buildGraph,
  findRoutes,
  routeBetween,
  straightRoute,
  type Graph,
  type RouteResult,
} from "./router";
import { FASTEST_WEIGHTS, weightsFromPrefs, type RouteWeights } from "./prefs";
import { buildTransitPlan, buildWalkPlan, type PlanPair, type WalkFn } from "./plan";
import { fetchTransit, planTransit } from "./transit";

/** 도보 단독 경로 상한 — 이보다 멀면 받아야 할 데이터가 급격히 커진다 */
const MAX_WALK_M = 5000;
/** 대중교통까지 포함한 안내 상한 */
const MAX_TRIP_M = 12000;
/** 이 거리 미만이면 대중교통을 찾지 않는다 (걷는 게 낫다) */
const MIN_TRANSIT_M = 600;
/** 이 거리까지는 출발·도착을 한 덩어리 데이터로 덮을 수 있다 */
const SINGLE_BUNDLE_M = 2400;
/** 먼 구간일 때 양 끝에서 따로 받아 오는 반경(m) — 정류장까지 걷는 길을 그리기 위한 것 */
const ENDPOINT_PAD_M = 900;

type Ctx = { bbox: BBox; graph: Graph };

function toBBox(b: OsmBundle["bbox"]): BBox {
  return { minLng: b[0], minLat: b[1], maxLng: b[2], maxLat: b[3] };
}

/** 번들 하나를 그늘·방범 정보까지 채운 보행 그래프로 만든다 */
function contextOf(
  bundle: OsmBundle,
  timeMs: number,
  useTrees: boolean,
  night: boolean
): Ctx | null {
  const bbox = toBBox(bundle.bbox);
  const center: LngLat = [(bbox.minLng + bbox.maxLng) / 2, (bbox.minLat + bbox.maxLat) / 2];
  const graph = buildGraph(bundle.ways, center[1]);
  if (!graph.nodes.length) return null;

  const sun = getSunState(new Date(timeMs), center);
  const shade = new ShadeIndex(
    buildShadows(bundle.buildings, useTrees ? bundle.trees : [], sun),
    center[1]
  );
  applyShade(graph, shade);
  // 방범시설은 야간에만 비용에 들어가므로 그때만 계산한다
  if (night) applySafety(graph, new SafetyIndex(bundle.safety, center[1]));

  return { bbox, graph };
}

/** 두 점을 모두 덮는 그래프를 골라 걷는 길을 낸다. 없으면 직선으로 어림잡는다. */
function makeWalk(ctxs: Ctx[], weights: RouteWeights): WalkFn {
  return (a: LngLat, b: LngLat): RouteResult => {
    for (const c of ctxs) {
      if (!bboxContains(c.bbox, a) || !bboxContains(c.bbox, b)) continue;
      const r = routeBetween(c.graph, a, b, weights);
      if (r) return r;
    }
    return straightRoute(a, b);
  };
}

export function useRouting() {
  const origin = useApp((s) => s.origin);
  const destination = useApp((s) => s.destination);
  const rawTimeMs = useApp((s) => s.timeMs);
  // 시각 슬라이더를 끄는 동안 매 프레임 재계산하지 않도록 잠깐 묶어 둔다
  const timeMs = useDebounced(rawTimeMs, 350);
  const prefs = useApp((s) => s.prefs);
  const showTrees = useApp((s) => s.showTrees);

  useEffect(() => {
    const store = useApp.getState();
    if (!origin || !destination) {
      if (store.plans.length) store.setPlans([], null);
      return;
    }

    const straight = distMeters(origin.p, destination.p);
    if (straight > MAX_TRIP_M) {
      store.setPlans([], `직선거리 ${MAX_TRIP_M / 1000}km 이내 구간만 안내합니다.`);
      return;
    }

    let cancelled = false;
    const ctl = new AbortController();
    store.setRouting(true);
    store.setPlans([], null);

    (async () => {
      const mid: LngLat = [
        (origin.p[0] + destination.p[0]) / 2,
        (origin.p[1] + destination.p[1]) / 2,
      ];
      const sun = getSunState(new Date(timeMs), mid);
      const night = !sun.isDay;
      const weights = weightsFromPrefs(prefs, sun.isDay);
      const preferLabel = night && prefs.nightSafety ? "밤길 추천" : "그늘로 추천";

      const wantTransit = straight >= MIN_TRANSIT_M;
      const wantWalk = straight <= MAX_WALK_M;
      const singleBundle = straight <= SINGLE_BUNDLE_M;

      /* 받아야 할 OSM 범위 — 도보용 한 덩어리, 먼 구간이면 양 끝을 따로 */
      const boxes: [number, number, number, number][] = [];
      if (wantWalk || singleBundle) {
        const box = padBBox(bboxOfPoints([origin.p, destination.p]), Math.max(400, straight * 0.45));
        boxes.push([box.minLng, box.minLat, box.maxLng, box.maxLat]);
      }
      if (!singleBundle && wantTransit) {
        for (const p of [origin.p, destination.p]) {
          const box = padBBox(bboxOfPoints([p]), ENDPOINT_PAD_M);
          boxes.push([box.minLng, box.minLat, box.maxLng, box.maxLat]);
        }
      }

      const bundlesPromise = Promise.all(
        boxes.map((b) => fetchOsmBundle(b, ctl.signal).catch(() => null))
      );
      // 노선 정보를 못 받아도 도보 경로는 나와야 하므로 실패를 삼킨다
      const transitPromise = wantTransit
        ? fetchTransit(origin.p, destination.p, ctl.signal).catch(() => null)
        : Promise.resolve(null);

      try {
        const [bundles, transit] = await Promise.all([bundlesPromise, transitPromise]);
        if (cancelled) return;

        const ctxs = bundles
          .filter((b): b is OsmBundle => !!b)
          .map((b) => contextOf(b, timeMs, showTrees, night))
          .filter((c): c is Ctx => !!c);

        if (!ctxs.length) {
          useApp.getState().setPlans([], "이 지역의 보행로 데이터를 불러오지 못했습니다.");
          return;
        }

        const shadeWalk = makeWalk(ctxs, weights);
        const fastWalk = makeWalk(ctxs, FASTEST_WEIGHTS);
        const meta = {
          originName: origin.name,
          destName: destination.name,
          startMs: timeMs,
        };

        const pairs: PlanPair[] = [];
        const notices: string[] = [];
        let planError: string | null = null;

        /*
         * 야간 안내를 켰는데 방범시설이 거의 등록돼 있지 않으면, 경로가 최단과 같아진다.
         * 아무 말 없이 같은 길을 주면 설정이 안 먹은 것처럼 보이므로 이유를 알려 준다.
         */
        if (night && prefs.nightSafety) {
          const lamps = bundles.reduce((n, b) => n + (b?.safety.length ?? 0), 0);
          if (lamps < 12) {
            notices.push(
              "이 지역은 가로등·CCTV 정보가 거의 등록돼 있지 않아 밤길 안내가 최단 경로와 같을 수 있어요."
            );
          }
        }

        /* 1) 도보 단독 */
        if (wantWalk) {
          const { routes, error } = findRoutes(
            ctxs[0].graph,
            origin.p,
            destination.p,
            weights,
            preferLabel
          );
          if (routes.length) {
            const fast = routes.find((r) => r.id === "fast") ?? routes[0];
            const pref = routes.find((r) => r.id === "shade") ?? fast;
            pairs.push({ shade: buildWalkPlan(pref, meta), fast: buildWalkPlan(fast, meta) });
          } else if (error) {
            planError = error;
          }
        }

        /* 2) 대중교통 */
        if (wantTransit) {
          if (!transit) {
            notices.push("대중교통 노선 정보를 불러오지 못했어요. 도보 경로만 보여드려요.");
          } else {
            const candidates = planTransit(transit, origin.p, destination.p, 4);
            if (!candidates.length) {
              notices.push(
                "이 구간을 잇는 노선을 찾지 못했어요. (OpenStreetMap 에 등록된 노선 기준)"
              );
            }
            for (const cand of candidates) {
              const base = { ...meta, origin: origin.p, destination: destination.p };
              pairs.push({
                shade: buildTransitPlan(cand, { ...base, style: "shade", walk: shadeWalk }),
                fast: buildTransitPlan(cand, { ...base, style: "fast", walk: fastWalk }),
              });
            }
          }
        }

        if (cancelled) return;

        if (!pairs.length) {
          useApp
            .getState()
            .setPlans([], planError ?? "이 구간의 경로를 찾지 못했습니다.", notices);
          return;
        }

        pairs.sort((a, b) => a.fast.seconds - b.fast.seconds);
        useApp.getState().setPlans(pairs.slice(0, 4), null, notices);
      } catch (err) {
        if (cancelled || (err as Error).name === "AbortError") return;
        useApp.getState().setPlans([], (err as Error).message);
      } finally {
        if (!cancelled) useApp.getState().setRouting(false);
      }
    })();

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [origin, destination, timeMs, prefs, showTrees]);
}
