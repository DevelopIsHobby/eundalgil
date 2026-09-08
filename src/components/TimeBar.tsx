"use client";

import { useMemo } from "react";
import { useApp } from "@/lib/store";
import { compassLabel, getSunState, sunTimes } from "@/lib/sun";

function fmtHm(d: Date) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(d: Date) {
  const today = new Date();
  const diff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86400000
  );
  if (diff === 0) return null;
  if (diff === 1) return "내일";
  if (diff === -1) return "어제";
  return `${diff > 0 ? "+" : ""}${diff}일`;
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

  const offset = dayLabel(date);

  return (
    <div className="pointer-events-auto mx-3 rounded-[22px] bg-white/95 px-2.5 py-2.5 shadow-card backdrop-blur">
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => setTime(Date.now(), true)}
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-bold ${
            followNow ? "bg-[#1F2933] text-white" : "bg-[#F2F4F6] text-ink-500"
          }`}
        >
          <span
            className={`h-[7px] w-[7px] rounded-full ${followNow ? "bg-brand" : "bg-ink-300"}`}
            aria-hidden
          />
          {followNow ? "실시간" : "지금으로"}
        </button>

        {/* 새벽 → 한낮 → 밤. 색이 곧 하루의 햇빛 세기다 */}
        <input
          type="range"
          min={4 * 60}
          max={22 * 60}
          step={10}
          value={Math.min(22 * 60, Math.max(4 * 60, minutes))}
          onChange={(e) => onSlide(Number(e.target.value))}
          aria-label="시각 선택"
          className="h-2 w-full appearance-none rounded-full
                     bg-[linear-gradient(90deg,#B8C4E0_0%,#FFD79A_22%,#FF9F45_50%,#FFD79A_78%,#B8C4E0_100%)]
                     [&::-webkit-slider-thumb]:h-[26px] [&::-webkit-slider-thumb]:w-[26px]
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
                     [&::-webkit-slider-thumb]:bg-sun [&::-webkit-slider-thumb]:shadow-float
                     [&::-moz-range-thumb]:h-[24px] [&::-moz-range-thumb]:w-[24px]
                     [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2
                     [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-sun"
        />

        <div className="shrink-0 text-right">
          <p className="text-[11px] text-ink-400">{followNow ? "현재 시각" : "선택 시각"}</p>
          <p className="text-[19px] font-extrabold leading-tight tabular-nums">{fmtHm(date)}</p>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-2 px-0.5">
        <span className="truncate text-[11px] text-ink-400">
          {sun.isDay
            ? `${compassLabel(sun.azimuthDeg)} 하늘 · 그림자 ${sun.shadowRatio.toFixed(1)}배`
            : `일몰 후 · 일출 ${fmtHm(times.sunrise)}`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {offset && (
            <span className="rounded bg-[#F2F4F6] px-1.5 py-0.5 text-[11px] font-bold text-ink-500">
              {offset}
            </span>
          )}
          <button
            onClick={() => shiftDay(-1)}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 active:bg-[#F2F4F6]"
            aria-label="하루 전"
          >
            −1일
          </button>
          <button
            onClick={() => shiftDay(1)}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 active:bg-[#F2F4F6]"
            aria-label="하루 후"
          >
            +1일
          </button>
        </span>
      </div>
    </div>
  );
}
