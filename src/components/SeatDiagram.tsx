"use client";

import type { SeatSide } from "@/lib/seat";

/**
 * 좌·우 자리 그림. 위쪽이 진행 방향이다.
 * `highlight` 를 주면 추천한 쪽을 채운다 (온보딩 설명에서는 비워 둔다).
 */
export default function SeatDiagram({
  highlight,
  compact,
}: {
  highlight?: SeatSide;
  compact?: boolean;
}) {
  const cell = (side: "left" | "right", i: number) => {
    const on = highlight === side;
    const dim = highlight && highlight !== "any" && !on;
    const base = side === "left" ? "#E7F7EE" : "#FFF1E0";
    const line = side === "left" ? "#0FA958" : "#F5A524";
    return (
      <span
        key={`${side}${i}`}
        className="block rounded-[5px] border"
        style={{
          width: compact ? 22 : 30,
          height: compact ? 10 : 13,
          background: on ? line : base,
          borderColor: line,
          opacity: dim ? 0.35 : 1,
        }}
      />
    );
  };

  return (
    <div
      className="rounded-[14px] border border-line bg-white px-3 py-2.5"
      style={{ width: "fit-content" }}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex flex-col gap-1.5">{[0, 1, 2].map((i) => cell("left", i))}</div>
        <div className="flex flex-col items-center text-[10px] text-ink-400">
          <span aria-hidden>↑</span>
          <span className="mt-0.5 whitespace-nowrap">진행</span>
        </div>
        <div className="flex flex-col gap-1.5">{[0, 1, 2].map((i) => cell("right", i))}</div>
      </div>
      <div className="mt-2 flex justify-between text-[10px] font-semibold">
        <span className={highlight === "left" ? "text-brand" : "text-ink-400"}>왼쪽</span>
        <span className={highlight === "right" ? "text-sun" : "text-ink-400"}>오른쪽</span>
      </div>
    </div>
  );
}
