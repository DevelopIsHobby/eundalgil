"use client";

import { useEffect } from "react";
import { useApp } from "./store";
import { useDebounced } from "./useDebounced";
import { fetchOsmBundles, type OsmBundle } from "./osm";
import {
  bboxContains,
  bboxOfPoints,
  distMeters,
  padBBox,
  resample,
  type BBox,
  type LngLat,
} from "./geo";
import { getSunState } from "./sun";
import { ShadeIndex, buildShadows } from "./shadow";
import { SafetyIndex } from "./safety";
import {
  applySafety,
  applyShade,
  buildGraph,
  findRoutes,
  routeBetween,
  type Graph,
  type RouteResult,
} from "./router";
import { FASTEST_WEIGHTS, weightsFromPrefs, type RouteWeights } from "./prefs";
import { buildTransitPlan, buildWalkPlan, type PlanPair, type WalkFn } from "./plan";
import {
  applyShapes,
  fetchArrivals,
  fetchShapes,
  fetchTransit,
  indexArrivals,
  planTransit,
  SEARCH_RADIUS_M,
  type ArrivalIndex,
  type TransitPattern,
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
/**
 * 먼 구간일 때 양 끝에서 따로 받아 오는 반경(m) — 정류장까지 걷는 길을 그리기 위한 것.
 * 걸어갈 수 있다고 본 정류장은 모두 덮어야 한다. 좁으면 그 정류장까지 가는 길을
 * 못 찾아 해당 노선이 통째로 후보에서 빠진다. 길은 직선보다 도니 여유를 둔다.
 */
const ENDPOINT_PAD_M = Math.round(SEARCH_RADIUS_M * 1.3);
/**
 * 대중교통 후보를 넉넉히 뽑아 둔다.
 * 후보는 도보를 직선으로 어림해 고르므로, 막상 계산하면 정류장까지 걷는 길이 없어
 * 통째로 빠질 수 있다. 딱 필요한 만큼만 뽑으면 그때 안내가 0개가 된다.
 */
const TRANSIT_CANDIDATES = 10;
/** 그중 실제로 화면에 올릴 수 */
const MAX_TRANSIT_PLANS = 4;
/** 환승 지점 언저리에서 따로 받아 오는 보행로 반경(m) — 환승 도보를 덮을 만큼만 */
const HUB_PAD_M = 500;
/** 출발 시각을 미뤄 볼 폭 — 30분 간격으로 세 시간까지 */
const LATER_STEPS_MIN = [30, 60, 90, 120, 150, 180];
/** 이만큼(%p) 이상 좋아져야 "이따 나가라" 고 말할 값어치가 있다 */
const LATER_GAIN = 0.1;

/**
 * 같은 길을 이따 걸으면 그늘이 얼마나 달라지는지.
 *
 * 경로를 다시 찾지는 않는다 — **지금 고른 길 그대로** 해만 옮겨 다시 재는 것이다.
 * 해가 기울면 같은 길도 그늘이 확 늘어난다. 그걸 알면 "10분 뒤에 나가지" 가 된다.
 */
function betterDeparture(
  bundles: OsmBundle[],
  walkPaths: LngLat[][],
  fromMs: number,
  useTrees: boolean
) {
  const samples = walkPaths.flatMap((p) => (p.length > 1 ? resample(p, 15) : []));
  if (samples.length < 5) return null;

  const center: LngLat = [
    samples.reduce((a, p) => a + p[0], 0) / samples.length,
    samples.reduce((a, p) => a + p[1], 0) / samples.length,
  ];
  const buildings = bundles.flatMap((b) => b.buildings);
  const trees = useTrees ? bundles.flatMap((b) => b.trees) : [];
  if (!buildings.length) return null;

  const shadeAt = (ms: number) => {
    const sun = getSunState(new Date(ms), center);
    if (!sun.isDay) return 1; // 해가 지면 온통 그늘이다
    const index = new ShadeIndex(buildShadows(buildings, trees, sun), center[1]);
    let sum = 0;
    for (const p of samples) sum += index.shadeAt(p);
    return sum / samples.length;
  };

  const now = shadeAt(fromMs);
  let best = { atMs: fromMs, shade: now };
  for (const min of LATER_STEPS_MIN) {
    const atMs = fromMs + min * 60_000;
    const shade = shadeAt(atMs);
    if (shade > best.shade + 0.001) best = { atMs, shade };
  }

  if (best.atMs === fromMs || best.shade - now < LATER_GAIN) return null;
  return { atMs: best.atMs, shade: best.shade, nowShade: now };
}

/** 이만큼 안에 있는 환승 지점은 한 번만 받는다 */
const HUB_MERGE_M = 400;
/** 환승 지점 보행로를 받아 올 횟수 상한 — 한 곳당 Overpass 한 번이다 */
const MAX_HUB_BUNDLES = 3;

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

/**
 * 두 점을 모두 덮는 그래프를 골라 걷는 길을 낸다.
 *
 * 길을 못 찾으면 **null 이다.** 직선으로 이어 버리면 없는 길이 생긴다 —
 * 상도동 ↔ 흑석동처럼 차도 터널로만 연결된 구간에서 "터널을 가로질러 16분 걷기"
 * 같은 안내가 나온다. 짧은 구간이라고 봐주지도 않는다. 길을 모르면 안 그린다.
 */
function makeWalk(ctxs: Ctx[], weights: RouteWeights): WalkFn {
  return (a: LngLat, b: LngLat): RouteResult | null => {
    for (const c of ctxs) {
      if (!bboxContains(c.bbox, a) || !bboxContains(c.bbox, b)) continue;
      const r = routeBetween(c.graph, a, b, weights);
      if (r) return r;
    }
    return null;
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
      const rects: BBox[] = [];
      if (wantWalk || singleBundle) {
        rects.push(padBBox(bboxOfPoints([origin.p, destination.p]), Math.max(400, straight * 0.45)));
      }
      if (!singleBundle && wantTransit) {
        for (const p of [origin.p, destination.p]) rects.push(padBBox(bboxOfPoints([p]), ENDPOINT_PAD_M));
      }
      const toTuple = (b: BBox): [number, number, number, number] => [
        b.minLng,
        b.minLat,
        b.maxLng,
        b.maxLat,
      ];
      const boxes = rects.map(toTuple);

      // 범위가 여럿이어도 요청은 한 번이다 — Overpass 는 요청마다 줄을 선다
      const bundlesPromise = fetchOsmBundles(boxes, ctl.signal).catch(
        (): (OsmBundle | null)[] => []
      );
      // 노선 정보를 못 받아도 도보 경로는 나와야 하므로 실패를 삼킨다
      const transitPromise = wantTransit
        ? fetchTransit(origin.p, destination.p, ctl.signal).catch(() => null)
        : Promise.resolve(null);

      /*
       * 노선 정보는 보행로보다 훨씬 빨리 온다. 그래서 그것만 있으면 되는 일들을
       * 보행로를 기다리지 않고 미리 시작한다 — 형상·환승지 보행로·실시간 도착.
       * 차례로 기다리면 Overpass 왕복이 두 번 쌓여 조회가 그만큼 느려진다.
       */
      const prepPromise = transitPromise.then(async (transit) => {
        if (!transit) return null;
        // 지도에 주변 정류장을 뿌리는 데 쓴다 (노선 계산과는 별개다)
        if (!cancelled) useApp.getState().setTransitStops(transit.stops);
        const rough = planTransit(transit, origin.p, destination.p, TRANSIT_CANDIDATES);
        if (!rough.length) return { rough, shapes: [], extra: [], live: null };

        const used = new Map<string, TransitPattern>();
        const boarding = new Map<string, TransitStop>();
        const hubBoxes: [number, number, number, number][] = [];
        const hubSeen: LngLat[] = [];
        for (const c of rough) {
          for (const r of c.rides) {
            used.set(r.pattern.id, r.pattern);
            boarding.set(r.from.id, r.from);
          }
          for (let k = 1; k < c.rides.length; k++) {
            for (const p of [c.rides[k - 1].to.p, c.rides[k].from.p]) {
              // 이미 받기로 한 범위 안이면 따로 받을 것 없다
              if (rects.some((b) => bboxContains(b, p))) continue;
              if (hubSeen.some((h) => distMeters(h, p) < HUB_MERGE_M)) continue;
              hubSeen.push(p);
              if (hubBoxes.length >= MAX_HUB_BUNDLES) continue;
              hubBoxes.push(toTuple(padBBox(bboxOfPoints([p]), HUB_PAD_M)));
            }
          }
        }

        const [shapes, extra, live] = await Promise.all([
          fetchShapes(transit, [...used.values()], ctl.signal).catch(() => []),
          fetchOsmBundles(hubBoxes, ctl.signal).catch((): (OsmBundle | null)[] => []),
          followNow
            ? fetchArrivals([...boarding.values()], ctl.signal).catch(() => null)
            : Promise.resolve(null),
        ]);
        return { rough, shapes, extra, live };
      });

      try {
        const [bundles, transit, prep] = await Promise.all([
          bundlesPromise,
          transitPromise,
          prepPromise,
        ]);
        if (cancelled) return;

        let ctxs = bundles
          .filter((b): b is OsmBundle => !!b)
          .filter((b) => b.ways.length > 0)
          .map((b) => contextOf(b, timeMs, showTrees, night))
          .filter((c): c is Ctx => !!c);

        if (!ctxs.length) {
          useApp.getState().setPlans([], "이 지역의 보행로 데이터를 불러오지 못했습니다.");
          return;
        }

        let shadeWalk = makeWalk(ctxs, weights);
        // "최단" 도 걷는 속도만은 그 사람 것을 쓴다 (취향 가산만 뺀 것이다)
        const plainWeights: RouteWeights = { ...FASTEST_WEIGHTS, speedMps: weights.speedMps };
        let fastWalk = makeWalk(ctxs, plainWeights);
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
            /*
             * 1차 결과와 그에 딸린 것들(형상·환승지 보행로·실시간 도착)은
             * 보행로를 기다리는 동안 이미 받아 두었다. 여기서는 붙이기만 한다.
             */
            const rough = prep?.rough ?? [];
            /** 실시간 버스 도착 — "지금" 을 보고 있을 때만 채워진다 */
            let arrivals: ArrivalIndex | null = null;
            if (prep) {
              applyShapes(transit, prep.shapes);

              const added = prep.extra
                .filter((b): b is OsmBundle => !!b)
                .filter((b) => b.ways.length > 0)
                .map((b) => contextOf(b, timeMs, showTrees, night))
                .filter((c): c is Ctx => !!c);
              if (added.length) {
                ctxs = [...ctxs, ...added];
                shadeWalk = makeWalk(ctxs, weights);
                fastWalk = makeWalk(ctxs, plainWeights);
              }

              if (prep.live) arrivals = indexArrivals(prep.live);
              if (prep.live?.notice) notices.push(prep.live.notice);
            }

            /*
             * 2차: 실제로 그릴 것을 짠다. 길 좌표가 없는 구간은 여기서 빠진다.
             * 형상 받기가 실패해도 이 계산은 반드시 거치므로, 어림 좌표가 화면에 새어 나가지 않는다.
             */
            const candidates = planTransit(
              transit,
              origin.p,
              destination.p,
              TRANSIT_CANDIDATES,
              true
            );

            if (!candidates.length) {
              // 버스가 한 노선도 없으면 "노선이 없다" 가 아니라 "데이터가 없다" 가 맞는 설명이다
              const hasBus = transit.patterns.some((p) => p.mode === "bus");
              notices.push(
                hasBus
                  ? "이 구간을 잇는 노선을 찾지 못했어요."
                  : (transit.notice ?? "이 지역 버스 노선 정보를 받지 못해 지하철만 봅니다.")
              );
            }

            // 지도(__map)·상태(__app)와 마찬가지로, 왜 이 노선이 뽑혔는지 콘솔에서 들여다볼 수 있게 한다
            if (process.env.NODE_ENV === "development") {
              (window as unknown as { __transit?: unknown }).__transit = {
                data: transit,
                rough,
                candidates,
              };
            }

            let dropped = 0;
            let kept = 0;
            /*
             * 같은 노선 조합은 한 번만 보여 준다.
             * 타는 정류장이나 내리는 역만 다른 안이 여럿 나오면 네 칸이 "동작08 → 9호선"
             * 으로만 채워져, 정작 다른 노선 안이 밀려난다. 가장 빠른 것 하나만 남긴다.
             */
            const shownRoutes = new Set<string>();
            for (const cand of candidates) {
              if (kept >= MAX_TRANSIT_PLANS) break;
              const routeKey = cand.rides.map((r) => r.pattern.ref || r.pattern.name).join(">");
              if (shownRoutes.has(routeKey)) continue;
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
              shownRoutes.add(routeKey);
              kept++;
            }
            if (dropped && !kept) {
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
        const picked = pairs.slice(0, 4);
        useApp.getState().setPlans(picked, null, notices);

        /* 이따 나가면 같은 길이 더 시원한지 — 경로가 정해진 다음에 따져 본다 */
        const walkPaths = picked[0].shade.legs
          .filter((l) => l.type === "walk")
          .map((l) => (l as { route: RouteResult }).route.path);
        const loaded = bundles.filter((b): b is OsmBundle => !!b);
        useApp
          .getState()
          .setDeparture(sun.isDay ? betterDeparture(loaded, walkPaths, timeMs, showTrees) : null);
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
