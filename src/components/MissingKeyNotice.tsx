"use client";

import { BRAND } from "@/lib/config";

export default function MissingKeyNotice() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[#EDF0F3] p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-card">
        <div className="mb-1 text-lg font-bold">{BRAND.name} 지도 키가 필요해요</div>
        <p className="mb-4 text-sm leading-relaxed text-ink-500">
          네이버 지도 타일을 쓰려면 클라우드 플랫폼에서 발급한 키가 있어야 합니다. 무료 쿼터로 개발에는
          충분합니다.
        </p>
        <ol className="mb-4 space-y-2 text-sm leading-relaxed text-ink-700">
          <li>
            <b>1.</b>{" "}
            <a
              className="text-brand underline"
              href="https://console.ncloud.com/naver-service/application"
              target="_blank"
              rel="noreferrer"
            >
              네이버 클라우드 콘솔
            </a>
            에서 Application 등록 → <b>Maps</b> 선택
          </li>
          <li>
            <b>2.</b> Web 서비스 URL에 <code className="rounded bg-[#F2F4F6] px-1">http://localhost:3000</code> 추가
          </li>
          <li>
            <b>3.</b> 프로젝트 루트에 <code className="rounded bg-[#F2F4F6] px-1">.env.local</code> 생성 후 아래 한 줄
          </li>
        </ol>
        <pre className="overflow-x-auto rounded-lg bg-[#1A1A1A] p-3 text-[12px] leading-relaxed text-[#E6E6E6]">
          NEXT_PUBLIC_NAVER_MAP_KEY_ID=발급받은_Client_ID
        </pre>
        <p className="mt-3 text-xs text-ink-400">저장 후 개발 서버를 다시 시작하면 지도가 나타납니다.</p>
      </div>
    </div>
  );
}
