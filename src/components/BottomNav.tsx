"use client";

import { useApp } from "@/lib/store";
import { IconBookmark, IconCompass, IconHome, IconUser, IconWalk } from "./icons";

const TABS = [
  { id: "home", label: "홈", icon: IconHome },
  { id: "route", label: "길찾기", icon: IconWalk },
  { id: "save", label: "저장", icon: IconBookmark },
  { id: "around", label: "주변", icon: IconCompass },
  { id: "my", label: "MY", icon: IconUser },
] as const;

export default function BottomNav() {
  const { screen, setScreen, showToast } = useApp();
  const current = screen === "browse" ? "home" : "route";

  return (
    <nav className="pointer-events-auto flex h-14 items-stretch border-t border-line bg-white">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = t.id === current;
        return (
          <button
            key={t.id}
            onClick={() => {
              if (t.id === "home") setScreen("browse");
              else if (t.id === "route") setScreen("routeInput");
              else showToast("다음 업데이트에서 만나요.");
            }}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] ${
              active ? "font-bold text-brand" : "text-ink-400"
            }`}
          >
            <Icon className="h-[22px] w-[22px]" />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
