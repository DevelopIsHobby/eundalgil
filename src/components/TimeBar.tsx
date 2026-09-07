"use client";

import { useMemo } from "react";
import { useApp } from "@/lib/store";
import { compassLabel, getSunState, sunTimes } from "@/lib/sun";
import { IconClock, IconMoon, IconSun } from "./icons";

function fmtTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${String(m).padStart(2, "0")}`;
}

function fmtHm(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function TimeBar() {
  const { timeMs, setTime, center, followNow } = useApp();
  const date = useMemo(() => new Date(timeMs), [timeMs]);
  const sun = useMemo(() => getSunState(date, center), [date, center]);
  const times = useMemo(() => sunTimes(date, center), [date, center]);

  const minutes = date.getHours() * 60 + date.getMinutes();

  const onSlide = (v: number) => {
    const d = new Date(timeMs);
    d.setHours(Math.floor(v / 60), v % 60, 0, 0);
    setTime(d.getTime(), false);
  };

  const shiftDay = (delta: number) => {
    const d = new Date(timeMs);
    d.setDate(d.getDate() + delta);
    setTime(d.getTime(), false);
  };

  return (
    <div className="pointer-events-auto mx-3 rounded-xl bg-white/95 px-3 py-2.5 shadow-card backdrop-blur">
      <div className="flex items-center gap-2">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
            sun.isDay ? "bg-[#FFF4E0] text-sun" : "bg-[#EEF0FB] text-route-night"
          }`}
        >
          {sun.isDay ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 whitespace-nowrap text-[15px] font-bold tabular-nums">
              {fmtTime(date)}
            </span>
            <span className="truncate text-[11px] text-ink-400">
              {sun.isDay
                ? `${compassLabel(sun.azimuthDeg)} ${sun.altitudeDeg.toFixed(0)}° · 그림자 ${sun.shadowRatio.toFixed(1)}배`
                : `일몰 후 · 일출 ${fmtHm(times.sunrise)}`}
            </span>
          </div>
        </div>

        <button
          onClick={() => setTime(Date.now(), true)}
          className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
            followNow ? "bg-brand text-white" : "bg-[#F2F4F6] text-ink-500"
          }`}
        >
          <span className="flex items-center gap-1">
            <IconClock className="h-3.5 w-3.5" />
            지금
          </span>
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => shiftDay(-1)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-400 active:bg-[#F2F4F6]"
          aria-label="하루 전"
        >
          −1일
        </button>
        <input
          type="range"
          min={4 * 60}
          max={22 * 60}
          step={10}
          value={Math.min(22 * 60, Math.max(4 * 60, minutes))}
          onChange={(e) => onSlide(Number(e.target.value))}
          className="h-1.5 w-full appearance-none rounded-full bg-gradient-to-r from-[#2B3A5B] via-[#FFD79A] to-[#2B3A5B] accent-brand
                     [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2
                     [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:bg-white
                     [&::-webkit-slider-thumb]:shadow"
          aria-label="시각 선택"
        />
        <button
          onClick={() => shiftDay(1)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-400 active:bg-[#F2F4F6]"
          aria-label="하루 후"
        >
          +1일
        </button>
      </div>
    </div>
  );
}
