"use client";

import { useActivePlan, useApp } from "@/lib/store";
import { formatDistance, formatDuration } from "@/lib/router";
import { formatClockKo, formatFare, type Leg, type Plan, type RideLeg, type WalkLeg } from "@/lib/plan";
import { MODE_LABEL } from "@/lib/transit";
import { SIDE_LABEL } from "@/lib/seat";
import SeatDiagram from "./SeatDiagram";
// 지도와 시트가 같은 색을 써야 한 여정으로 읽힌다
import { rideColorOf as rideColor } from "./MapView";
import { IconBus, IconLeaf, IconSubway, IconSun, IconWalk } from "./icons";

/** 수단 막대 — 도보/승차 시간을 비율대로 늘어놓는다 */
function ModeBar({ plan }: { plan: Plan }) {
  const total = plan.legs.reduce((acc, l) => acc + legSeconds(l), 0) || 1;
  return (
    <div className="flex h-7 gap-1 overflow-hidden">
      {plan.legs.map((leg, i) => {
        const share = legSeconds(leg) / total;
        if (share < 0.02) return null;
        const isWalk = leg.type === "walk";
        const shady = isWalk && (leg as WalkLeg).route.shadeRatio >= 0.5;
        const bg = isWalk ? (shady ? "#0FA958" : "#B0B8C1") : rideColor(leg as RideLeg);
        return (
          <div
            key={i}
            style={{ flexGrow: share, background: bg }}
            className="flex min-w-0 items-center justify-center gap-1 rounded-full px-2 text-[11px] font-bold text-white"
          >
            {isWalk ? (
              <IconWalk className="h-3.5 w-3.5 shrink-0" />
            ) : (leg as RideLeg).ride.pattern.mode === "bus" ? (
              <IconBus className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <IconSubway className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate tabular-nums">
              {Math.max(1, Math.round(legSeconds(leg) / 60))}분
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 도착 시각. 소요 시간은 분 단위로 반올림해 보여 주므로, 도착 시각도 같은 값으로 맞춘다.
 * (초 단위 그대로 쓰면 "23분"인데 도착이 22분 뒤인 것처럼 보인다)
 */
function arriveMs(plan: Plan) {
  return plan.startMs + Math.max(1, Math.round(plan.seconds / 60)) * 60000;
}

function legSeconds(leg: Leg) {
  return leg.type === "walk"
    ? leg.route.duration
    : leg.ride.rideSec + (leg.startMs - leg.arriveMs) / 1000;
}


function WalkLegRow({ leg }: { leg: WalkLeg }) {
  const pct = Math.round(leg.route.shadeRatio * 100);
  // 같은 이름의 정류장 사이를 걷는 건 환승이다 ("중대후문입구 → 중대후문입구" 로 보이면 이상하다)
  const transfer = leg.from === leg.to;
  return (
    <li className="flex gap-3">
      <div className="flex w-11 shrink-0 flex-col items-center">
        <span className="text-[11px] tabular-nums text-ink-400">{formatClockKo(leg.startMs).slice(3)}</span>
        <span className="mt-1 flex-1 border-l border-dashed border-line-strong" />
      </div>
      <div className="flex-1 pb-5">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[#F2F4F6] text-ink-700">
            <IconWalk className="h-[17px] w-[17px]" />
          </span>
          <p className="text-[15px] font-bold">
            {transfer ? "환승 정류장까지 걷기" : leg.preferred ? "그늘 우선으로 걷기" : "빠른 길로 걷기"}
          </p>
        </div>
        <p className="mt-1.5 text-[13px] text-ink-500">
          {transfer ? leg.to : `${leg.from} → ${leg.to}`}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-400 tabular-nums">
          {formatDuration(leg.route.duration)} · {formatDistance(leg.route.distance)}
          {leg.route.ascent >= 5 && ` · 오르막 ${leg.route.ascent}m`}
          {leg.route.stepsMeters >= 5 && ` · 계단 ${formatDistance(leg.route.stepsMeters)}`}
        </p>
        {leg.route.segments.length > 0 && (
          <p
            className={`mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold ${
              pct >= 50 ? "bg-brand-soft text-brand" : "bg-[#FFF3E0] text-[#C97A00]"
            }`}
          >
            {pct >= 50 ? <IconLeaf className="h-3.5 w-3.5" /> : <IconSun className="h-3.5 w-3.5" />}
            그늘 {pct}%
          </p>
        )}
      </div>
    </li>
  );
}

/** 실시간 도착 옆에 붙는 작은 표시 (저상·만차·막차) */
function LiveTag({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
        warn ? "bg-[#FFF3F1] text-[#C33C29]" : "bg-[#F2F4F6] text-ink-500"
      }`}
    >
      {children}
    </span>
  );
}

function RideLegRow({ leg }: { leg: RideLeg }) {
  const { ride, seat, live } = leg;
  const color = rideColor(leg);
  const waitMin = Math.round((leg.startMs - leg.arriveMs) / 60000);
  /** 배차간격으로 어림한 값은 실시간이 아니다 — 그때는 평균이라고 말해야 한다 */
  const realtime = live && !live.fromHeadway ? live : null;
  /** 같은 구간을 함께 다니는 노선 중 실제로 먼저 오는 번호 */
  const firstRef = realtime?.ref;
  /** 선로가 전부 지하라고 확인된 구간 — 햇빛이 없으니 자리를 고를 이유가 없다 */
  const underground = seat.surfaceKnown && seat.surfaceRatio < 0.05;
  return (
    <li className="flex gap-3">
      <div className="flex w-11 shrink-0 flex-col items-center">
        <span className="text-[11px] tabular-nums text-ink-400">{formatClockKo(leg.startMs).slice(3)}</span>
        <span className="mt-1 flex-1 border-l-[3px]" style={{ borderColor: color }} />
      </div>
      <div className="flex-1 pb-5">
        <div className="flex items-center gap-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-full text-white"
            style={{ background: color }}
          >
            {ride.pattern.mode === "bus" ? (
              <IconBus className="h-[17px] w-[17px]" />
            ) : (
              <IconSubway className="h-[17px] w-[17px]" />
            )}
          </span>
          <p className="text-[15px] font-bold">{ride.from.name} 승차</p>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-md px-2 py-1 text-[13px] font-bold text-white"
            style={{ background: color }}
          >
            {ride.pattern.ref || ride.pattern.name}
          </span>
          {ride.alts?.map((alt) => (
            <span
              key={alt.ref}
              className="rounded-md border px-1.5 py-0.5 text-[12px] font-bold"
              style={{ borderColor: color, color }}
              title="같은 구간을 다니는 다른 노선"
            >
              {alt.ref}
            </span>
          ))}
          <span className="text-[12px] text-ink-400">
            {ride.alts?.length ? "중 먼저 오는 것 · " : ""}
            {MODE_LABEL[ride.pattern.mode]}
            {ride.pattern.headsign ? ` · ${ride.pattern.headsign} 방면` : ""}
          </span>
        </div>

        {realtime && (
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold text-brand">
              <span className="h-[6px] w-[6px] rounded-full bg-brand" />
              실시간
            </span>
            <span className="text-[13px] font-bold tabular-nums">
              {/* 같은 구간을 다니는 다른 노선이 먼저 오면 그 번호를 말해 준다 */}
              {firstRef && firstRef !== ride.pattern.ref ? `${firstRef}번이 먼저 · ` : ""}
              {/* "N분 후" 라고 쓰면 걸어가는 시간과 헷갈린다. 정류장에서 기다리는 시간이다 */}
              {waitMin <= 0 ? "기다림 없이 바로 탑승" : `정류장에서 ${waitMin}분 대기`}
            </span>
            {realtime.stopsAway != null && (
              <span className="text-[12px] tabular-nums text-ink-400">
                {realtime.stopsAway > 0 ? `지금 ${realtime.stopsAway}정거장 전` : "지금 도착 중"}
              </span>
            )}
            {realtime.lowFloor && <LiveTag>저상</LiveTag>}
            {realtime.full && <LiveTag warn>만차</LiveTag>}
            {realtime.last && <LiveTag warn>막차</LiveTag>}
          </p>
        )}

        {/* 자리 추천 */}
        <div className="mt-2.5 flex items-start gap-2.5 rounded-xl bg-[#F7F8F9] p-3">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] font-bold">
              <IconSun className="h-4 w-4 shrink-0 text-sun" />
              <span className="whitespace-nowrap">
                {underground
                  ? "자리 추천 없음"
                  : seat.side === "any"
                    ? "자리 상관없음"
                    : `${SIDE_LABEL[seat.side]} 추천`}
              </span>
              {/* 지하 구간의 "그늘 100%" 는 자리를 잘 골랐다는 말처럼 읽힌다. 해가 아예 없는 것이다 */}
              {!underground && (
                <span className="whitespace-nowrap rounded bg-brand-soft px-1.5 py-0.5 text-[12px] font-bold text-brand">
                  그늘 {Math.round(seat.shadeRatio * 100)}%
                </span>
              )}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-500">{seat.reason}</p>
            {seat.side !== "any" && (
              <p className="mt-0.5 text-[12px] text-ink-400">
                반대쪽은 그늘 {Math.round(seat.otherShadeRatio * 100)}%
              </p>
            )}
            {/*
              해 위치로만 계산하므로 지하 구간에서는 의미가 없다.
              전 구간 지하면 seat.reason 이 이미 그렇게 말하고, 전 구간 지상이면 굳이 적지 않는다.
            */}
            {ride.pattern.mode !== "bus" &&
              (!seat.surfaceKnown ? (
                <p className="mt-0.5 text-[12px] text-ink-400">지상 구간 기준이에요.</p>
              ) : seat.surfaceRatio >= 0.05 && seat.surfaceRatio < 0.95 ? (
                <p className="mt-0.5 text-[12px] text-ink-400">
                  지상 구간 {Math.round(seat.surfaceRatio * 100)}% 기준이에요.
                </p>
              ) : null)}
          </div>
          {!underground && (
            <span className="shrink-0">
              <SeatDiagram highlight={seat.side} compact />
            </span>
          )}
        </div>

        <p className="mt-2 text-[13px] text-ink-500 tabular-nums">
          {ride.stopCount}개 정류장 · {formatDuration(ride.rideSec)}
          {waitMin > 0 && (
            <span className="text-ink-400">
              {" · "}
              {realtime ? "대기" : "평균 대기"} {waitMin}분
            </span>
          )}
        </p>
        <p className="mt-1.5 text-[15px] font-bold">{ride.to.name} 하차</p>
      </div>
    </li>
  );
}

export default function PlanSheet() {
  const { routing, planError, notices, planStyle, setPlanStyle, plans } = useApp();
  const plan = useActivePlan();
  /**
   * 시트를 다 펼치면 작은 화면에서 지도가 거의 안 남는다.
   * 기본은 접어서 요약만 보여 주고, 손잡이를 눌러 구간 목록을 편다.
   * 펼침 여부는 화면 전체가 알아야 해서(시각 막대·지도 버튼을 접는다) 스토어에 둔다.
   */
  const expanded = useApp((s) => s.sheetExpanded);
  const setExpanded = useApp((s) => s.setSheetExpanded);

  const hasBoth = plans.some((p) => p.shade.id !== p.fast.id);

  return (
    <div className="pointer-events-auto rounded-t-sheet bg-white pb-2 shadow-sheet">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={expanded ? "구간 접기" : "구간 펼치기"}
        className="flex w-full flex-col items-center gap-1 pb-1.5 pt-2"
      >
        <span className="sheet-handle" />
        {!expanded && plan && (
          <span className="text-[11px] text-ink-400">구간별로 보기</span>
        )}
      </button>

      {routing && <div className="py-8 text-center text-sm text-ink-400">경로를 계산하고 있어요…</div>}

      {!routing && planError && (
        <div className="mx-4 mb-3 rounded-lg bg-[#FFF3F1] px-3 py-3 text-[13px] leading-relaxed text-[#C33C29]">
          {planError}
        </div>
      )}

      {!routing && plan && (
        <>
          {/* 요약 */}
          <div className="px-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[13px] font-bold text-brand">
                  {planStyle === "shade" ? "그늘 우선" : "최단"}
                </p>
                <div className="flex items-baseline gap-2">
                  <span className="text-[30px] font-extrabold leading-tight tabular-nums">
                    {formatDuration(plan.seconds)}
                  </span>
                  <span className="text-[13px] text-ink-400 tabular-nums">
                    {formatClockKo(plan.startMs)} – {formatClockKo(arriveMs(plan))}
                  </span>
                </div>
              </div>

              {hasBoth && (
                <div className="flex shrink-0 rounded-full bg-[#F2F4F6] p-1 text-[13px] font-bold">
                  <button
                    onClick={() => setPlanStyle("shade")}
                    className={`rounded-full px-3 py-1.5 ${
                      planStyle === "shade" ? "bg-brand text-white" : "text-ink-500"
                    }`}
                  >
                    그늘
                  </button>
                  <button
                    onClick={() => setPlanStyle("fast")}
                    className={`rounded-full px-3 py-1.5 ${
                      planStyle === "fast" ? "bg-white text-ink-900 shadow-sm" : "text-ink-500"
                    }`}
                  >
                    최단
                  </button>
                </div>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-500">
              {plan.fare > 0 && <span className="tabular-nums">{formatFare(plan.fare)}</span>}
              {plan.fare > 0 && <span className="text-ink-300">·</span>}
              <span>환승 {plan.transfers}회</span>
              <span className="text-ink-300">·</span>
              <span className="tabular-nums">도보 {formatDistance(plan.walkMeters)}</span>
              <span
                className={`ml-auto rounded-full px-2.5 py-1 text-[12px] font-bold ${
                  plan.walkShade >= 0.5 ? "bg-brand-soft text-brand" : "bg-[#FFF3E0] text-[#C97A00]"
                }`}
              >
                도보 그늘 {Math.round(plan.walkShade * 100)}%
              </span>
            </div>

            <div className="mt-3">
              <ModeBar plan={plan} />
            </div>
          </div>

          {/* 구간 */}
          {expanded && (
            <ul className="mt-4 max-h-[48vh] overflow-y-auto px-4">
              {plan.legs.map((leg, i) =>
                leg.type === "walk" ? (
                  <WalkLegRow key={i} leg={leg} />
                ) : (
                  <RideLegRow key={i} leg={leg} />
                )
              )}
              <li className="flex gap-3">
                <div className="flex w-11 shrink-0 justify-center">
                  <span className="text-[11px] tabular-nums text-ink-400">
                    {formatClockKo(arriveMs(plan)).slice(3)}
                  </span>
                </div>
                <p className="pb-3 text-[15px] font-bold">도착</p>
              </li>
            </ul>
          )}
        </>
      )}

      {!routing &&
        notices.map((n) => (
          <p
            key={n}
            className="mx-4 mt-2 rounded-lg bg-[#F7F8F9] px-3 py-2 text-[12px] leading-relaxed text-ink-500"
          >
            {n}
          </p>
        ))}

      {/* 범례 — 펼쳤을 때만 (접었을 때 넣으면 지도가 더 줄어든다) */}
      <div
        className={`items-center gap-3 border-t border-line px-4 pt-2.5 text-[11px] text-ink-400 ${
          expanded ? "flex" : "hidden"
        }`}
      >
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full bg-route-shade" /> 그늘 구간
        </span>
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full border-t-2 border-dashed border-sun" /> 햇빛 구간
        </span>
        <span className="flex items-center gap-1">
          <span className="h-[3px] w-4 rounded-full bg-route-fast" /> 대중교통
        </span>
      </div>
    </div>
  );
}
