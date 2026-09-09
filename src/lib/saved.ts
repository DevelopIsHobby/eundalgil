"use client";

import type { Place } from "./store";

/**
 * 저장한 길. 출발·도착만 남긴다 — 경로 자체는 시각·취향·실시간에 따라 매번 달라지므로
 * 통째로 얼려 두면 오히려 틀린 안내가 된다. 다시 열면 그때 기준으로 새로 찾는다.
 */
export type SavedTrip = {
  id: string;
  origin: Place;
  destination: Place;
  savedAt: number;
};

const KEY = "eundalgil.saved.v1";
const MAX = 20;

/** 같은 구간인지 — 이름이 달라도 좌표가 30m 안이면 같은 것으로 본다 */
export function tripId(origin: Place, destination: Place) {
  const at = (p: Place) => `${p.p[0].toFixed(4)},${p.p[1].toFixed(4)}`;
  return `${at(origin)}>${at(destination)}`;
}

export function loadSaved(): SavedTrip[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SavedTrip[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: SavedTrip[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 사파리 프라이빗 모드 등 — 저장 실패해도 앱은 그대로 돈다 */
  }
}

/** 저장돼 있으면 지우고, 없으면 넣는다. 바뀐 목록을 돌려준다 */
export function toggleSaved(origin: Place, destination: Place): SavedTrip[] {
  const id = tripId(origin, destination);
  const list = loadSaved();
  const without = list.filter((t) => t.id !== id);
  const next =
    without.length === list.length
      ? [{ id, origin, destination, savedAt: Date.now() }, ...without]
      : without;
  write(next);
  return next;
}

export function isSaved(list: SavedTrip[], origin: Place | null, destination: Place | null) {
  if (!origin || !destination) return false;
  const id = tripId(origin, destination);
  return list.some((t) => t.id === id);
}
