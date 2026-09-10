"use client";

import { useEffect } from "react";

/**
 * 서비스 워커 등록 — 홈 화면에 설치했을 때 첫 화면이 곧바로 뜨게 한다.
 *
 * 개발 중에는 등록하지 않는다. 워커가 한 번 자리를 잡으면 dev 서버를 내렸다 올려도
 * 남아 있어서, 고친 게 왜 안 보이는지 한참 헤매게 된다.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // 첫 화면 그리기와 경쟁하지 않게 로드가 끝난 뒤에 붙인다
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 사파리 사생활 보호 모드 등에서 거절될 수 있다. 없어도 앱은 그대로 동작한다 */
      });
    };
    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
