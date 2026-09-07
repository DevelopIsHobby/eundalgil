"use client";

import { SHADE_PRESETS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { formatDistance, formatDuration, type RouteOption } from "@/lib/router";
import { IconStairs, IconSun, IconTree, IconWalk } from "./icons";

function ShadeBar({ ratio, tone }: { ratio: number; tone: string }) {
  const pct = Math.round(ratio * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#EDEFF2]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span className="w-9 shrink-0 text-right text-[12px] font-semibold tabular-nums" style={{ color: tone }}>
        {pct}%
      </span>
    </div>
  );
}

function RouteCard({
  route,
  active,
  best,
  onClick,
}: {
  route: RouteOption;
  active: boolean;
  best: boolean;
  onClick: () => void;
}) {
  const tone = route.id === "shade" ? "#12B886" : "#2E6FF2";
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-xl border px-3.5 py-3 text-left transition-colors ${
        active ? "border-transparent bg-white ring-2" : "border-line bg-white"
      }`}
      style={active ? { boxShadow: `0 0 0 2px ${tone}` } : undefined}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className="rounded px-1.5 py-0.5 text-[11px] font-bold text-white"
          style={{ background: tone }}
        >
          {route.label}
        </span>
        {best && (
          <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold text-brand">
            추천
          </span>
        )}
        <span className="ml-auto text-[13px] text-ink-500 tabular-nums">
          {formatDistance(route.distance)}
        </span>
      </div>

      <div className="mb-2 flex items-baseline gap-1.5">
        <IconWalk className="h-4 w-4 self-center text-ink-500" />
        <span className="text-[19px] font-bold tabular-nums">{formatDuration(route.duration)}</span>
        <span className="text-[12px] text-ink-400">도보</span>
      </div>

      <ShadeBar ratio={route.shadeRatio} tone={tone} />

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-500">
        <span className="flex items-center gap-1">
          <IconTree className="h-3.5 w-3.5" />
          그늘 {formatDistance(route.distance * route.shadeRatio)}
        </span>
        <span className="flex items-center gap-1">
          <IconSun className="h-3.5 w-3.5" />
          햇빛 {formatDistance(route.distance * (1 - route.shadeRatio))}
        </span>
        {route.stepsMeters > 5 && (
          <span className="flex items-center gap-1">
            <IconStairs className="h-3.5 w-3.5" />
            계단 {formatDistance(route.stepsMeters)}
          </span>
        )}
        {route.crossings > 0 && <span>횡단보도 {route.crossings}회</span>}
      </div>
    </button>
  );
}

export default function RouteSheet() {
  const { routes, selectedRoute, selectRoute, shadePreset, setShadePreset, routing, routeError } =
    useApp();

  const bestId =
    routes.length > 1
      ? routes.reduce((a, b) => (b.shadeRatio > a.shadeRatio ? b : a)).id
      : routes[0]?.id;

  return (
    <div className="pointer-events-auto rounded-t-sheet bg-white pb-2 shadow-sheet">
      <div className="flex justify-center pb-2 pt-2">
        <span className="sheet-handle" />
      </div>

      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-4 pb-3">
        {SHADE_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setShadePreset(p.id)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-medium ${
              shadePreset === p.id
                ? "border-brand bg-brand-soft text-brand"
                : "border-line-strong bg-white text-ink-500"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="max-h-[42vh] space-y-2 overflow-y-auto px-4 pb-3">
        {routing && <div className="py-6 text-center text-sm text-ink-400">경로를 계산하고 있어요…</div>}

        {!routing && routeError && (
          <div className="rounded-lg bg-[#FFF3F1] px-3 py-3 text-[13px] leading-relaxed text-[#C33C29]">
            {routeError}
          </div>
        )}

        {!routing &&
          routes.map((r) => (
            <RouteCard
              key={r.id}
              route={r}
              active={r.id === selectedRoute}
              best={r.id === bestId && routes.length > 1}
              onClick={() => selectRoute(r.id)}
            />
          ))}

        {!routing && !routeError && routes.length === 1 && (
          <p className="px-1 pt-1 text-[12px] leading-relaxed text-ink-400">
            이 시각에는 우회해도 그늘이 더 늘지 않아 최단 경로 하나만 보여드려요.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-line px-4 pt-2.5 text-[11px] text-ink-400">
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full bg-route-shade" /> 그늘 구간
        </span>
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full border-t-2 border-dashed border-sun" /> 햇빛 구간
        </span>
      </div>
    </div>
  );
}
