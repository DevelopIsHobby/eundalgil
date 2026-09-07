"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import MapView, { getMap } from "@/components/MapView";
import TopBar from "@/components/TopBar";
import TimeBar from "@/components/TimeBar";
import MapControls from "@/components/MapControls";
import BottomNav from "@/components/BottomNav";
import RouteHeader from "@/components/RouteHeader";
import RouteSheet from "@/components/RouteSheet";
import SearchOverlay from "@/components/SearchOverlay";
import Toast from "@/components/Toast";
import { useApp, type Place } from "@/lib/store";
import { useRouting } from "@/lib/useRouting";
import { MIN_DATA_ZOOM } from "@/lib/config";

type Editing = "origin" | "destination" | "browse" | null;

export default function Page() {
  const store = useApp();
  const [editing, setEditing] = useState<Editing>(null);
  const [bottomInset, setBottomInset] = useState(120);
  const bottomRef = useRef<HTMLDivElement>(null);

  useRouting();

  /* 하단 UI 높이를 재서 지도 중심 보정에 쓴다 */
  useLayoutEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBottomInset(el.offsetHeight));
    ro.observe(el);
    setBottomInset(el.offsetHeight);
    return () => ro.disconnect();
  }, []);

  /* 출발·도착이 모두 정해지면 결과 화면으로 */
  const { origin, destination, screen } = store;
  useEffect(() => {
    if (origin && destination && screen === "routeInput") {
      useApp.getState().setScreen("routeResult");
    }
  }, [origin, destination, screen]);

  /* 경로가 나오면 지도에 맞춰 보여준다 */
  const routeKey = store.routes.map((r) => r.id).join("|");
  useEffect(() => {
    const map = getMap();
    if (!map || !store.routes.length) return;
    const all = store.routes.flatMap((r) => r.path);
    if (all.length < 2) return;
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    for (const [lng, lat] of all) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    map.fitBounds(
      new naver.maps.LatLngBounds(
        new naver.maps.LatLng(minLat, minLng),
        new naver.maps.LatLng(maxLat, maxLng)
      ),
      { top: 130, right: 40, bottom: bottomInset + 24, left: 40 }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const useCurrentPosition = (which: "origin" | "destination") => {
    if (!navigator.geolocation) {
      store.showToast("이 브라우저에서는 위치를 쓸 수 없습니다.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const place: Place = {
          name: "현재 위치",
          p: [pos.coords.longitude, pos.coords.latitude],
        };
        if (which === "origin") store.setOrigin(place);
        else store.setDestination(place);
        setEditing(null);
      },
      () => store.showToast("위치 권한이 거부되었습니다.")
    );
  };

  const onPick = (p: Place) => {
    if (editing === "browse") {
      store.setCenter(p.p, 17);
      const map = getMap();
      if (map) map.setCenter(new naver.maps.LatLng(p.p[1], p.p[0]));
      store.setDestination(p);
      store.setScreen("routeInput");
    } else if (editing === "origin") {
      store.setOrigin(p);
    } else if (editing === "destination") {
      store.setDestination(p);
    }
    setEditing(null);
  };

  const zoomTooLow = store.zoom < MIN_DATA_ZOOM;

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[#EDF0F3]">
      <MapView bottomInset={bottomInset} />

      {/* 상단 chrome */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-30 mx-auto w-full max-w-[var(--app-max-w)]">
        {store.screen === "browse" ? (
          <TopBar onSearch={() => setEditing("browse")} />
        ) : (
          <RouteHeader
            onEdit={(w) => setEditing(w)}
            onClose={() => {
              store.reset();
            }}
          />
        )}

        {(store.dataLoading || store.dataError || zoomTooLow) && (
          <div className="mt-2 px-3">
            <div
              className={`pointer-events-auto animate-fade-up rounded-lg px-3 py-2 text-[12px] shadow-card ${
                store.dataError ? "bg-[#FFF3F1] text-[#C33C29]" : "bg-white/95 text-ink-500"
              }`}
            >
              {store.dataError
                ? store.dataError
                : zoomTooLow
                  ? "지도를 조금 더 확대하면 그늘을 계산합니다."
                  : "이 지역의 건물·가로수를 불러오는 중…"}
            </div>
          </div>
        )}
      </div>

      <Toast />

      {/* 하단 chrome */}
      <div
        ref={bottomRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[var(--app-max-w)]"
      >
        <MapControls bottom={bottomInset + 12} />

        <div className="pb-2">
          <TimeBar />
        </div>

        {store.screen === "routeResult" && <RouteSheet />}

        <BottomNav />
      </div>

      {editing && (
        <SearchOverlay
          title={
            editing === "origin"
              ? "출발지 검색"
              : editing === "destination"
                ? "도착지 검색"
                : "장소, 주소 검색"
          }
          initial=""
          onClose={() => setEditing(null)}
          onPick={onPick}
          onUseCurrent={
            editing === "browse"
              ? undefined
              : () => useCurrentPosition(editing as "origin" | "destination")
          }
        />
      )}
    </main>
  );
}
