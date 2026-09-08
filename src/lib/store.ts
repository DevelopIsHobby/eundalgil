"use client";

import { create } from "zustand";
import type { LngLat } from "./geo";
import type { OsmBundle } from "./osm";
import type { RouteOption } from "./router";
import { DEFAULT_CENTER, DEFAULT_ZOOM, ShadePresetId } from "./config";
import type { BasemapId } from "./basemap";

export type Place = { name: string; address?: string; p: LngLat };

export type Screen = "browse" | "routeInput" | "routeResult";

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

  shadePreset: ShadePresetId;
  avoidSteps: boolean;
  showShadow: boolean;
  showTrees: boolean;

  data: OsmBundle | null;
  dataLoading: boolean;
  dataError: string | null;

  routes: RouteOption[];
  routeError: string | null;
  routing: boolean;
  selectedRoute: RouteOption["id"] | null;

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
  setShadePreset: (id: ShadePresetId) => void;
  toggle: (k: "avoidSteps" | "showShadow" | "showTrees") => void;
  setData: (d: OsmBundle | null) => void;
  setDataLoading: (v: boolean) => void;
  setDataError: (v: string | null) => void;
  setRoutes: (r: RouteOption[], err?: string | null) => void;
  setRouting: (v: boolean) => void;
  selectRoute: (id: RouteOption["id"]) => void;
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

  shadePreset: "mild",
  avoidSteps: false,
  showShadow: true,
  showTrees: true,

  data: null,
  dataLoading: false,
  dataError: null,

  routes: [],
  routeError: null,
  routing: false,
  selectedRoute: null,

  toast: null,

  setScreen: (screen) => set({ screen }),
  setCenter: (center, zoom) => set(zoom == null ? { center } : { center, zoom }),
  setBasemap: (basemap) => set({ basemap }),
  setTime: (timeMs, follow = false) => set({ timeMs, followNow: follow }),
  setOrigin: (origin) => set({ origin }),
  setDestination: (destination) => set({ destination }),
  swapEnds: () => set({ origin: get().destination, destination: get().origin }),
  setShadePreset: (shadePreset) => set({ shadePreset }),
  toggle: (k) => set({ [k]: !get()[k] } as Partial<State>),
  setData: (data) => set({ data }),
  setDataLoading: (dataLoading) => set({ dataLoading }),
  setDataError: (dataError) => set({ dataError }),
  setRoutes: (routes, routeError = null) =>
    set({
      routes,
      routeError,
      selectedRoute: routes.find((r) => r.id === "shade")?.id ?? routes[0]?.id ?? null,
    }),
  setRouting: (routing) => set({ routing }),
  selectRoute: (selectedRoute) => set({ selectedRoute }),
  showToast: (toast) => set({ toast }),
  reset: () =>
    set({
      screen: "browse",
      origin: null,
      destination: null,
      routes: [],
      routeError: null,
      selectedRoute: null,
    }),
}));
