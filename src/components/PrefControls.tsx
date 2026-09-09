"use client";

import { PREF_OPTIONS, type Prefs } from "@/lib/prefs";
import { IconDetour, IconHill, IconLeaf, IconPeople, IconShield, IconStairs, IconWalk } from "./icons";

/** 세 갈래 중 하나를 고르는 막대. 온보딩과 설정에서 같은 걸 쓴다. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  name,
}: {
  value: T;
  options: readonly { id: string; label: string }[];
  onChange: (v: T) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="flex gap-1 rounded-xl bg-[#F2F4F6] p-1">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id as T)}
            className={`flex-1 rounded-lg py-2.5 text-[14px] font-semibold transition-colors ${
              active ? "bg-brand-soft text-brand shadow-sm" : "text-ink-500"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Card({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-brand [&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>
        <h3 className="text-[15px] font-bold">{title}</h3>
      </div>
      {hint && <p className="-mt-2 mb-3 text-[12px] text-ink-400">{hint}</p>}
      {children}
    </section>
  );
}

/** 취향 편집 폼 — 온보딩 2단계와 설정 시트가 함께 쓴다 */
export default function PrefControls({
  prefs,
  onChange,
}: {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
}) {
  return (
    <div className="space-y-3">
      <Card icon={<IconLeaf />} title="햇빛 취향" hint="계절이 바뀌어도 원하는 쪽으로">
        <Segmented
          name="햇빛 취향"
          value={prefs.sun}
          options={PREF_OPTIONS.sun}
          onChange={(sun) => onChange({ sun })}
        />
      </Card>

      <Card icon={<IconHill />} title="언덕">
        <Segmented
          name="언덕"
          value={prefs.hill}
          options={PREF_OPTIONS.hill}
          onChange={(hill) => onChange({ hill })}
        />
      </Card>

      <Card icon={<IconStairs />} title="계단">
        <Segmented
          name="계단"
          value={prefs.steps}
          options={PREF_OPTIONS.steps}
          onChange={(steps) => onChange({ steps })}
        />
        <label className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[14px]">
          <span>계단 있는 길 완전 제외</span>
          <input
            type="checkbox"
            checked={prefs.excludeSteps}
            onChange={(e) => onChange({ excludeSteps: e.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className={`relative h-[26px] w-[46px] rounded-full transition-colors ${
              prefs.excludeSteps ? "bg-brand" : "bg-[#DDE1E6]"
            }`}
          >
            <span
              className={`absolute top-[3px] h-5 w-5 rounded-full bg-white shadow transition-all ${
                prefs.excludeSteps ? "left-[23px]" : "left-[3px]"
              }`}
            />
          </span>
        </label>
      </Card>

      <Card icon={<IconWalk />} title="걷는 속도" hint="소요 시간이 몸에 맞아야 계획이 선다">
        <Segmented
          name="걷는 속도"
          value={prefs.pace}
          options={PREF_OPTIONS.pace}
          onChange={(pace) => onChange({ pace })}
        />
      </Card>

      <Card icon={<IconPeople />} title="길 분위기">
        <Segmented
          name="길 분위기"
          value={prefs.vibe}
          options={PREF_OPTIONS.vibe}
          onChange={(vibe) => onChange({ vibe })}
        />
      </Card>

      <Card icon={<IconDetour />} title="조금 돌아가도 괜찮은 정도">
        <Segmented
          name="우회 허용"
          value={prefs.detour}
          options={PREF_OPTIONS.detour}
          onChange={(detour) => onChange({ detour })}
        />
      </Card>

      <Card icon={<IconShield />} title="방범시설 많은 길 안내 (야간 전용)">
        <Segmented
          name="야간 방범"
          value={prefs.nightSafety ? "on" : "off"}
          options={[
            { id: "off", label: "사용 안 함" },
            { id: "on", label: "사용" },
          ]}
          onChange={(v) => onChange({ nightSafety: v === "on" })}
        />
      </Card>
    </div>
  );
}
