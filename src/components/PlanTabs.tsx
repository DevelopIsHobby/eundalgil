"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";
import { formatDuration } from "@/lib/router";
import { MODE_LABEL } from "@/lib/transit";
import type { Plan, RideLeg } from "@/lib/plan";
import { IconBus, IconChevronRight, IconSubway, IconWalk } from "./icons";

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

/** 가장자리에 놓는 좌·우 넘김 단추 */
function Nudge({ dir, onClick }: { dir: -1 | 1; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={dir < 0 ? "이전 경로 보기" : "다음 경로 보기"}
      className={`pointer-events-auto absolute top-1/2 z-10 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-ink-700 shadow-card active:bg-[#F2F4F6] ${
        dir < 0 ? "left-1.5" : "right-1.5"
      }`}
    >
      <IconChevronRight className={`h-4 w-4 ${dir < 0 ? "rotate-180" : ""}`} />
    </button>
  );
}

/**
 * 경로 후보 탭 — 지도 위쪽에 가로로 늘어놓는다.
 *
 * 안이 여섯 개까지 나오는데 화면에는 서너 개밖에 안 들어간다. 스크롤 막대를 숨겨 둬서
 * (지도 위라 막대가 지저분하다) 넘길 수 있다는 것도, 넘기는 방법도 보이지 않았다.
 * 손가락으로는 밀면 되지만 마우스로는 방법이 없다 — 그래서 좌·우 단추를 둔다.
 */
export default function PlanTabs() {
  const { plans, planIndex, planStyle, selectPlan } = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  /** 그 방향으로 더 볼 게 남았는지 — 남았을 때만 단추를 띄운다 */
  const [more, setMore] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 1px 어긋남으로 단추가 깜빡이지 않게 여유를 둔다
    setMore({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, plans.length, planStyle]);

  /*
   * 고른 안이 화면 밖이면 끌어온다.
   * scrollIntoView 는 쓰지 않는다 — 가로만 옮기고 싶은데 페이지까지 세로로 움직인다.
   */
  useEffect(() => {
    const el = scroller.current;
    const tab = el?.children[planIndex] as HTMLElement | undefined;
    if (!el || !tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < el.scrollLeft) el.scrollTo({ left: left - 12, behavior: "smooth" });
    else if (right > el.scrollLeft + el.clientWidth)
      el.scrollTo({ left: right - el.clientWidth + 12, behavior: "smooth" });
  }, [planIndex]);

  const nudge = (dir: -1 | 1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.7), behavior: "smooth" });
  };

  if (plans.length < 1) return null;

  return (
    <div className="pointer-events-none relative">
      {more.left && <Nudge dir={-1} onClick={() => nudge(-1)} />}
      {more.right && <Nudge dir={1} onClick={() => nudge(1)} />}

      {/*
        스냅은 걸지 않는다. snap-mandatory 를 걸었더니 단추로 옮긴 위치를 브라우저가
        스냅 지점으로 도로 끌어당겨, 눌러도 제자리에 머물렀다.
      */}
      <div
        ref={scroller}
        onScroll={measure}
        className="no-scrollbar pointer-events-auto flex gap-2 overflow-x-auto px-3 py-2"
      >
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
    </div>
  );
}
