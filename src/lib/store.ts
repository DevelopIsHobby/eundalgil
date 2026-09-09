"use client";

import { create } from "zustand";
import type { LngLat } from "./geo";
import type { OsmBundle } from "./osm";
import type { PlanPair, PlanStyle } from "./plan";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from "./prefs";
import { DEFAULT_CENTER, DEFAULT_ZOOM } from "./config";
import type { BasemapId } from "./basemap";
import type { Shelter } from "./shelters";
import type { SeatAdvice } from "./seat";
import type { TransitStop } from "./transit";
import { loadSaved, toggleSaved, type SavedTrip } from "./saved";

export type Place = { name: string; address?: string; p: LngLat };

export type Screen = "browse" | "routeInput" | "routeResult";

export type Weather = {
  tempC: number;
  /** 체감온도 — 그늘을 따질 때는 기온보다 이쪽이 본론이다 */
  feelsC: number;
  humidity: number;
  uv: number;
  label: string;
  code: number;
} | null;

type State = {
  screen: Screen;
  center: LngLat;
  zoom: number;
  /** 배경지도 종류 — 브이월드 키가 없으면 openfreemap 하나만 쓴다 */
  basemap: BasemapId;

  /** 기준 시각 (ms) */
  timeMs: number;
  followNow: boolean;

  origin: Place | null;
  destination: Place | null;

  /** 온보딩에서 고른 취향 — 경로 비용에 그대로 반영된다 */
  prefs: Prefs;
  onboarded: boolean;
  prefsOpen: boolean;

  showShadow: boolean;
  showTrees: boolean;

  data: OsmBundle | null;
  dataLoading: boolean;
  dataError: string | null;

  /** 이동 수단 조합별로 "그늘 우선 / 최단" 두 벌씩 */
  plans: PlanPair[];
  planIndex: number;
  planStyle: PlanStyle;
  planError: string | null;
  /** 경로 시트를 펼쳤는지 — 펼치면 지도 위 다른 UI 를 접어 자리를 낸다 */
  sheetExpanded: boolean;
  /** 결과와 함께 알려 줄 것들 (노선 데이터가 없다거나, 방범시설 정보가 성기다거나) */
  notices: string[];
  routing: boolean;

  weather: Weather;
  /** 지금 보고 있는 여정 주변의 무더위쉼터 */
  shelters: Shelter[];
  /** 이 구간에서 찾은 정류장 — 지도에 점으로 뿌린다 */
  transitStops: TransitStop[];
  /** 같은 길을 이따 걸으면 더 시원할 때, 그 시각 */
  departure: { atMs: number; shade: number; nowShade: number } | null;
  /** 저장한 길 (출발·도착만 남긴다) */
  saved: SavedTrip[];
  /**
   * 건물 그늘까지 넣어 다시 계산한 자리 추천. `${planId}:${구간번호}` 로 찾는다.
   * 경로가 나온 뒤에 덧칠하는 값이라 여정 자체는 그대로 두고 옆에 둔다.
   */
  seatOverrides: Record<string, SeatAdvice>;
  /** 길 안내 중인지 */
  guiding: boolean;
  toast: string | null;
};

type Actions = {
  setScreen: (s: Screen) => void;
  setCenter: (c: LngLat, zoom?: number) => void;
  setBasemap: (id: BasemapId) => void;
  setTime: (ms: number, follow?: boolean) => void;
  setOrigin: (p: Place | null) => void;
  setDestination: (p: Place | null) => void;
  swapEnds: () => void;

  hydratePrefs: () => void;
  setPrefs: (p: Partial<Prefs>) => void;
  finishOnboarding: () => void;
  openPrefs: (v: boolean) => void;

  toggle: (k: "showShadow" | "showTrees") => void;
  setData: (d: OsmBundle | null) => void;
  setDataLoading: (v: boolean) => void;
  setDataError: (v: string | null) => void;

  setPlans: (plans: PlanPair[], err?: string | null, notices?: string[]) => void;
  selectPlan: (i: number) => void;
  setPlanStyle: (s: PlanStyle) => void;
  setSheetExpanded: (v: boolean) => void;
  setRouting: (v: boolean) => void;

  setWeather: (w: Weather) => void;
  setShelters: (s: Shelter[]) => void;
  setTransitStops: (s: TransitStop[]) => void;
  setDeparture: (d: { atMs: number; shade: number; nowShade: number } | null) => void;
  hydrateSaved: () => void;
  setSeatOverride: (key: string, advice: SeatAdvice) => void;
  toggleSave: () => void;
  setGuiding: (v: boolean) => void;
  showToast: (msg: string | null) => void;
  reset: () => void;
};

export const useApp = create<State & Actions>((set, get) => ({
  screen: "browse",
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  basemap: "openfreemap",

  timeMs: Date.now(),
  followNow: true,

  origin: null,
  destination: null,

  prefs: DEFAULT_PREFS,
  // 서버가 그린 HTML 과 어긋나지 않게 true 로 두고, 마운트 뒤 저장된 값으로 바꾼다
  onboarded: true,
  prefsOpen: false,

  showShadow: true,
  showTrees: true,

  data: null,
  dataLoading: false,
  dataError: null,

  plans: [],
  planIndex: 0,
  planStyle: "shade",
  planError: null,
  sheetExpanded: false,
  notices: [],
  routing: false,

  weather: null,
  shelters: [],
  transitStops: [],
  departure: null,
  saved: [],
  seatOverrides: {},
  guiding: false,
  toast: null,

  setScreen: (screen) => set({ screen }),
  setCenter: (center, zoom) => set(zoom == null ? { center } : { center, zoom }),
  setBasemap: (basemap) => set({ basemap }),
  setTime: (timeMs, follow = false) => set({ timeMs, followNow: follow }),
  setOrigin: (origin) => set({ origin }),
  setDestination: (destination) => set({ destination }),
  swapEnds: () => set({ origin: get().destination, destination: get().origin }),

  hydratePrefs: () => {
    const { prefs, onboarded } = loadPrefs();
    set({ prefs, onboarded, planStyle: prefs.sun === "sun" ? "fast" : "shade" });
  },
  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    savePrefs(prefs, get().onboarded);
  },
  finishOnboarding: () => {
    set({ onboarded: true });
    savePrefs(get().prefs, true);
  },
  openPrefs: (prefsOpen) => set({ prefsOpen }),

  toggle: (k) => set({ [k]: !get()[k] } as Partial<State>),
  setData: (data) => set({ data }),
  setDataLoading: (dataLoading) => set({ dataLoading }),
  setDataError: (dataError) => set({ dataError }),

  setPlans: (plans, planError = null, notices = []) =>
    set({ plans, planError, notices, planIndex: 0, seatOverrides: {} }),
  selectPlan: (planIndex) => set({ planIndex }),
  setPlanStyle: (planStyle) => set({ planStyle }),
  setSheetExpanded: (sheetExpanded) => set({ sheetExpanded }),
  setRouting: (routing) => set({ routing }),

  setWeather: (weather) => set({ weather }),
  setShelters: (shelters) => set({ shelters }),
  setTransitStops: (transitStops) => set({ transitStops }),
  setDeparture: (departure) => set({ departure }),
  hydrateSaved: () => set({ saved: loadSaved() }),
  setSeatOverride: (key, advice) =>
    set({ seatOverrides: { ...get().seatOverrides, [key]: advice } }),
  toggleSave: () => {
    const { origin, destination } = get();
    if (!origin || !destination) return;
    set({ saved: toggleSaved(origin, destination) });
  },
  setGuiding: (guiding) => set({ guiding }),
  showToast: (toast) => set({ toast }),
  reset: () =>
    set({
      screen: "browse",
      guiding: false,
      origin: null,
      destination: null,
      plans: [],
      planIndex: 0,
      planError: null,
      notices: [],
      transitStops: [],
    }),
}));

/** 지금 화면에 보여 줄 여정 (도보 스타일 토글까지 반영) */
export function useActivePlan() {
  return useApp((s) => {
    const pair = s.plans[s.planIndex];
    if (!pair) return null;
    return s.planStyle === "fast" ? pair.fast : pair.shade;
  });
}
