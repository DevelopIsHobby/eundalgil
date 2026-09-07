"use client";

import { useEffect, useState } from "react";

const SCRIPT_ID = "naver-maps-sdk";

export type ScriptState = "missing-key" | "loading" | "ready" | "error";

/**
 * 네이버 지도 v3 스크립트를 한 번만 로드한다.
 * 키가 없으면 'missing-key' 를 돌려주고, 화면에서 안내로 대체한다.
 */
export function useNaverScript(): ScriptState {
  const [state, setState] = useState<ScriptState>(() =>
    process.env.NEXT_PUBLIC_NAVER_MAP_KEY_ID ? "loading" : "missing-key"
  );

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_NAVER_MAP_KEY_ID;
    if (!key) return;
    if (window.naver?.maps) {
      setState("ready");
      return;
    }

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const onLoad = () => setState(window.naver?.maps ? "ready" : "error");
    const onError = () => setState("error");

    if (existing) {
      existing.addEventListener("load", onLoad);
      existing.addEventListener("error", onError);
      return () => {
        existing.removeEventListener("load", onLoad);
        existing.removeEventListener("error", onError);
      };
    }

    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.async = true;
    s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}&submodules=geocoder`;
    s.addEventListener("load", onLoad);
    s.addEventListener("error", onError);
    document.head.appendChild(s);

    return () => {
      s.removeEventListener("load", onLoad);
      s.removeEventListener("error", onError);
    };
  }, []);

  return state;
}
