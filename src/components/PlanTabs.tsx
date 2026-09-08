"use client";

import { useApp } from "@/lib/store";
import { formatDuration } from "@/lib/router";
import { MODE_LABEL } from "@/lib/transit";
import type { Plan, RideLeg } from "@/lib/plan";
import { IconBus, IconSubway, IconWalk } from "./icons";

function firstRide(plan: Plan) {
  return plan.legs.find((l): l is RideLeg => l.type === "ride") ?? null;
}

function tabIcon(plan: Plan) {
  const ride = firstRide(plan);
  if (!ride) return <IconWalk className="h-[15px] w-[15px]" />;
  return ride.ride.pattern.mode === "bus" ? (
    <IconBus className="h-[15px] w-[15px]" />
  ) : (
    <IconSubway className="h-[15px] w-[15px]" />
  );
}

/** 경로 후보 탭 — 지도 위쪽에 가로로 늘어놓는다 */
export default function PlanTabs() {
  const { plans, planIndex, planStyle, selectPlan } = useApp();
  if (plans.length < 1) return null;

  return (
    <div className="no-scrollbar pointer-events-auto flex gap-2 overflow-x-auto px-3 py-2">
      {plans.map((pair, i) => {
        const plan = planStyle === "fast" ? pair.fast : pair.shade;
        const active = i === planIndex;
        return (
          <button
            key={plan.id}
            onClick={() => selectPlan(i)}
            aria-pressed={active}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-bold shadow-card transition-colors ${
              active ? "bg-brand text-white" : "bg-white text-ink-700"
            }`}
          >
            {i === 0 && <span className={active ? "text-white" : "text-brand"}>추천</span>}
            {i === 0 && <span className={active ? "text-white/60" : "text-ink-300"}>·</span>}
            <span className="tabular-nums">{formatDuration(plan.seconds)}</span>
            <span className={active ? "text-white/60" : "text-ink-300"}>·</span>
            <span className="flex items-center gap-1">
              {tabIcon(plan)}
              {plan.kind === "walk"
                ? "도보"
                : `${plan.summary}${plan.transfers > 0 ? ` ·환승 ${plan.transfers}` : ""}`}
            </span>
            <span className="sr-only">
              {plan.kind === "walk"
                ? "도보 경로"
                : `${MODE_LABEL[firstRide(plan)!.ride.pattern.mode]} 경로`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
