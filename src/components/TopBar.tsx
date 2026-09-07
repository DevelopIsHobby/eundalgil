"use client";

import { BRAND } from "@/lib/config";
import { useApp } from "@/lib/store";
import { IconMenu, IconMic, IconSearch, IconStairs, IconSun, IconTree, IconWalk } from "./icons";

function Chip({
  active,
  primary,
  onClick,
  icon,
  children,
}: {
  active?: boolean;
  primary?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const tone = primary
    ? "border-brand bg-brand text-white"
    : active
      ? "border-brand bg-brand-soft text-brand"
      : "border-line-strong bg-white text-ink-700";
  return (
    <button
      onClick={onClick}
      aria-pressed={primary ? undefined : !!active}
      className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[13px] font-medium shadow-sm transition-colors ${tone}`}
    >
      <span className="[&>svg]:h-[15px] [&>svg]:w-[15px]">{icon}</span>
      {children}
    </button>
  );
}

export default function TopBar({ onSearch }: { onSearch: () => void }) {
  const { showShadow, showTrees, avoidSteps, toggle, setScreen } = useApp();

  return (
    <div className="pointer-events-auto px-3 pt-3">
      <div className="flex h-11 items-center gap-2 rounded-lg bg-white pl-2 pr-1 shadow-card">
        <button className="grid h-8 w-8 place-items-center text-ink-700" aria-label="메뉴">
          <IconMenu />
        </button>
        <button
          onClick={onSearch}
          className="flex-1 text-left text-[15px] text-ink-400"
        >
          장소, 주소 검색
        </button>
        <button className="grid h-8 w-8 place-items-center text-ink-500" aria-label="음성 검색">
          <IconMic />
        </button>
        <button
          onClick={onSearch}
          className="grid h-9 w-9 place-items-center rounded-md text-brand"
          aria-label="검색"
        >
          <IconSearch />
        </button>
      </div>

      <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
        <Chip primary onClick={() => setScreen("routeInput")} icon={<IconWalk />}>
          길찾기
        </Chip>
        <Chip active={showShadow} onClick={() => toggle("showShadow")} icon={<IconSun />}>
          그늘
        </Chip>
        <Chip active={showTrees} onClick={() => toggle("showTrees")} icon={<IconTree />}>
          가로수
        </Chip>
        <Chip active={avoidSteps} onClick={() => toggle("avoidSteps")} icon={<IconStairs />}>
          계단 회피
        </Chip>
      </div>

      <span className="sr-only">
        {BRAND.name} — {BRAND.tagline}
      </span>
    </div>
  );
}
