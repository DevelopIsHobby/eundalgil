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
import {
  fetchArrivals,
  fetchTransit,
  indexArrivals,
  planTransit,
  type ArrivalIndex,
  type TransitStop,
} from "./transit";

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

/** 정류장 바로 앞처럼 짧은 틈만 직선으로 메운다 */
const STRAIGHT_GAP_M = 120;

/**
 * 두 점을 모두 덮는 그래프를 골라 걷는 길을 낸다.
 *
 * 길을 못 찾으면 **null 이다.** 예전에는 직선으로 이어 버렸는데, 상도동 ↔ 흑석동처럼
 * 차도 터널로만 연결된 구간에서 "터널을 가로질러 16분 걷기" 라는 없는 길이 만들어졌다.
 * 정류장 코앞의 짧은 틈만 직선으로 메운다.
 */
function makeWalk(ctxs: Ctx[], weights: RouteWeights): WalkFn {
  return (a: LngLat, b: LngLat): RouteResult | null => {
    for (const c of ctxs) {
      if (!bboxContains(c.bbox, a) || !bboxContains(c.bbox, b)) continue;
      const r = routeBetween(c.graph, a, b, weights);
      if (r) return r;
    }
    return distMeters(a, b) <= STRAIGHT_GAP_M ? straightRoute(a, b) : null;
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
  /** 시각 막대가 "실시간" 인지 — 이때만 버스 도착 예정을 받아 쓴다 */
  const followNow = useApp((s) => s.followNow);

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
      const preferLabel = night && prefs.nightSafety ? "밤길 우선" : "그늘 우선";

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
        /*
         * "지금" 을 보고 있으면 계산에도 진짜 지금을 쓴다.
         * 시각 막대는 값을 스스로 갱신하지 않아 timeMs 가 몇 분씩 묵을 수 있는데,
         * 그 값으로 실시간 도착을 맞추면 이미 지나간 차를 타는 안내가 나온다.
         */
        const startMs = followNow ? Date.now() : timeMs;
        const meta = {
          originName: origin.name,
          destName: destination.name,
          startMs,
        };

        const pairs: PlanPair[] = [];
        const notices: string[] = [];
        let walkPair: PlanPair | null = null;
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
            walkPair = { shade: buildWalkPlan(pref, meta), fast: buildWalkPlan(fast, meta) };
            pairs.push(walkPair);
          } else if (error) {
            planError = error;
            // 대중교통 후보가 있으면 화면은 그쪽을 보여 주므로, 왜 도보가 없는지 따로 알린다
            notices.push(`걸어서 이어지는 길을 찾지 못했어요. ${error}`);
          }
        }

        /* 2) 대중교통 */
        if (wantTransit) {
          if (!transit) {
            notices.push("대중교통 노선 정보를 불러오지 못했어요. 도보 경로만 보여드려요.");
          } else {
            const candidates = planTransit(transit, origin.p, destination.p, 4);
            if (!candidates.length) {
              // 버스가 한 노선도 없으면 "노선이 없다" 가 아니라 "데이터가 없다" 가 맞는 설명이다
              const hasBus = transit.patterns.some((p) => p.mode === "bus");
              notices.push(
                hasBus
                  ? "이 구간을 잇는 노선을 찾지 못했어요."
                  : (transit.notice ?? "이 지역 버스 노선 정보를 받지 못해 지하철만 봅니다.")
              );
            }
            /*
             * 실시간 버스 도착 — "지금" 을 보고 있을 때만 받는다.
             * 시각 막대를 옮겨 다른 시각을 보는 중이라면 그때 무슨 차가 올지는 알 수 없으니
             * 수단별 평균 배차로 되돌린다.
             */
            let arrivals: ArrivalIndex | null = null;
            if (followNow && candidates.length) {
              const boarding = new Map<string, TransitStop>();
              for (const c of candidates) for (const r of c.rides) boarding.set(r.from.id, r.from);
              try {
                const got = await fetchArrivals([...boarding.values()], ctl.signal);
                if (got) arrivals = indexArrivals(got);
                if (got?.notice) notices.push(got.notice);
              } catch {
                /* 못 받아도 평균 배차로 안내하면 된다 — 굳이 알리지 않는다 */
              }
              if (cancelled) return;
            }

            let dropped = 0;
            for (const cand of candidates) {
              const base = { ...meta, origin: origin.p, destination: destination.p, arrivals };
              const shade = buildTransitPlan(cand, { ...base, style: "shade", walk: shadeWalk });
              const fast = buildTransitPlan(cand, { ...base, style: "fast", walk: fastWalk });
              // 정류장까지 걸어갈 길이 없는 조합은 버린다
              if (!shade || !fast) {
                dropped++;
                continue;
              }
              /*
               * 걷는 것보다 느린 대중교통은 안내할 이유가 없다.
               * 후보를 고를 때는 도보를 직선으로 어림잡으므로, 실제 길을 다 계산한
               * 지금에서야 이 비교가 가능하다.
               */
              if (walkPair && fast.seconds > walkPair.fast.seconds * 1.15) {
                dropped++;
                continue;
              }
              pairs.push({ shade, fast });
            }
            if (dropped && pairs.length <= 1) {
              notices.push("정류장까지 걷는 길이 없거나 걷는 편이 빨라, 일부 노선은 뺐어요.");
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
  }, [origin, destination, timeMs, prefs, showTrees, followNow]);
}
