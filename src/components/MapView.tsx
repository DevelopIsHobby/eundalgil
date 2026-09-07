"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApp } from "@/lib/store";
import { useNaverScript } from "@/lib/useNaverScript";
import { useLatest } from "@/lib/useDebounced";
import { getSunState } from "@/lib/sun";
import { ShadeIndex, buildShadows, type ShadowPoly } from "@/lib/shadow";
import { fetchOsmBundle } from "@/lib/osm";
import type { LngLat } from "@/lib/geo";
import { MIN_DATA_ZOOM, REFETCH_PAD_M, DEFAULT_CENTER, DEFAULT_ZOOM } from "@/lib/config";
import MissingKeyNotice from "./MissingKeyNotice";

/** 지도 인스턴스를 다른 컴포넌트에서도 쓸 수 있게 모듈 스코프에 보관 */
let mapRef: naver.maps.Map | null = null;
export function getMap() {
  return mapRef;
}

const ROUTE_COLORS = {
  fast: { main: "#2E6FF2", dim: "#A9BEE8" },
  shade: { main: "#12B886", dim: "#A8DEC9" },
};

export default function MapView({ bottomInset = 0 }: { bottomInset?: number }) {
  const scriptState = useNaverScript();
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlaysRef = useRef<{ polylines: naver.maps.Polyline[]; markers: naver.maps.Marker[] }>({
    polylines: [],
    markers: [],
  });
  const lastFetchBBox = useRef<[number, number, number, number] | null>(null);
  const rafRef = useRef(0);

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

  /* ---------------- 캔버스 그리기 ---------------- */
  const draw = useCallback(() => {
    const map = mapRef;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;

    const size = map.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(size.width * dpr) || canvas.height !== Math.round(size.height * dpr)) {
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const polys = shadowsRef.current;
    if (!polys.length) return;

    const proj = map.getProjection();
    const c = proj.fromCoordToOffset(map.getCenter());
    const ox = c.x - size.width / 2;
    const oy = c.y - size.height / 2;

    const project = (p: LngLat) => {
      const o = proj.fromCoordToOffset(new naver.maps.LatLng(p[1], p[0]));
      return [o.x - ox, o.y - oy] as const;
    };

    const drawGroup = (kind: "building" | "tree", fill: string) => {
      ctx.beginPath();
      let any = false;
      for (const poly of polys) {
        if (poly.kind !== kind) continue;
        // 화면 밖 폴리곤은 건너뛴다
        const a = project([poly.bbox.minLng, poly.bbox.maxLat]);
        const b = project([poly.bbox.maxLng, poly.bbox.minLat]);
        if (b[0] < -60 || a[0] > size.width + 60 || b[1] < -60 || a[1] > size.height + 60) continue;

        const ring = poly.ring;
        const first = project(ring[0]);
        ctx.moveTo(first[0], first[1]);
        for (let i = 1; i < ring.length; i++) {
          const q = project(ring[i]);
          ctx.lineTo(q[0], q[1]);
        }
        ctx.closePath();
        any = true;
      }
      if (!any) return;
      ctx.fillStyle = fill;
      ctx.fill();
    };

    // 겹침이 누적되지 않도록 종류별로 한 번씩만 채운다
    drawGroup("tree", "rgba(24, 90, 60, 0.20)");
    drawGroup("building", "rgba(28, 42, 66, 0.28)");
  }, [shadowsRef]);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    scheduleDraw();
  }, [shadows, scheduleDraw]);

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
    const sw = b.getSW();
    const ne = b.getNE();
    const bbox: [number, number, number, number] = [sw.lng(), sw.lat(), ne.lng(), ne.lat()];

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
    if (scriptState !== "ready" || !holder.current || mapRef) return;

    const s = latest.current;
    const map = new naver.maps.Map(holder.current, {
      center: new naver.maps.LatLng(s.center[1], s.center[0]),
      zoom: s.zoom || DEFAULT_ZOOM,
      minZoom: 10,
      maxZoom: 20,
      zoomControl: false,
      mapDataControl: false,
      scaleControl: false,
      logoControl: true,
      logoControlOptions: { position: 3 /* BOTTOM_LEFT */ },
      tileTransition: true,
    });
    mapRef = map;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const onIdle = () => {
      const c = map.getCenter();
      latest.current.setCenter([c.lng(), c.lat()], map.getZoom());
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(maybeFetch, 350);
    };

    const listeners = [
      naver.maps.Event.addListener(map, "idle", onIdle),
      naver.maps.Event.addListener(map, "bounds_changed", scheduleDraw),
      naver.maps.Event.addListener(map, "zoom_changed", scheduleDraw),
      naver.maps.Event.addListener(map, "click", (e: any) => {
        const st = latest.current;
        const p: LngLat = [e.coord.lng(), e.coord.lat()];
        if (st.screen === "browse") return;
        if (!st.origin) st.setOrigin({ name: "지도에서 선택한 지점", p });
        else st.setDestination({ name: "지도에서 선택한 지점", p });
      }),
    ];

    onIdle();
    scheduleDraw();

    return () => {
      listeners.forEach((l) => naver.maps.Event.removeListener(l));
      if (idleTimer) clearTimeout(idleTimer);
      map.destroy();
      mapRef = null;
    };
  }, [scriptState, latest, maybeFetch, scheduleDraw]);

  /* ---------------- 하단 시트 높이만큼 지도 여백 ---------------- */
  useEffect(() => {
    if (!mapRef) return;
    try {
      mapRef.setOptions("padding", { bottom: bottomInset });
    } catch {
      /* 구버전 SDK 호환 */
    }
  }, [bottomInset, scriptState]);

  /* ---------------- 외부에서 center가 바뀌면 지도 이동 ---------------- */
  const wantedCenter = store.center;
  const wantedZoom = store.zoom;
  useEffect(() => {
    const map = mapRef;
    if (!map) return;
    const c = map.getCenter();
    const moved = Math.abs(c.lng() - wantedCenter[0]) > 1e-6 || Math.abs(c.lat() - wantedCenter[1]) > 1e-6;
    if (moved) map.panTo(new naver.maps.LatLng(wantedCenter[1], wantedCenter[0]));
    if (map.getZoom() !== wantedZoom) map.setZoom(wantedZoom, true);
    // center/zoom 은 지도 idle 에서도 갱신되므로 여기서는 외부 변경만 반영한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedCenter[0], wantedCenter[1], wantedZoom]);

  /* ---------------- 경로 · 마커 렌더 ---------------- */
  const { routes, selectedRoute, origin, destination, screen } = store;
  useEffect(() => {
    const map = mapRef;
    if (!map) return;

    overlaysRef.current.polylines.forEach((p) => p.setMap(null));
    overlaysRef.current.markers.forEach((m) => m.setMap(null));
    overlaysRef.current = { polylines: [], markers: [] };

    const push = (p: naver.maps.Polyline) => overlaysRef.current.polylines.push(p);
    const toLatLngs = (path: LngLat[]) => path.map((c) => new naver.maps.LatLng(c[1], c[0]));

    // 선택되지 않은 경로를 먼저(아래에) 그린다
    const ordered = [...routes].sort((a, b) =>
      a.id === selectedRoute ? 1 : b.id === selectedRoute ? -1 : 0
    );

    for (const r of ordered) {
      const active = r.id === selectedRoute;
      const color = ROUTE_COLORS[r.id];
      push(
        new naver.maps.Polyline({
          map,
          path: toLatLngs(r.path),
          strokeColor: "#FFFFFF",
          strokeWeight: active ? 10 : 8,
          strokeOpacity: active ? 0.95 : 0.6,
          strokeLineCap: "round",
          strokeLineJoin: "round",
          zIndex: active ? 50 : 20,
        })
      );

      if (!active) {
        push(
          new naver.maps.Polyline({
            map,
            path: toLatLngs(r.path),
            strokeColor: color.dim,
            strokeWeight: 5,
            strokeOpacity: 0.9,
            strokeLineCap: "round",
            strokeLineJoin: "round",
            zIndex: 21,
          })
        );
        continue;
      }

      // 선택된 경로는 그늘/햇빛 구간을 나눠 칠한다
      for (const seg of r.segments) {
        if (seg.path.length < 2) continue;
        const shady = seg.shade >= 0.5;
        push(
          new naver.maps.Polyline({
            map,
            path: toLatLngs(seg.path),
            strokeColor: shady ? color.main : "#F5A524",
            strokeWeight: 6,
            strokeOpacity: 1,
            strokeStyle: shady ? "solid" : "shortdash",
            strokeLineCap: "round",
            strokeLineJoin: "round",
            zIndex: 51,
          })
        );
      }
    }

    const addPin = (p: LngLat, kind: "start" | "end") => {
      const isStart = kind === "start";
      const marker = new naver.maps.Marker({
        map,
        position: new naver.maps.LatLng(p[1], p[0]),
        zIndex: 100,
        icon: {
          content: `<div style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center">
            <div style="background:${isStart ? "#0FA958" : "#2E6FF2"};color:#fff;font-size:11px;font-weight:700;
                        padding:3px 8px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap">
              ${isStart ? "출발" : "도착"}
            </div>
            <div style="width:2px;height:8px;background:${isStart ? "#0FA958" : "#2E6FF2"}"></div>
            <div style="width:10px;height:10px;border-radius:50%;background:#fff;
                        border:3px solid ${isStart ? "#0FA958" : "#2E6FF2"};box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>
          </div>`,
        },
      });
      overlaysRef.current.markers.push(marker);
    };

    if (screen !== "browse") {
      if (origin) addPin(origin.p, "start");
      if (destination) addPin(destination.p, "end");
    }

    return () => {
      overlaysRef.current.polylines.forEach((p) => p.setMap(null));
      overlaysRef.current.markers.forEach((m) => m.setMap(null));
      overlaysRef.current = { polylines: [], markers: [] };
    };
  }, [routes, selectedRoute, origin, destination, screen, scriptState]);

  if (scriptState === "missing-key") return <MissingKeyNotice />;

  return (
    <div className="map-root absolute inset-0">
      <div ref={holder} className="absolute inset-0" />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />
      {scriptState === "error" && (
        <div className="absolute inset-x-4 top-1/2 rounded-xl bg-white p-4 text-sm shadow-card">
          네이버 지도를 불러오지 못했습니다. 등록한 <b>Web 서비스 URL</b>에 현재 주소가 포함되어 있는지
          확인해 주세요.
        </div>
      )}
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
