"use client";

import { useState } from "react";
import { useApp } from "@/lib/store";
import { getMap } from "./MapView";
import { hasVWorld, basemapLabel } from "@/lib/basemap";
import { IconCompass, IconLayers, IconLocate, IconTree } from "./icons";

function FloatBtn({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-10 w-10 place-items-center rounded-lg shadow-float transition-colors ${
        active ? "bg-brand text-white" : "bg-white text-ink-700"
      }`}
    >
      {children}
    </button>
  );
}

export default function MapControls({ bottom }: { bottom: number }) {
  const { showShadow, showTrees, toggle, setCenter, showToast, basemap, setBasemap } = useApp();
  const [locating, setLocating] = useState(false);

  const swapBasemap = () => {
    const next = basemap === "vworld" ? "openfreemap" : "vworld";
    setBasemap(next);
    showToast(`${basemapLabel(next)}로 바꿨습니다.`);
  };

  const locate = () => {
    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치를 쓸 수 없습니다.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const p: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        // 지도가 멈추면 store.center 는 알아서 따라온다 (MapView 의 onIdle)
        const map = getMap();
        if (map) map.easeTo({ center: p, zoom: 16, duration: 500 });
        else setCenter(p, 16);
      },
      () => {
        setLocating(false);
        showToast("위치 권한이 거부되었습니다.");
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  return (
    <div
      className="pointer-events-auto absolute right-3 flex flex-col gap-2"
      style={{ bottom }}
    >
      <FloatBtn active={showShadow} label="그늘 표시" onClick={() => toggle("showShadow")}>
        <IconLayers />
      </FloatBtn>
      <FloatBtn active={showTrees} label="가로수 그늘" onClick={() => toggle("showTrees")}>
        <IconTree />
      </FloatBtn>
      {hasVWorld && (
        <FloatBtn
          active={basemap === "vworld"}
          label={`배경지도 전환 — 지금은 ${basemapLabel(basemap)}`}
          onClick={swapBasemap}
        >
          <IconCompass />
        </FloatBtn>
      )}
      <FloatBtn label="현재 위치" onClick={locate}>
        <IconLocate className={locating ? "animate-pulse" : ""} />
      </FloatBtn>
    </div>
  );
}
