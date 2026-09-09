"use client";

import { useEffect } from "react";
import { bboxOfPoints, distMeters, padBBox, type LngLat } from "./geo";
import { useActivePlan, useApp } from "./store";
import { useDebounced } from "./useDebounced";

export type Shelter = {
  id: string;
  name: string;
  kind: string;
  address: string;
  p: LngLat;
  openNow: boolean;
  hours: string;
};

/** 경로에서 이만큼 안에 있는 쉼터만 "지나는 길에 있다" 고 본다 */
export const SHELTER_NEAR_M = 120;

/**
 * 걷는 구간 옆의 쉼터.
 * 경로 좌표를 하나씩 재는 대신 성기게 건너뛰며 잰다 — 120m 안을 찾는 데 그 정도면 충분하다.
 */
export function sheltersNearPath(
  shelters: Shelter[],
  path: LngLat[],
  radius = SHELTER_NEAR_M
): Shelter[] {
  if (!shelters.length || path.length < 2) return [];
  const step = Math.max(1, Math.floor(path.length / 60));
  const out: Shelter[] = [];
  for (const s of shelters) {
    for (let i = 0; i < path.length; i += step) {
      if (distMeters(s.p, path[i]) <= radius) {
        out.push(s);
        break;
      }
    }
  }
  return out;
}

/** 여정 전체(걷는 구간만)에서 지나는 쉼터 */
export function sheltersOnPlanWalks(shelters: Shelter[], paths: LngLat[][]) {
  const seen = new Set<string>();
  const out: Shelter[] = [];
  for (const path of paths) {
    for (const s of sheltersNearPath(shelters, path)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/**
 * 지금 보고 있는 여정 주변의 무더위쉼터를 받아 둔다.
 *
 * 목록이 서울 전체로 4천 곳이라 서버가 범위로 잘라 준다. 여는 시간이 시설마다 달라서
 * **화면에 띄운 시각 기준으로** 열렸는지까지 서버에서 판단해 온다.
 */
export function useShelters() {
  const plan = useActivePlan();
  const rawTime = useApp((s) => s.timeMs);
  const timeMs = useDebounced(rawTime, 600);
  // 경로가 바뀌었는지만 보면 되므로 좌표 전체 대신 요약값을 쓴다
  const planKey = plan ? `${plan.id}:${Math.round(plan.seconds)}` : "";

  useEffect(() => {
    if (!plan || plan.path.length < 2) {
      if (useApp.getState().shelters.length) useApp.getState().setShelters([]);
      return;
    }
    const box = padBBox(bboxOfPoints(plan.path), 300);
    const ctl = new AbortController();
    const qs = new URLSearchParams({
      bbox: [box.minLng, box.minLat, box.maxLng, box.maxLat].map((v) => v.toFixed(5)).join(","),
      at: String(timeMs),
    });
    fetch(`/api/shelters?${qs}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.shelters) useApp.getState().setShelters(j.shelters as Shelter[]);
      })
      .catch(() => {
        /* 쉼터는 곁들이 정보라 실패해도 조용히 넘어간다 */
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, timeMs]);
}
