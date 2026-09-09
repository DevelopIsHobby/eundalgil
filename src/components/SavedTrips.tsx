"use client";

import { useApp } from "@/lib/store";
import { IconBookmark, IconChevronRight } from "./icons";

/**
 * 저장해 둔 길. 홈에서 한 번 눌러 바로 다시 찾는다.
 * 경로가 아니라 출발·도착만 저장해 두므로, 누르면 **지금 시각·지금 취향**으로 새로 찾는다.
 */
export default function SavedTrips() {
  const { saved, setOrigin, setDestination, setScreen } = useApp();
  if (!saved.length) return null;

  return (
    <div className="no-scrollbar pointer-events-auto mb-2 flex gap-2 overflow-x-auto px-3">
      {saved.slice(0, 8).map((t) => (
        <button
          key={t.id}
          onClick={() => {
            setOrigin(t.origin);
            setDestination(t.destination);
            setScreen("routeInput");
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white py-2 pl-3 pr-2.5 text-[13px] shadow-card"
        >
          <IconBookmark className="h-[15px] w-[15px] shrink-0 text-brand" />
          <span className="max-w-[46vw] truncate font-semibold">
            {t.origin.name} → {t.destination.name}
          </span>
          <IconChevronRight className="h-[14px] w-[14px] shrink-0 text-ink-300" />
        </button>
      ))}
    </div>
  );
}
