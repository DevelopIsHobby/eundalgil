"use client";

import { useApp } from "@/lib/store";
import { IconBack, IconSwap } from "./icons";

export default function RouteHeader({
  onEdit,
  onClose,
}: {
  onEdit: (which: "origin" | "destination") => void;
  onClose: () => void;
}) {
  const { origin, destination, swapEnds } = useApp();

  const Field = ({
    which,
    dotClass,
    placeholder,
    value,
  }: {
    which: "origin" | "destination";
    dotClass: string;
    placeholder: string;
    value?: string;
  }) => (
    <button
      onClick={() => onEdit(which)}
      className="flex h-10 w-full items-center gap-2 rounded-lg bg-white px-3 text-left"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
      <span className={`truncate text-[14px] ${value ? "text-ink-900" : "text-ink-400"}`}>
        {value || placeholder}
      </span>
    </button>
  );

  return (
    <div className="pointer-events-auto bg-brand px-2 pb-3 pt-3 shadow-card">
      <div className="flex items-start gap-1">
        <button
          onClick={onClose}
          aria-label="뒤로"
          className="mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 active:bg-white/15"
        >
          <IconBack />
        </button>

        <div className="flex flex-1 flex-col gap-1.5">
          <Field
            which="origin"
            dotClass="bg-brand"
            placeholder="출발지 입력"
            value={origin?.name}
          />
          <Field
            which="destination"
            dotClass="bg-route-fast"
            placeholder="도착지 입력"
            value={destination?.name}
          />
        </div>

        <button
          onClick={swapEnds}
          aria-label="출발지와 도착지 바꾸기"
          className="mt-3 grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/90 active:bg-white/15"
        >
          <IconSwap />
        </button>
      </div>
    </div>
  );
}
