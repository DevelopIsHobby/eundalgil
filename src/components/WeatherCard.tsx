"use client";

import { useEffect } from "react";
import { useApp } from "@/lib/store";
import { useDebounced } from "@/lib/useDebounced";
import { IconCloud, IconRain, IconSnow, IconSun } from "./icons";

/** 지도 중심이 바뀌면 그 동네 날씨를 다시 받는다 */
export function useWeather() {
  const center = useApp((s) => s.center);
  // 지도를 끄는 동안 매번 부르지 않도록 잠깐 묶는다
  const debounced = useDebounced(center, 1200);

  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    fetch(`/api/weather?lat=${debounced[1].toFixed(3)}&lng=${debounced[0].toFixed(3)}`, {
      signal: ctl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => {
        if (!cancelled && w) useApp.getState().setWeather(w);
      })
      .catch(() => {
        /* 날씨는 곁들이 정보라 실패해도 조용히 넘어간다 */
      });
    return () => {
      cancelled = true;
      ctl.abort();
    };
    // 동네가 바뀔 때만 (소수 둘째 자리 = 약 1km)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced[0].toFixed(2), debounced[1].toFixed(2)]);
}

function icon(code: number) {
  if (code === 0 || code <= 2) return <IconSun className="h-7 w-7 text-sun" />;
  if (code <= 48) return <IconCloud className="h-7 w-7 text-ink-400" />;
  if (code <= 67 || (code >= 80 && code <= 82)) return <IconRain className="h-7 w-7 text-route-fast" />;
  if (code <= 86) return <IconSnow className="h-7 w-7 text-route-fast" />;
  return <IconCloud className="h-7 w-7 text-ink-400" />;
}

export default function WeatherCard() {
  const weather = useApp((s) => s.weather);
  if (!weather) return null;

  return (
    <div className="pointer-events-auto w-[92px] rounded-2xl bg-white/95 px-3 py-2.5 text-center shadow-card backdrop-blur">
      <div className="flex justify-center">{icon(weather.code)}</div>
      <p className="mt-1 text-[22px] font-extrabold leading-none tabular-nums">{weather.tempC}°</p>
      <p className="mt-1 text-[12px] font-semibold text-ink-500">{weather.label}</p>
      {/* 체감이 기온과 다를 때만 — 같으면 굳이 두 번 말할 필요가 없다 */}
      {Math.abs(weather.feelsC - weather.tempC) >= 1 && (
        <p className="mt-0.5 text-[11px] text-ink-400 tabular-nums">체감 {weather.feelsC}°</p>
      )}
    </div>
  );
}
