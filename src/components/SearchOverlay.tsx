"use client";

import { useEffect, useRef, useState } from "react";
import type { PlaceHit } from "@/app/api/search/route";
import { useDebounced } from "@/lib/useDebounced";
import type { Place } from "@/lib/store";
import { IconBack, IconClose, IconLocate, IconSearch } from "./icons";

const RECENT_KEY = "eundalgil.recent";

function loadRecent(): Place[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent(p: Place) {
  try {
    const list = loadRecent().filter((x) => x.name !== p.name);
    list.unshift(p);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* 저장 공간이 막혀 있어도 검색 자체는 동작해야 한다 */
  }
}

export default function SearchOverlay({
  title,
  initial = "",
  onPick,
  onClose,
  onUseCurrent,
}: {
  title: string;
  initial?: string;
  onPick: (p: Place) => void;
  onClose: () => void;
  onUseCurrent?: () => void;
}) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<Place[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(q, 300);

  useEffect(() => {
    setRecent(loadRecent());
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 2) {
      setHits([]);
      setErr(null);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((j) => {
        setHits(j.hits ?? []);
        setErr(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr("검색에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [debounced]);

  const pick = (p: Place) => {
    saveRecent(p);
    onPick(p);
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-line px-2 py-2">
        <button
          onClick={onClose}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-700 active:bg-[#F2F4F6]"
          aria-label="닫기"
        >
          <IconBack />
        </button>
        <div className="flex h-10 flex-1 items-center gap-2 rounded-lg bg-[#F2F4F6] px-3">
          <IconSearch className="h-[18px] w-[18px] shrink-0 text-ink-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={title}
            className="w-full bg-transparent text-[15px] outline-none placeholder:text-ink-400"
          />
          {q && (
            <button onClick={() => setQ("")} aria-label="지우기" className="text-ink-400">
              <IconClose className="h-[18px] w-[18px]" />
            </button>
          )}
        </div>
      </div>

      {onUseCurrent && (
        <button
          onClick={onUseCurrent}
          className="flex items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-[#F7F8F9]"
        >
          <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-soft text-brand">
            <IconLocate className="h-[18px] w-[18px]" />
          </span>
          <span className="text-[15px] font-medium text-brand">현재 위치로 설정</span>
        </button>
      )}

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && <div className="px-4 py-4 text-sm text-ink-400">검색 중…</div>}
        {err && <div className="px-4 py-4 text-sm text-[#D9432F]">{err}</div>}

        {!q.trim() && recent.length > 0 && (
          <>
            <div className="px-4 pb-1 pt-4 text-xs font-semibold text-ink-400">최근 검색</div>
            {recent.map((r, i) => (
              <button
                key={i}
                onClick={() => pick(r)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-[#F7F8F9]"
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[#F2F4F6] text-ink-400">
                  <IconSearch className="h-[16px] w-[16px]" />
                </span>
                <span className="truncate text-[15px]">{r.name}</span>
              </button>
            ))}
          </>
        )}

        {hits.map((h) => (
          <button
            key={h.id}
            onClick={() => pick({ name: h.name, address: h.address, p: [h.lng, h.lat] })}
            className="flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left active:bg-[#F7F8F9]"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-medium">{h.name}</div>
              <div className="truncate text-[13px] text-ink-500">{h.address}</div>
            </div>
            {h.category && (
              <span className="mt-0.5 shrink-0 rounded bg-[#F2F4F6] px-1.5 py-0.5 text-[11px] text-ink-500">
                {h.category}
              </span>
            )}
          </button>
        ))}

        {!loading && !err && debounced.trim().length >= 2 && hits.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-ink-400">검색 결과가 없습니다.</div>
        )}
      </div>
    </div>
  );
}
