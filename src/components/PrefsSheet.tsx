"use client";

import { useApp } from "@/lib/store";
import PrefControls from "./PrefControls";
import { IconClose } from "./icons";

/** 온보딩에서 고른 취향을 나중에 다시 여는 화면 */
export default function PrefsSheet() {
  const { prefs, setPrefs, openPrefs } = useApp();

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F7F8F9]">
      <header className="flex items-center gap-2 border-b border-line bg-white px-3 py-3">
        <button
          onClick={() => openPrefs(false)}
          aria-label="닫기"
          className="grid h-9 w-9 place-items-center rounded-full text-ink-700 active:bg-[#F2F4F6]"
        >
          <IconClose />
        </button>
        <h2 className="text-[17px] font-bold">길 취향</h2>
        <span className="ml-auto text-[12px] text-ink-400">바꾸면 바로 경로에 반영돼요</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <PrefControls prefs={prefs} onChange={setPrefs} />
        <p className="px-1 pb-2 pt-4 text-[12px] leading-relaxed text-ink-400">
          햇빛 취향과 우회 허용 정도는 경로 비용에 곧바로 들어갑니다. 언덕은 지형 고도에서 구한
          오르막에, 계단·큰길·방범시설은 각 길의 속성에 붙습니다.
        </p>
      </div>

      <footer className="border-t border-line bg-white px-4 pb-6 pt-3">
        <button
          onClick={() => openPrefs(false)}
          className="w-full rounded-2xl bg-brand py-4 text-[16px] font-bold text-white active:bg-brand-dark"
        >
          완료
        </button>
      </footer>
    </div>
  );
}
