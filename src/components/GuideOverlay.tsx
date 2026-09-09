"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Marker } from "maplibre-gl";
import { getMap } from "./MapView";
import { useActivePlan, useApp } from "@/lib/store";
import { formatDistance, formatDuration } from "@/lib/router";
import {
  buildGuide,
  formatRemain,
  nextStep,
  projectOnPath,
  TURN_LABEL,
  type GuideStep,
} from "@/lib/guide";
import type { LngLat } from "@/lib/geo";
import { IconBus, IconClose, IconFlag, IconSound, IconSoundOff, IconWalk } from "./icons";

/** 안내를 소리로 읽어 줄 거리 — 이 안에 들어오면 한 번 말한다 */
const SPEAK_WITHIN_M = 60;

/**
 * 걷는 동안 화면이 꺼지지 않게 붙잡는다.
 * 주머니에 넣고 걸으면 안내가 멈추는 게 아니라 화면만 꺼지지만, 다시 켤 때마다
 * 위치를 새로 잡느라 안내가 끊긴다. 브라우저가 지원할 때만 동작한다.
 */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    type Sentinel = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } };
    if (!nav.wakeLock) return;

    let lock: Sentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      try {
        lock = (await nav.wakeLock!.request("screen")) ?? null;
      } catch {
        /* 배터리 절약 모드 등에서는 거절될 수 있다 — 그냥 없이 간다 */
      }
    };
    // 화면을 다시 켜면 잠금이 풀려 있으므로 다시 잡는다
    const onVisible = () => {
      if (!stopped && document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}

/** 안내를 소리로 읽어 준다. 같은 안내를 두 번 말하지 않는다 */
function useSpeech(enabled: boolean) {
  const spoken = useRef<string | null>(null);
  return (key: string, text: string) => {
    if (!enabled || spoken.current === key) return;
    spoken.current = key;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* 지원하지 않는 브라우저면 조용히 넘어간다 */
    }
  };
}

/** 이보다 멀어지면 경로를 벗어난 것으로 본다 */
const OFF_ROUTE_M = 45;
/** 한 번 튄 좌표로 "이탈" 이라고 하지 않도록, 연달아 이만큼 어긋나야 인정한다 */
const OFF_ROUTE_HITS = 3;

function TurnGlyph({ step }: { step: GuideStep }) {
  if (step.ride) return <IconBus className="h-7 w-7" />;
  if (step.text === "도착") return <IconFlag className="h-7 w-7" />;
  const rotate =
    step.turn === "left" ? -45 : step.turn === "right" ? 45 : step.turn === "sharp-left" ? -90 : step.turn === "sharp-right" ? 90 : 0;
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <g transform={`rotate(${rotate} 12 12)`}>
        <path d="M12 20V7" strokeLinecap="round" />
        <path d="m7 12 5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/**
 * 걷는 동안 띄우는 안내 화면.
 *
 * 위치는 브라우저에서 바로 받는다(watchPosition). 경로를 벗어나면 **출발지를 지금 자리로
 * 바꿔** 다시 찾게 한다 — 재계산 로직을 따로 두지 않고 원래 쓰던 길찾기를 그대로 쓴다.
 */
export default function GuideOverlay() {
  const plan = useActivePlan();
  const setGuiding = useApp((s) => s.setGuiding);
  const setOrigin = useApp((s) => s.setOrigin);
  const showToast = useApp((s) => s.showToast);

  const [voice, setVoice] = useState(true);
  const [here, setHere] = useState<LngLat | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const offHits = useRef(0);

  const guide = useMemo(() => (plan ? buildGuide(plan) : null), [plan]);
  useWakeLock(true);
  const speak = useSpeech(voice);

  /* 위치 추적 */
  useEffect(() => {
    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치를 쓸 수 없습니다.");
      setGuiding(false);
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setHere([pos.coords.longitude, pos.coords.latitude]);
        setAccuracy(pos.coords.accuracy);
      },
      () => showToast("위치를 받지 못했습니다. 권한을 확인해 주세요."),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [setGuiding, showToast]);

  /* 지도를 내 위치에 붙여 두고, 그 자리에 점을 찍는다 */
  const dotRef = useRef<Marker | null>(null);
  useEffect(() => {
    const map = getMap();
    if (!map || !here) return;
    if (!dotRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "width:18px;height:18px;border-radius:50%;background:#2E6FF2;border:3px solid #fff;box-shadow:0 0 0 6px rgba(46,111,242,.25)";
      dotRef.current = new Marker({ element: el, anchor: "center" });
    }
    dotRef.current.setLngLat(here).addTo(map);
    map.easeTo({ center: here, zoom: 17, duration: 700 });
  }, [here]);

  useEffect(
    () => () => {
      dotRef.current?.remove();
      dotRef.current = null;
      window.speechSynthesis?.cancel();
    },
    []
  );

  const on = useMemo(
    () => (guide && here ? projectOnPath(guide.path, here) : null),
    [guide, here]
  );

  /* 경로 이탈 판정 — 몇 번 연달아 어긋날 때만 */
  useEffect(() => {
    if (!on) return;
    if (on.offset > OFF_ROUTE_M) {
      offHits.current += 1;
      if (offHits.current >= OFF_ROUTE_HITS) setOffRoute(true);
    } else {
      offHits.current = 0;
      setOffRoute(false);
    }
  }, [on]);

  const total = guide ? guide.steps[guide.steps.length - 1]?.at ?? 0 : 0;
  const at = on?.at ?? 0;
  const upcoming = guide ? nextStep(guide.steps, at) : null;
  const remainM = Math.max(0, total - at);
  // 남은 시간은 전체 소요를 남은 거리 비율로 나눠 어림한다
  const remainSec = plan && total > 0 ? (plan.seconds * remainM) / total : 0;

  /* 회전이 가까워지면 한 번 읽어 준다 (렌더 중에 소리를 내면 안 되므로 효과에서) */
  const speakKey =
    upcoming && upcoming.remain <= SPEAK_WITHIN_M
      ? `${Math.round(upcoming.step.at)}:${upcoming.step.text}`
      : null;
  const speakText = upcoming?.step.ride ? upcoming.step.text : `잠시 후 ${upcoming?.step.text ?? ""}`;
  useEffect(() => {
    if (speakKey) speak(speakKey, speakText);
    // speak 은 이미 같은 안내를 두 번 말하지 않게 막고 있다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakKey]);

  if (!plan || !guide) return null;

  const recompute = () => {
    if (!here) return;
    setOrigin({ name: "현재 위치", p: here });
    setOffRoute(false);
    offHits.current = 0;
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex flex-col justify-between">
      {/* 다음에 할 일 */}
      <div className="pointer-events-auto mx-3 mt-3 rounded-2xl bg-[#1F2933] px-4 py-3.5 text-white shadow-float">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/10">
            {upcoming ? <TurnGlyph step={upcoming.step} /> : <IconWalk className="h-7 w-7" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[20px] font-extrabold leading-tight">
              {upcoming ? upcoming.step.text : "안내를 준비하고 있어요"}
            </p>
            <p className="mt-0.5 text-[13px] text-white/70">
              {upcoming ? formatRemain(upcoming.remain) : here ? "경로를 찾는 중" : "위치를 받는 중"}
              {upcoming?.step.ride && ` · ${upcoming.step.ride.stops}개 정류장 뒤 ${upcoming.step.ride.to}`}
            </p>
          </div>
          <button
            onClick={() => {
              setVoice((v) => !v);
              if (voice) window.speechSynthesis?.cancel();
            }}
            aria-label={voice ? "음성 안내 끄기" : "음성 안내 켜기"}
            aria-pressed={voice}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white/80"
          >
            {voice ? <IconSound /> : <IconSoundOff />}
          </button>
          <button
            onClick={() => setGuiding(false)}
            aria-label="안내 끝내기"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-white/80"
          >
            <IconClose />
          </button>
        </div>

        {offRoute && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#C33C29]/90 px-3 py-2 text-[13px]">
            <span className="flex-1">경로에서 벗어났어요.</span>
            <button onClick={recompute} className="rounded-lg bg-white px-2.5 py-1 font-bold text-[#C33C29]">
              여기서 다시 찾기
            </button>
          </div>
        )}
      </div>

      {/* 남은 거리·시간 */}
      <div className="pointer-events-auto mx-3 mb-3 flex items-center gap-3 rounded-2xl bg-white px-4 py-3 shadow-float">
        <div className="flex-1">
          <p className="text-[22px] font-extrabold leading-tight tabular-nums">
            {formatDuration(remainSec)}
            <span className="ml-2 text-[14px] font-semibold text-ink-500">
              {formatDistance(remainM)} 남음
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-ink-400">
            {accuracy != null ? `위치 오차 약 ${Math.round(accuracy)}m` : "위치를 받는 중"}
            {" · "}
            {upcoming?.step.turn && upcoming.step.turn !== "straight"
              ? `다음 ${TURN_LABEL[upcoming.step.turn]}`
              : "직진 중"}
          </p>
        </div>
        <button
          onClick={() => setGuiding(false)}
          className="shrink-0 rounded-xl bg-[#F2F4F6] px-4 py-2.5 text-[14px] font-bold text-ink-700"
        >
          안내 종료
        </button>
      </div>
    </div>
  );
}
