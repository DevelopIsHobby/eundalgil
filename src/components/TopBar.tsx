"use client";

import { useMemo } from "react";
import { BRAND } from "@/lib/config";
import { useApp } from "@/lib/store";
import { getSunState } from "@/lib/sun";
import { IconMoon, IconSearch, IconSun } from "./icons";

export default function TopBar({ onSearch }: { onSearch: () => void }) {
  const { timeMs, center, openPrefs } = useApp();
  const sun = useMemo(() => getSunState(new Date(timeMs), center), [timeMs, center]);

  return (
    <div className="pointer-events-auto px-3 pt-3">
      <div className="flex h-[52px] items-center gap-1.5 rounded-[26px] bg-white pl-3 pr-1.5 shadow-card">
        <button
          onClick={onSearch}
          aria-label="목적지 검색"
          className="grid h-9 w-9 shrink-0 place-items-center text-ink-700"
        >
          <IconSearch />
        </button>
        <button onClick={onSearch} className="min-w-0 flex-1 truncate text-left text-[16px] text-ink-400">
          목적지 검색
        </button>

        {/* 지금 이 시각의 태양 고도 — 그늘이 얼마나 길지 가늠하는 값이다 */}
        <span
          className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-[13px] font-bold ${
            sun.isDay ? "bg-[#FFF4E0] text-[#C97A00]" : "bg-[#EEF0FB] text-route-night"
          }`}
        >
          {sun.isDay ? <IconSun className="h-[15px] w-[15px]" /> : <IconMoon className="h-[15px] w-[15px]" />}
          {sun.isDay ? `태양 고도 ${Math.round(sun.altitudeDeg)}°` : "일몰 후"}
        </span>

        <button
          onClick={() => openPrefs(true)}
          aria-label="길 취향 설정"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-[13px] font-extrabold text-brand"
        >
          응
        </button>
      </div>

      <span className="sr-only">
        {BRAND.name} — {BRAND.tagline}
      </span>
    </div>
  );
}
