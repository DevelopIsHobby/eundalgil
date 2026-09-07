"use client";

import { useState } from "react";
import { useApp } from "@/lib/store";
import { getMap } from "./MapView";
import { IconLayers, IconLocate, IconTree } from "./icons";

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
  const { showShadow, showTrees, toggle, setCenter, showToast } = useApp();
  const [locating, setLocating] = useState(false);

  const locate = () => {
    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치를 쓸 수 없습니다.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setCenter([pos.coords.longitude, pos.coords.latitude], 17);
        const map = getMap();
        if (map) map.setCenter(new naver.maps.LatLng(pos.coords.latitude, pos.coords.longitude));
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
      <FloatBtn label="현재 위치" onClick={locate}>
        <IconLocate className={locating ? "animate-pulse" : ""} />
      </FloatBtn>
    </div>
  );
}
