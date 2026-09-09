"use client";

import { useEffect } from "react";
import { bboxOfPoints, distMeters, padBBox, type LngLat } from "./geo";
import type { RawBuilding } from "./osm";
import { ShadeIndex, buildShadows } from "./shadow";
import { getSunState } from "./sun";
import { seatAdvice } from "./seat";
import { useActivePlan, useApp } from "./store";
import type { RideLeg } from "./plan";

/** 주행 경로 양옆으로 이만큼까지의 건물이 창을 가린다 */
const CORRIDOR_M = 140;
/** 이보다 긴 구간은 건물을 받지 않는다 — 범위가 넓어 값이 안 맞는다 */
const MAX_RIDE_M = 6000;
/** 구간 하나를 몇 점으로 재는지 */
const SAMPLES_PER_SEGMENT = 3;

/** 승차 구간의 좌석 추천을 건물 그늘까지 넣어 다시 계산한다 */
function seatWithBuildings(leg: RideLeg, buildings: RawBuilding[]) {
  const path = leg.ride.path;
  if (path.length < 2) return null;

  const mid = path[Math.floor(path.length / 2)];
  const sun = getSunState(new Date(leg.startMs), mid);
  if (!sun.isDay) return null;

  // 가로수는 넣지 않는다 — 버스 창 높이에서는 수관이 해를 가리는 정도가 들쭉날쭉하다
  const index = new ShadeIndex(buildShadows(buildings, [], sun), mid[1]);

  const shaded: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    let sum = 0;
    for (let k = 1; k <= SAMPLES_PER_SEGMENT; k++) {
      const t = k / (SAMPLES_PER_SEGMENT + 1);
      sum += index.shadeAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    shaded.push(sum / SAMPLES_PER_SEGMENT);
  }

  return seatAdvice(path, leg.startMs, leg.ride.rideSec, leg.ride.surface, shaded);
}

/**
 * 버스·지하철 자리 추천에 **길 옆 건물 그늘**을 반영한다.
 *
 * 해 방향만 보면 "왼쪽에 해가 든다" 로 끝나지만, 실제로는 길 옆 건물이 창을 가린다.
 * 건물은 브이월드에서 1초 남짓이면 받으므로, 경로가 나온 **뒤에** 따로 받아 덧칠한다.
 * 처음 결과를 늦추지 않으려고 일부러 나중에 한다.
 */
export function useRideShade() {
  const plan = useActivePlan();
  const setSeatOverride = useApp((s) => s.setSeatOverride);
  const planKey = plan ? `${plan.id}:${Math.round(plan.startMs / 60000)}` : "";

  useEffect(() => {
    if (!plan) return;
    const rides = plan.legs
      .map((l, i) => ({ leg: l, i }))
      .filter((x): x is { leg: RideLeg; i: number } => x.leg.type === "ride");
    if (!rides.length) return;

    const ctl = new AbortController();
    (async () => {
      for (const { leg, i } of rides) {
        const path = leg.ride.path;
        if (path.length < 2) continue;
        let length = 0;
        for (let k = 1; k < path.length; k++) length += distMeters(path[k - 1], path[k]);
        if (length > MAX_RIDE_M) continue;

        const box = padBBox(bboxOfPoints(path), CORRIDOR_M);
        const qs = new URLSearchParams({
          bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat].map((v) => v.toFixed(5)).join(","),
        });
        try {
          const res = await fetch(`/api/buildings?${qs}`, { signal: ctl.signal });
          if (!res.ok) continue;
          const { buildings } = (await res.json()) as { buildings: RawBuilding[] };
          if (!buildings?.length) continue;
          const advice = seatWithBuildings(leg, buildings);
          if (advice) setSeatOverride(`${plan.id}:${i}`, advice);
        } catch {
          /* 건물을 못 받으면 해 방향만 본 추천을 그대로 쓴다 */
        }
      }
    })();

    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);
}
