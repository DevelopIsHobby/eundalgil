"use client";

import { useState } from "react";
import { BRAND } from "@/lib/config";
import { prefChips } from "@/lib/prefs";
import { useApp } from "@/lib/store";
import PrefControls from "./PrefControls";
import SeatDiagram from "./SeatDiagram";
import {
  IconBus,
  IconLeaf,
  IconLocate,
  IconShield,
  IconSubway,
  IconSun,
  IconTransfer,
} from "./icons";

const STEPS = 4;

const FEATURES = [
  { icon: <IconLeaf />, label: "시간대별 도보 그늘", tone: "bg-brand-soft text-brand" },
  { icon: <IconBus />, label: "대중교통 전 구간 안내", tone: "bg-[#EAF1FF] text-route-fast" },
  { icon: <IconSun />, label: "햇빛 적은 자리 추천", tone: "bg-[#FFF3E0] text-sun" },
  { icon: <IconTransfer />, label: "환승 도보도 그늘 우선", tone: "bg-[#F1ECFF] text-route-night" },
  { icon: <IconShield />, label: "야간 방범시설 많은 길", tone: "bg-[#FFF7DC] text-[#C99700]" },
];

const CHIP_TONE = {
  green: "bg-brand-soft text-brand",
  blue: "bg-[#EAF1FF] text-route-fast",
  orange: "bg-[#FFF1E0] text-[#C97A00]",
  purple: "bg-[#F1ECFF] text-route-night",
  sky: "bg-[#E6F4FF] text-[#0B7BC1]",
  yellow: "bg-[#FFF7DC] text-[#B08900]",
} as const;

export default function Onboarding() {
  const { prefs, setPrefs, finishOnboarding, showToast } = useApp();
  const [step, setStep] = useState(0);

  const done = () => finishOnboarding();

  const allowLocation = () => {
    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치를 쓸 수 없습니다.");
      done();
      return;
    }
    // 권한 창의 답을 기다리지 않고 넘어간다 — 거절해도 앱은 그대로 쓸 수 있다
    navigator.geolocation.getCurrentPosition(
      (pos) => useApp.getState().setCenter([pos.coords.longitude, pos.coords.latitude], 16),
      () => useApp.getState().showToast("위치 없이도 검색으로 길을 찾을 수 있어요.")
    );
    done();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F7F8F9]">
      {/* 진행 표시 + 건너뛰기 */}
      <header className="flex items-center justify-between px-5 pb-2 pt-5">
        <div className="flex items-center gap-1.5" aria-label={`${step + 1} / ${STEPS} 단계`}>
          {Array.from({ length: STEPS }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-brand" : "w-1.5 bg-[#D9DDE1]"
              }`}
            />
          ))}
        </div>
        <button onClick={done} className="text-[14px] font-medium text-ink-500">
          둘러보기
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {step === 0 && (
          <div className="flex min-h-full flex-col justify-center py-6 text-center">
            <div className="mx-auto grid h-[86px] w-[86px] place-items-center rounded-[24px] bg-brand text-white shadow-card">
              <IconLeaf className="h-11 w-11" />
            </div>
            <p className="mt-5 text-[15px] font-bold text-brand">
              {BRAND.name} · {BRAND.latin}
            </p>
            <h1 className="mt-2 text-[34px] font-extrabold leading-[1.15] tracking-[-0.5px]">
              걷는 길부터
              <br />
              타는 자리까지
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-500">
              시간대별 그늘길과 대중교통 경로를 함께 찾고,
              <br />
              햇빛을 덜 받는 자리까지 알려드려요.
            </p>

            <div className="mt-7 rounded-2xl bg-white p-4 text-left shadow-card">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-ink-400">지금 되는 것</span>
                <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[11px] font-bold text-brand">
                  도보 + 대중교통
                </span>
              </div>
              <ul className="divide-y divide-line">
                {FEATURES.map((f) => (
                  <li key={f.label} className="flex items-center gap-3 py-2.5">
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${f.tone}`}>
                      <span className="[&>svg]:h-[17px] [&>svg]:w-[17px]">{f.icon}</span>
                    </span>
                    <span className="text-[14px] font-semibold">{f.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="py-2">
            <p className="text-center text-[14px] font-bold text-brand">30초면 충분해요</p>
            <h1 className="mt-1 text-center text-[28px] font-extrabold tracking-[-0.5px]">
              어떤 길이 편하세요?
            </h1>
            <p className="mb-5 mt-2 text-center text-[14px] text-ink-500">
              나중에 언제든 바꿀 수 있어요.
            </p>
            <PrefControls prefs={prefs} onChange={setPrefs} />
          </div>
        )}

        {step === 2 && (
          <div className="py-2">
            <p className="text-center text-[14px] font-bold text-brand">자리 추천 읽는 법</p>
            <h1 className="mt-1 text-center text-[27px] font-extrabold tracking-[-0.5px]">
              좌·우는 진행방향 기준이에요
            </h1>
            <p className="mb-5 mt-2 text-center text-[14px] leading-relaxed text-ink-500">
              차량이 가는 쪽을 바라봤을 때의 왼쪽과 오른쪽이에요.
              <br />
              지하철은 해당 차체 쪽에 붙은 좌석을 뜻해요.
            </p>

            {[
              { icon: <IconBus />, title: "버스", sub: "앞을 바라본 좌석 기준", tone: "bg-brand-soft text-brand" },
              { icon: <IconSubway />, title: "지하철", sub: "차량이 가는 방향 기준", tone: "bg-[#EAF1FF] text-route-fast" },
            ].map((m) => (
              <div key={m.title} className="mb-3 rounded-2xl bg-white p-4 shadow-card">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className={`grid h-9 w-9 place-items-center rounded-lg ${m.tone}`}>
                    <span className="[&>svg]:h-[18px] [&>svg]:w-[18px]">{m.icon}</span>
                  </span>
                  <div>
                    <p className="text-[15px] font-bold">{m.title}</p>
                    <p className="text-[12px] text-ink-400">{m.sub}</p>
                  </div>
                  <span className="ml-auto rounded-full bg-[#F2F4F6] px-2.5 py-1 text-[11px] font-semibold text-ink-500">
                    ↑ 진행방향
                  </span>
                </div>
                <div className="flex justify-center">
                  <SeatDiagram />
                </div>
              </div>
            ))}

            <p className="px-2 text-center text-[13px] leading-relaxed text-ink-400">
              해의 위치와 이동 경로를 계산해 햇빛을 덜 받는 쪽을 추천해요.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex min-h-full flex-col justify-center py-6 text-center">
            <div className="mx-auto grid h-[92px] w-[92px] place-items-center rounded-full bg-brand-soft text-brand">
              <IconLocate className="h-10 w-10" />
            </div>
            <p className="mt-5 text-[14px] font-bold text-brand">준비 끝</p>
            <h1 className="mt-1 text-[30px] font-extrabold leading-tight tracking-[-0.5px]">
              내 위치에서
              <br />
              바로 걸어볼까요?
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-500">
              위치는 출발지·주변 그림자와 길 안내 중 내 위치를 확인할 때만 써요.
            </p>

            <div className="mt-7 flex flex-wrap justify-center gap-2">
              {prefChips(prefs).map((c) => (
                <span
                  key={c.label}
                  className={`rounded-xl px-3.5 py-2.5 text-[13px] font-bold ${CHIP_TONE[c.tone]}`}
                >
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="flex gap-2 px-5 pb-6 pt-2">
        {step > 0 && (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="rounded-2xl bg-[#EDEFF2] px-7 py-4 text-[15px] font-bold text-ink-700"
          >
            이전
          </button>
        )}
        <button
          onClick={() => (step === STEPS - 1 ? allowLocation() : setStep((s) => s + 1))}
          className="flex-1 rounded-2xl bg-[#1F2933] py-4 text-[16px] font-bold text-white active:bg-black"
        >
          {step === 0 ? "기능 살펴보기" : step === 1 ? "이대로 좋아요" : step === 2 ? "이해했어요" : "위치 허용하고 시작"}
        </button>
      </footer>
    </div>
  );
}
