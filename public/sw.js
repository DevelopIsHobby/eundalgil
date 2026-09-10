/**
 * 서비스 워커 — 껍데기만 캐시한다.
 *
 * 길찾기는 서버에서 도니 오프라인으로는 안 된다. 여기서 하는 일은 두 가지다.
 *   1) 홈 화면에서 눌렀을 때 흰 화면 없이 곧바로 뜨게 한다
 *   2) 지도 타일·경로 계산 같은 실제 데이터는 **절대 캐시하지 않는다** —
 *      그늘은 시각에 따라 달라지므로 묵은 답을 주면 틀린 안내가 된다
 */

const SHELL = "eundalgil-shell-v1";
/** 처음부터 갖고 있어야 첫 화면이 뜬다 */
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      // 하나라도 실패하면 설치가 통째로 무산되므로 개별로 담는다
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 남의 집(지도 타일·공공 API)은 건드리지 않는다
  if (url.origin !== self.location.origin) return;
  // 길찾기·검색·날씨는 늘 새로 받아야 한다
  if (url.pathname.startsWith("/api/")) return;

  /*
   * 그 밖(문서·스크립트·아이콘)은 네트워크를 먼저 보되, 성공하면 캐시를 갱신해 둔다.
   * 지하철에서 앱을 열었을 때 최소한 화면은 뜨게 하려는 것이다.
   */
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
