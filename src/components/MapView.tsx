"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Map as MapLibreMap, Marker, type GeoJSONSource, type LayerSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useApp } from "@/lib/store";
import { useLatest } from "@/lib/useDebounced";
import { getSunState } from "@/lib/sun";
import { ShadeIndex, buildShadows, type ShadowPoly } from "@/lib/shadow";
import { fetchOsmBundle } from "@/lib/osm";
import { distMeters, pathLength, type LngLat } from "@/lib/geo";
import type { RouteOption } from "@/lib/router";
import { MIN_DATA_ZOOM, REFETCH_PAD_M, DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/config";
import { basemapStyle, EXTRA_ATTRIBUTION } from "@/lib/basemap";

/** 지도 인스턴스를 다른 컴포넌트에서도 쓸 수 있게 모듈 스코프에 보관 */
let mapRef: MapLibreMap | null = null;
export function getMap() {
  return mapRef;
}

const ROUTE_SRC = "eundalgil-routes";

const ROUTE_COLOR: Record<RouteOption["id"], string> = { fast: "#2E6FF2", shade: "#00A86B" };
const ROUTE_COLOR_DIM: Record<RouteOption["id"], string> = { fast: "#9DB6E6", shade: "#8FD3B6" };

const COLOR_MAIN = ["match", ["get", "rid"], "shade", ROUTE_COLOR.shade, ROUTE_COLOR.fast] as const;
const COLOR_DIM = ["match", ["get", "rid"], "shade", ROUTE_COLOR_DIM.shade, ROUTE_COLOR_DIM.fast] as const;

/**
 * 경로 굵기는 줌에 따라 키운다. 고정 폭이면 넓게 볼 때 실처럼 가늘어져
 * 어느 길인지 알아보기 어렵다. (아래 숫자는 줌, 위 숫자는 px)
 */
const widthAt = (z12: number, z16: number, z19: number) =>
  ["interpolate", ["linear"], ["zoom"], 12, z12, 16, z16, 19, z19] as const;

/**
 * 경로는 아래에서 위로 겹쳐 그린다.
 * 선택되지 않은 경로(테두리 → 본선)를 먼저 깔고, 선택된 경로를 그 위에 올린다.
 */
const ROUTE_LAYERS: LayerSpecification[] = [
  {
    id: "route-casing-dim",
    type: "line",
    source: ROUTE_SRC,
    filter: ["all", ["==", ["get", "role"], "casing"], ["==", ["get", "active"], 0]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#FFFFFF", "line-width": widthAt(6, 11, 17) as never, "line-opacity": 0.7 },
  },
  {
    id: "route-dim",
    type: "line",
    source: ROUTE_SRC,
    filter: ["==", ["get", "role"], "dim"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLOR_DIM as never, "line-width": widthAt(4, 7, 11) as never, "line-opacity": 0.95 },
  },
  {
    id: "route-casing-active",
    type: "line",
    source: ROUTE_SRC,
    filter: ["all", ["==", ["get", "role"], "casing"], ["==", ["get", "active"], 1]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#FFFFFF", "line-width": widthAt(9, 15, 23) as never, "line-opacity": 1 },
  },
  {
    id: "route-seg-shade",
    type: "line",
    source: ROUTE_SRC,
    filter: ["all", ["==", ["get", "role"], "seg"], ["==", ["get", "shady"], 1]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COLOR_MAIN as never, "line-width": widthAt(6, 10, 16) as never },
  },
  {
    // 햇빛 구간도 같은 굵기의 실선으로 깔아 경로가 끊겨 보이지 않게 한다
    id: "route-seg-sun",
    type: "line",
    source: ROUTE_SRC,
    filter: ["all", ["==", ["get", "role"], "seg"], ["==", ["get", "shady"], 0]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#F5A524", "line-width": widthAt(6, 10, 16) as never },
  },
  {
    // 그 위에 흰 파선을 얹어 "여기는 햇빛" 을 표시한다. 파선은 round cap 과 같이 쓰면
    // 뭉개져서 butt 로 둔다
    id: "route-seg-sun-hatch",
    type: "line",
    source: ROUTE_SRC,
    filter: ["all", ["==", ["get", "role"], "seg"], ["==", ["get", "shady"], 0]],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": "#FFFFFF",
      "line-width": widthAt(3, 5, 8) as never,
      "line-opacity": 0.75,
      "line-dasharray": [1.1, 1.4],
    },
  },
];

type RouteProps = { role: "casing" | "dim" | "seg"; rid: string; active: number; shady: number };
type RouteFC = GeoJSON.FeatureCollection<GeoJSON.LineString, RouteProps>;

const EMPTY_FC: RouteFC = { type: "FeatureCollection", features: [] };

function buildRouteFC(routes: RouteOption[], selected: RouteOption["id"] | null): RouteFC {
  const features: RouteFC["features"] = [];
  const line = (path: LngLat[], props: RouteProps) => {
    if (path.length < 2) return;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: path as number[][] },
      properties: props,
    });
  };

  for (const r of routes) {
    const active = r.id === selected;
    line(r.path, { role: "casing", rid: r.id, active: active ? 1 : 0, shady: 0 });
    if (!active) {
      line(r.path, { role: "dim", rid: r.id, active: 0, shady: 0 });
      continue;
    }
    // 선택된 경로만 그늘/햇빛 구간을 나눠 칠한다
    for (const seg of r.segments) {
      line(seg.path, { role: "seg", rid: r.id, active: 1, shady: seg.shade >= 0.5 ? 1 : 0 });
    }
  }
  return { type: "FeatureCollection", features };
}

/**
 * 스타일이 바뀌면 소스·레이어가 통째로 날아가므로 매번 다시 붙인다.
 * 스타일이 준비됐는지는 호출하는 쪽에서 style.load 로 판단한다.
 * (map.isStyleLoaded() 는 타일 소스가 하나라도 로딩 중이면 false 라 여기 쓰기엔 너무 엄격하다)
 */
function applyRoutes(map: MapLibreMap, fc: RouteFC) {
  const src = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
  if (src) {
    src.setData(fc);
    return;
  }
  map.addSource(ROUTE_SRC, { type: "geojson", data: fc });
  for (const layer of ROUTE_LAYERS) map.addLayer(layer);
}

/** 지도 위 말풍선에 쓰는 이름. 시트의 "최단"·"그늘" 배지보다 길게 풀어 쓴다 */
const ROUTE_LABEL: Record<RouteOption["id"], string> = {
  fast: "최단 경로",
  shade: "그늘 많은 길",
};

/**
 * 말풍선·출발/도착 핀은 좌표 위로 솟는다. 그 높이만큼 지도 위쪽에 여유를 두지 않으면
 * 경로를 화면에 맞출 때 꼭지가 상단 UI 뒤로 잘린다.
 */
const MARKER_HEADROOM = 44;

/**
 * 경로 위 `frac` 지점(길이 기준)의 좌표.
 * 두 경로의 말풍선이 겹치지 않게 서로 다른 지점에 놓으려고 쓴다.
 */
function pointAlong(path: LngLat[], frac: number): LngLat | null {
  if (path.length < 2) return path[0] ?? null;
  const total = pathLength(path);
  if (total <= 0) return path[0];
  const target = total * frac;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = distMeters(path[i - 1], path[i]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      return [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      ];
    }
    acc += seg;
  }
  return path[path.length - 1];
}

function makeRouteLabelElement(text: string, color: string, active: boolean) {
  const el = document.createElement("div");
  // 눌러서 경로를 고를 수 있어야 하므로 이것만 클릭을 받는다
  el.style.cssText = "cursor:pointer;transform:translateY(-6px)";
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div style="background:${active ? color : "#FFFFFF"};color:${active ? "#fff" : color};
                  border:${active ? "none" : `1.5px solid ${color}`};
                  font-size:12px;font-weight:700;letter-spacing:-0.2px;
                  padding:5px 10px;border-radius:999px;white-space:nowrap;
                  box-shadow:0 2px 8px rgba(0,0,0,.22)">${text}</div>
      <div style="width:0;height:0;margin-top:-1px;
                  border-left:5px solid transparent;border-right:5px solid transparent;
                  border-top:6px solid ${active ? color : "#FFFFFF"}"></div>
    </div>`;
  return el;
}

function makePinElement(kind: "start" | "end") {
  const isStart = kind === "start";
  const color = isStart ? "#0FA958" : "#2E6FF2";
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;align-items:center;pointer-events:none";
  el.innerHTML = `
    <div style="background:${color};color:#fff;font-size:11px;font-weight:700;
                padding:3px 8px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap">
      ${isStart ? "출발" : "도착"}
    </div>
    <div style="width:2px;height:8px;background:${color}"></div>
    <div style="width:10px;height:10px;border-radius:50%;background:#fff;
                border:3px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`;
  return el;
}

export default function MapView({
  topInset = 0,
  bottomInset = 0,
}: {
  topInset?: number;
  bottomInset?: number;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markersRef = useRef<Marker[]>([]);
  const labelMarkersRef = useRef<Marker[]>([]);
  const routeFCRef = useRef<RouteFC>(EMPTY_FC);
  /** 스타일이 올라와 소스·레이어를 붙여도 되는 상태인지 */
  const styleReady = useRef(false);
  const lastFetchBBox = useRef<[number, number, number, number] | null>(null);

  const store = useApp();
  const latest = useLatest(store);

  /* ---------------- 그림자 계산 ---------------- */
  const shadows: ShadowPoly[] = useMemo(() => {
    if (!store.data || !store.showShadow) return [];
    const sun = getSunState(new Date(store.timeMs), store.center);
    if (!sun.isDay) return [];
    return buildShadows(store.data.buildings, store.showTrees ? store.data.trees : [], sun);
  }, [store.data, store.timeMs, store.center, store.showShadow, store.showTrees]);

  const shadowsRef = useLatest(shadows);

  /* ---------------- 캔버스 그리기 ----------------
   * 그림자는 서로 많이 겹친다. GL fill 레이어로 그리면 겹친 곳이 겹친 횟수만큼
   * 어두워져 얼룩덜룩해지므로, 하나의 path 에 모아 nonzero 규칙으로 한 번만 채운다.
   * 지도와 어긋나지 않도록 MapLibre 의 render 프레임 안에서 동기적으로 그린다.
   */
  const draw = useCallback(() => {
    const map = mapRef;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;

    const glCanvas = map.getCanvas();
    const width = glCanvas.clientWidth;
    const height = glCanvas.clientHeight;
    if (!width || !height) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const polys = shadowsRef.current;
    if (!polys.length) return;

    const drawGroup = (kind: "building" | "tree", fill: string) => {
      ctx.beginPath();
      let any = false;
      for (const poly of polys) {
        if (poly.kind !== kind) continue;
        // 화면 밖 폴리곤은 건너뛴다
        const a = map.project([poly.bbox.minLng, poly.bbox.maxLat]);
        const b = map.project([poly.bbox.maxLng, poly.bbox.minLat]);
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        if (maxX < -60 || minX > width + 60 || maxY < -60 || minY > height + 60) continue;

        const ring = poly.ring;
        const first = map.project(ring[0] as [number, number]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < ring.length; i++) {
          const q = map.project(ring[i] as [number, number]);
          ctx.lineTo(q.x, q.y);
        }
        ctx.closePath();
        any = true;
      }
      if (!any) return;
      ctx.fillStyle = fill;
      ctx.fill();
    };

    // 겹침이 누적되지 않도록 종류별로 한 번씩만 채운다.
    // 캔버스가 mix-blend-mode:multiply 로 지도에 곱해지므로, 여기 색은 "덧칠할 색" 이 아니라
    // "빛을 얼마나 깎을지" 에 가깝다. 그래서 반투명 회색 대신 제법 진한 색을 쓴다.
    drawGroup("tree", "rgba(122, 176, 142, 0.45)");
    drawGroup("building", "rgba(112, 128, 170, 0.5)");
  }, [shadowsRef]);

  const drawRef = useLatest(draw);

  /* 그림자가 바뀌면 한 프레임을 더 요청해 다시 그리게 한다 */
  useEffect(() => {
    mapRef?.triggerRepaint();
  }, [shadows]);

  /* ---------------- 데이터 로딩 ---------------- */
  const maybeFetch = useCallback(async () => {
    const map = mapRef;
    if (!map) return;
    const s = latest.current;
    if (map.getZoom() < MIN_DATA_ZOOM) {
      lastFetchBBox.current = null;
      return;
    }

    const b = map.getBounds();
    const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    const prev = lastFetchBBox.current;
    if (prev) {
      const padLng = REFETCH_PAD_M / 88000;
      const padLat = REFETCH_PAD_M / 110574;
      const inside =
        bbox[0] > prev[0] + padLng &&
        bbox[1] > prev[1] + padLat &&
        bbox[2] < prev[2] - padLng &&
        bbox[3] < prev[3] - padLat;
      if (inside) return;
    }

    // 화면보다 조금 넓게 받아 두면 살짝 움직일 때 다시 받지 않는다
    const padLng = (bbox[2] - bbox[0]) * 0.35;
    const padLat = (bbox[3] - bbox[1]) * 0.35;
    const wide: [number, number, number, number] = [
      bbox[0] - padLng,
      bbox[1] - padLat,
      bbox[2] + padLng,
      bbox[3] + padLat,
    ];

    lastFetchBBox.current = wide;
    s.setDataLoading(true);
    s.setDataError(null);
    try {
      const bundle = await fetchOsmBundle(wide);
      latest.current.setData(bundle);
    } catch (err) {
      lastFetchBBox.current = null;
      latest.current.setDataError((err as Error).message);
    } finally {
      latest.current.setDataLoading(false);
    }
  }, [latest]);

  /* ---------------- 지도 생성 ---------------- */
  useEffect(() => {
    if (!holder.current || mapRef) return;

    // 새 지도는 스타일이 아직 없다. 이전 지도에서 넘어온 값을 그대로 두면
    // 스타일이 오기 전에 소스를 붙이려다 "Style is not done loading" 이 난다
    styleReady.current = false;

    const s = latest.current;
    const map = new MapLibreMap({
      container: holder.current,
      style: basemapStyle(s.basemap),
      center: s.center,
      zoom: s.zoom || DEFAULT_ZOOM,
      minZoom: 9,
      maxZoom: 19,
      // 기울이면 그림자 캔버스와 지도가 서로 다른 평면에 놓여 어색해진다
      pitchWithRotate: false,
      touchPitch: false,
      // 두 번 누르기는 확대가 아니라 "여기를 도착지로" 에 쓴다 (확대는 손가락 벌리기·휠)
      doubleClickZoom: false,
      attributionControl: { compact: true, customAttribution: EXTRA_ATTRIBUTION },
    });
    mapRef = map;

    /**
     * 컨테이너가 아직 0×0 인 순간에 지도가 만들어지면 MapLibre 는 400×300 을 임시로 쓴다.
     * 그런데 내부 ResizeObserver 는 첫 관측을 건너뛰기 때문에, 곧이어 진짜 크기가 잡혀도
     * 그 콜백이 무시되고 캔버스가 400×300 에 그대로 굳는다. 레이아웃이 끝난 다음 프레임에
     * 한 번 맞춰 주면 이후 크기 변화는 MapLibre 가 알아서 따라간다.
     */
    const sizeFix = requestAnimationFrame(() => map.resize());

    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const onIdle = () => {
      const c = map.getCenter();
      latest.current.setCenter([c.lng, c.lat], map.getZoom());
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(maybeFetch, 350);
    };

    // 지도와 그림자 캔버스를 같은 프레임에 그려 이동 중에도 어긋나지 않게 한다
    const onRender = () => drawRef.current();

    const onStyleLoad = () => {
      styleReady.current = true;
      applyRoutes(map, routeFCRef.current);
      drawRef.current();
    };

    /**
     * 지도를 눌러 출발·도착을 찍는 건 **아직 안 채운 칸이 있을 때만** 이다.
     * 예전에는 이미 정해진 도착지도 아무 데나 누르면 그리로 바뀌어서,
     * 경로를 보려고 지도를 만지기만 해도 목적지가 날아갔다.
     * 바꾸고 싶으면 위쪽 입력칸을 눌러 다시 고르면 된다.
     */
    const PICKED = "지도에서 선택한 지점";

    // 한 번 누른 건 곧바로 처리하지 않는다. 두 번 누르기인지 지켜봐야 하기 때문이다
    let singleTap: ReturnType<typeof setTimeout> | null = null;

    const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (singleTap) clearTimeout(singleTap);
      singleTap = setTimeout(() => {
        singleTap = null;
        const st = latest.current;
        if (st.screen !== "routeInput") return;
        // 이미 정해진 지점은 한 번 눌러서 바꾸지 않는다 (두 번 누르기로 바꾼다)
        if (st.origin && st.destination) return;
        if (!st.origin) st.setOrigin({ name: PICKED, p });
        else st.setDestination({ name: PICKED, p });
      }, 260);
    };

    /** 두 번 누르면 그 자리를 도착지로 삼는다 — 이미 도착지가 있어도 갈아끼운다 */
    const onDblClick = (e: { lngLat: { lng: number; lat: number } }) => {
      if (singleTap) clearTimeout(singleTap);
      singleTap = null;
      const st = latest.current;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      st.setDestination({ name: PICKED, p });
      if (st.screen === "browse") st.setScreen("routeInput");
    };

    // 지도 내부 오류는 조용히 삼켜지므로 콘솔에는 남긴다
    map.on("error", (e) => console.error("[maplibre]", e.error ?? e));
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __map?: MapLibreMap }).__map = map;
    }

    map.on("style.load", onStyleLoad);
    map.on("render", onRender);
    map.on("idle", onIdle);
    map.on("click", onClick);
    map.on("dblclick", onDblClick);

    return () => {
      cancelAnimationFrame(sizeFix);
      if (idleTimer) clearTimeout(idleTimer);
      map.off("style.load", onStyleLoad);
      map.off("render", onRender);
      map.off("idle", onIdle);
      if (singleTap) clearTimeout(singleTap);
      map.off("click", onClick);
      map.off("dblclick", onDblClick);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      labelMarkersRef.current.forEach((m) => m.remove());
      labelMarkersRef.current = [];
      styleReady.current = false;
      map.remove();
      mapRef = null;
    };
  }, [latest, maybeFetch, drawRef]);

  /* ---------------- 배경지도 전환 ---------------- */
  const basemap = store.basemap;
  useEffect(() => {
    const map = mapRef;
    if (!map) return;
    // 첫 스타일은 생성자에서 이미 넣었다. 새 스타일이 올라오면 style.load 가 경로를 다시 붙인다
    styleReady.current = false;
    map.setStyle(basemapStyle(basemap));
  }, [basemap]);

  /* ---------------- 상·하단 UI에 가리지 않도록 지도 여백 ----------------
   * 지도 여백은 여기 한 곳에서만 정한다. 경로에 화면을 맞추는 쪽(page.tsx)도
   * 이 값을 그대로 받아 써야 계산한 화면과 실제 화면이 어긋나지 않는다.
   */
  useEffect(() => {
    const map = mapRef;
    if (!map) return;
    const padding = { top: topInset + MARKER_HEADROOM, right: 24, bottom: bottomInset, left: 24 };

    /**
     * setPadding 은 내부적으로 jumpTo → stop() 이라 **진행 중인 카메라 이동을 끊는다.**
     * 그래서 한때 "움직이는 중이면 미뤘다가 적용" 하게 해 봤는데, 이동이 잇따르면 미룬 게
     * 영영 반영되지 않아 여백이 옛 값에 굳었다. 여기서는 항상 즉시 적용하고,
     * 대신 지도를 옮기는 쪽(page.tsx 의 goTo)이 여백이 자리잡은 뒤에 움직이도록 했다.
     */
    map.setPadding(padding);
  }, [topInset, bottomInset]);

  /*
   * store.center 를 보고 지도를 따라 움직이는 효과는 두지 않는다.
   *
   * 예전에는 있었는데, 지도가 멈출 때마다 onIdle 이 **지금 좌표**를 store 에 되쓰기 때문에
   * 되먹임이 생겼다. 장소를 골라 easeTo 가 시작된 직후 묵은 idle 이 하나 끼어들면
   * store.center 가 옛 좌표로 되돌아가고, 그 효과가 그 값을 "새 목표" 로 착각해
   * 지도를 원래 자리로 도로 끌고 갔다. 데이터를 받는 중에는 idle 이 잦아 특히 잘 걸렸다.
   *
   * 그래서 방향을 하나로 고정한다 — store.center 는 지도가 보고하는 값(읽기 전용)이고,
   * 지도를 움직이는 쪽(page.tsx 의 goTo, MapControls 의 현재 위치, fitBounds)이
   * map 을 직접 부른다.
   */

  /* ---------------- 경로 렌더 ---------------- */
  const { routes, selectedRoute, origin, destination, screen } = store;
  useEffect(() => {
    const fc = buildRouteFC(routes, selectedRoute);
    routeFCRef.current = fc;
    const map = mapRef;
    if (map && styleReady.current) applyRoutes(map, fc);
  }, [routes, selectedRoute]);

  /* ---------------- 출발·도착 마커 ---------------- */
  useEffect(() => {
    const map = mapRef;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (screen === "browse") return;
    const add = (p: LngLat, kind: "start" | "end") => {
      const marker = new Marker({ element: makePinElement(kind), anchor: "bottom" })
        .setLngLat(p)
        .addTo(map);
      markersRef.current.push(marker);
    };
    if (origin) add(origin.p, "start");
    if (destination) add(destination.p, "end");

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
    };
  }, [origin, destination, screen]);

  /* ---------------- 경로 이름 말풍선 ---------------- */
  useEffect(() => {
    const map = mapRef;
    if (!map) return;

    labelMarkersRef.current.forEach((m) => m.remove());
    labelMarkersRef.current = [];

    // 경로가 둘이면 서로 다른 지점에 놓아 말풍선끼리 겹치지 않게 한다
    const fracs = routes.length > 1 ? [0.38, 0.62] : [0.5];

    routes.forEach((r, i) => {
      const at = pointAlong(r.path, fracs[i] ?? 0.5);
      if (!at) return;
      const active = r.id === selectedRoute;
      const el = makeRouteLabelElement(ROUTE_LABEL[r.id], ROUTE_COLOR[r.id], active);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        useApp.getState().selectRoute(r.id);
      });
      const marker = new Marker({ element: el, anchor: "bottom" }).setLngLat(at).addTo(map);
      labelMarkersRef.current.push(marker);
    });

    return () => {
      labelMarkersRef.current.forEach((m) => m.remove());
      labelMarkersRef.current = [];
    };
  }, [routes, selectedRoute]);

  return (
    <div className="map-root absolute inset-0">
      {/* MapLibre 가 컨테이너에 .maplibregl-map(position:relative)을 얹어 absolute 를 덮으므로
          위치 대신 크기로 채운다 */}
      <div ref={holder} className="h-full w-full" />
      {/* 곱셈 합성이라 지도를 덮는 대신 어둡게만 만든다 — 그늘 아래 글씨·길이 그대로 읽힌다 */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
        style={{ mixBlendMode: "multiply" }}
      />
    </div>
  );
}

/** 경로 계산에 쓸 그늘 인덱스를 만든다 (지도 밖에서도 재사용) */
export function makeShadeIndex(
  buildings: Parameters<typeof buildShadows>[0],
  trees: Parameters<typeof buildShadows>[1],
  timeMs: number,
  center: LngLat
) {
  const sun = getSunState(new Date(timeMs), center);
  return new ShadeIndex(buildShadows(buildings, trees, sun), center[1]);
}

export { DEFAULT_CENTER };
