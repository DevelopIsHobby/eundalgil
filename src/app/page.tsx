"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import MapView, { getMap } from "@/components/MapView";
import TopBar from "@/components/TopBar";
import MapControls from "@/components/MapControls";
import RouteHeader from "@/components/RouteHeader";
import PlanTabs from "@/components/PlanTabs";
import PlanSheet from "@/components/PlanSheet";
import PlaceCard from "@/components/PlaceCard";
import SearchOverlay from "@/components/SearchOverlay";
import Onboarding from "@/components/Onboarding";
import PrefsSheet from "@/components/PrefsSheet";
import WeatherCard, { useWeather } from "@/components/WeatherCard";
import GuideOverlay from "@/components/GuideOverlay";
import SavedTrips from "@/components/SavedTrips";
import Toast from "@/components/Toast";
import { useActivePlan, useApp, type Place } from "@/lib/store";
import { useRouting } from "@/lib/useRouting";
import { useShelters } from "@/lib/shelters";
import { MIN_DATA_ZOOM } from "@/lib/config";
import { IconWalk } from "@/components/icons";

/**
 * 시각 막대는 "지금"(Date.now)에서 출발하므로 서버에서 그린 HTML 과 어긋난다.
 * 그대로 두면 hydration 이 깨지면서 문서 전체가 새로 그려지고, 그때 지도까지 다시 만들어진다.
 * 클라이언트에서만 그리게 하고 자리만 미리 잡아 둔다.
 */
const TimeBar = dynamic(() => import("@/components/TimeBar"), {
  ssr: false,
  loading: () => <div className="mx-3 h-[86px] rounded-[22px] bg-white/95 shadow-card" />,
});

type Editing = "origin" | "destination" | "browse" | null;

export default function Page() {
  const store = useApp();
  const plan = useActivePlan();
  const [editing, setEditing] = useState<Editing>(null);
  /** 홈에서 검색해 고른 장소 — 출발/도착을 아직 안 정한 상태 */
  const [picked, setPicked] = useState<Place | null>(null);
  const [bottomInset, setBottomInset] = useState(120);
  const [topInset, setTopInset] = useState(110);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useRouting();
  useWeather();
  useShelters();

  /* 저장해 둔 취향을 불러온다 (서버 렌더와 어긋나지 않게 마운트 뒤에) */
  useEffect(() => {
    useApp.getState().hydratePrefs();
    useApp.getState().hydrateSaved();
    // 지도(window.__map)와 마찬가지로, 개발 중에 콘솔에서 상태를 들여다볼 수 있게 열어 둔다
    if (process.env.NODE_ENV === "development") {
      (window as unknown as { __app?: typeof useApp }).__app = useApp;
    }
  }, []);

  /* 상·하단 UI 높이를 재서 지도 여백에 쓴다 */
  useLayoutEffect(() => {
    const measure = (el: HTMLElement | null, set: (v: number) => void) => {
      if (!el) return () => {};
      const ro = new ResizeObserver(() => set(el.offsetHeight));
      ro.observe(el);
      set(el.offsetHeight);
      return () => ro.disconnect();
    };
    const offBottom = measure(bottomRef.current, setBottomInset);
    const offTop = measure(topRef.current, setTopInset);
    return () => {
      offBottom();
      offTop();
    };
  }, []);

  /* 출발·도착이 모두 정해지면 결과 화면으로 */
  const { origin, destination, screen } = store;
  useEffect(() => {
    if (origin && destination && screen === "routeInput") {
      useApp.getState().setScreen("routeResult");
    }
  }, [origin, destination, screen]);

  /* 경로가 나오면 지도에 맞춰 보여준다 */
  // 좌표를 섞어야 출발·도착을 바꿨을 때도 값이 달라져 다시 맞춘다
  const planKey = [
    origin?.p.join(","),
    destination?.p.join(","),
    plan?.id,
    plan ? Math.round(plan.seconds) : "",
  ].join("|");
  useEffect(() => {
    const map = getMap();
    if (!map || !plan || plan.path.length < 2) return;
    let minLng = Infinity,
      minLat = Infinity,
      maxLng = -Infinity,
      maxLat = -Infinity;
    for (const [lng, lat] of plan.path) {
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    // 시트가 펼쳐지며 지도 여백이 커지므로 그 값이 정해진 뒤에 맞춘다.
    // 여백은 MapView 가 정하니 여기서는 지도에 설정된 값을 그대로 받아 쓴다 —
    // 계산에 쓴 여백과 실제 여백이 다르면 경로가 UI 뒤로 밀린다.
    const t = setTimeout(() => {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: map.getPadding(), maxZoom: 17, duration: 600 }
      );
    }, 80);
    return () => clearTimeout(t);
    // 여백이 잇달아 바뀌면 타이머가 취소·재설정되며 마지막 값으로 한 번만 맞춘다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, topInset, bottomInset]);

  /**
   * 고른 지점으로 지도를 옮긴다. 경로가 나오면 곧이어 fitBounds 가 다시 잡아 준다.
   * store.center 는 건드리지 않는다 — 지도가 멈추면 그쪽에서 알아서 따라온다.
   * (여기서 같이 쓰면 묵은 idle 과 엇갈려 이동이 취소되던 문제가 있었다)
   */
  const goTo = (p: Place) => {
    const map = getMap();
    if (!map) {
      store.setCenter(p.p, 16);
      return;
    }
    /*
     * 장소를 고르면 화면이 바뀌면서(검색창 닫힘 → 경로 헤더 등장 → 시트 등장) 지도 여백이
     * 다시 잡힌다. 여백을 바꾸는 setPadding 은 내부적으로 jumpTo → stop() 이라
     * **막 시작한 이동을 끊어 버린다.** 그래서 여백이 자리잡은 다음에 움직인다.
     */
    setTimeout(() => getMap()?.easeTo({ center: p.p, zoom: 16, duration: 500 }), 150);
  };

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
        goTo(place);
        if (which === "origin") store.setOrigin(place);
        else store.setDestination(place);
        setEditing(null);
      },
      () => store.showToast("위치 권한이 거부되었습니다.")
    );
  };

  const onPick = (p: Place) => {
    goTo(p);
    if (editing === "browse") {
      // 홈에서 검색한 건 출발지일 수도 도착지일 수도 있다. 고르게 한다
      setPicked(p);
    } else if (editing === "origin") {
      store.setOrigin(p);
    } else if (editing === "destination") {
      store.setDestination(p);
    }
    setEditing(null);
  };

  const zoomTooLow = store.zoom < MIN_DATA_ZOOM;
  const guiding = store.guiding && store.screen === "routeResult";
  // 안내 중에는 화면을 안내에 내준다 — 시트·시각 막대·검색은 잠시 접는다
  const sheetOpen = (store.screen === "routeResult" && store.sheetExpanded) || guiding;

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[#EDF0F3]">
      <MapView topInset={topInset} bottomInset={bottomInset} />

      {/* 상단 chrome */}
      <div
        ref={topRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-30 mx-auto w-full max-w-[var(--app-max-w)]"
      >
        {guiding ? null : store.screen === "browse" ? (
          <TopBar onSearch={() => setEditing("browse")} />
        ) : (
          <>
            <RouteHeader onEdit={(w) => setEditing(w)} onClose={() => store.reset()} />
            {store.screen === "routeResult" && <PlanTabs />}
          </>
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
        {!sheetOpen && <MapControls bottom={bottomInset + 12} />}

        {/* 홈에서만: 저장한 길 */}
        {store.screen === "browse" && !picked && <SavedTrips />}

        {/* 홈에서만: 날씨 + 길찾기 시작 */}
        {store.screen === "browse" && !picked && (
          <div className="mb-2 flex items-end gap-2 px-3">
            <WeatherCard />
            <button
              onClick={() => store.setScreen("routeInput")}
              className="pointer-events-auto flex items-center gap-2 rounded-full bg-brand px-5 py-3.5 text-[16px] font-bold text-white shadow-float active:bg-brand-dark"
            >
              <IconWalk className="h-5 w-5" />
              코스 찾기
            </button>
          </div>
        )}

        {/* 시트를 펼치면 시각 막대까지 두기엔 화면이 좁다. 시각은 구간마다 적혀 있다 */}
        {!sheetOpen && (
          <div className="pb-2">
            <TimeBar />
          </div>
        )}

        {picked && (
          <PlaceCard
            place={picked}
            onOrigin={() => {
              store.setOrigin(picked);
              store.setScreen("routeInput");
              setPicked(null);
            }}
            onDestination={() => {
              store.setDestination(picked);
              store.setScreen("routeInput");
              setPicked(null);
            }}
            onClose={() => setPicked(null)}
          />
        )}

        {store.screen === "routeResult" && !guiding && <PlanSheet />}
      </div>

      {editing && (
        <SearchOverlay
          title={
            editing === "origin"
              ? "출발지 검색"
              : editing === "destination"
                ? "도착지 검색"
                : "목적지 검색"
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

      {guiding && <GuideOverlay />}
      {store.prefsOpen && <PrefsSheet />}
      {!store.onboarded && <Onboarding />}
    </main>
  );
}
