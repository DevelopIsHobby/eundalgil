"use client";

import type { Place } from "@/lib/store";
import { IconClose } from "./icons";

/**
 * 검색해서 고른 장소를 보여주고, 출발지로 쓸지 도착지로 쓸지 고르게 한다.
 * 예전에는 검색 결과를 고르면 무조건 도착지가 됐는데, 집에서 출발하는 경우처럼
 * 고른 곳이 출발지인 경우가 흔해서 매번 바꿔 넣어야 했다.
 */
export default function PlaceCard({
  place,
  onOrigin,
  onDestination,
  onClose,
}: {
  place: Place;
  onOrigin: () => void;
  onDestination: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pointer-events-auto rounded-t-sheet bg-white px-4 pb-3 pt-3 shadow-sheet">
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold">{place.name}</div>
          {place.address && (
            <div className="truncate text-[13px] text-ink-500">{place.address}</div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="닫기"
          className="-mr-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-400 active:bg-[#F2F4F6]"
        >
          <IconClose className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onOrigin}
          className="h-11 flex-1 rounded-lg border border-brand bg-white text-[15px] font-bold text-brand active:bg-brand-soft"
        >
          출발지로
        </button>
        <button
          onClick={onDestination}
          className="h-11 flex-1 rounded-lg bg-brand text-[15px] font-bold text-white active:opacity-90"
        >
          도착지로
        </button>
      </div>
    </div>
  );
}
