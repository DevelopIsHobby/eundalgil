/**
 * Overpass API 클라이언트 (서버 전용).
 *
 * 공개 미러는 망 환경에 따라 아무 응답 없이 막히는 경우가 흔하다.
 * 그래서 순차 재시도 대신 "지연 헤지(staggered hedging)"를 쓴다.
 * 1번 미러를 먼저 부르고, STAGGER_MS 안에 응답이 없으면 2번을 겹쳐 부르는 식으로
 * 가장 먼저 성공한 응답을 채택하고 나머지는 즉시 취소한다.
 */

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** 다음 미러를 겹쳐 부르기까지 기다리는 시간 */
const STAGGER_MS = 7_000;
/** 한 요청의 상한 */
const REQUEST_TIMEOUT_MS = 75_000;

/** 마지막으로 성공한 미러를 기억해 다음 요청에서 먼저 시도한다 */
let preferred = ENDPOINTS[0];

export type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  /** 관계(relation)의 멤버 목록 — 노선의 정류장 순서를 읽는 데 쓴다 */
  members?: { type: string; ref: number; role: string }[];
};

function host(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function shortError(err: unknown) {
  const e = err as { name?: string; cause?: { code?: string }; message?: string };
  return e?.cause?.code ?? e?.name ?? e?.message ?? "unknown";
}

async function askOne(url: string, query: string, signal: AbortSignal): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      // UA 없는 요청을 거부하는 미러가 있다
      "User-Agent": "eundalgil-shade-walk/0.1 (OSM data client)",
    },
    body: new URLSearchParams({ data: query }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { elements?: OverpassElement[] };
  return json.elements ?? [];
}

export async function overpass(query: string): Promise<OverpassElement[]> {
  const order = [preferred, ...ENDPOINTS.filter((e) => e !== preferred)];
  const controllers = order.map(() => new AbortController());
  const errors: string[] = [];

  const winner = await new Promise<{ url: string; elements: OverpassElement[] } | null>((resolve) => {
    let settled = false;
    let pending = order.length;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = (value: { url: string; elements: OverpassElement[] } | null) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      controllers.forEach((c) => c.abort());
      resolve(value);
    };

    order.forEach((url, i) => {
      const start = () => {
        if (settled) return;
        const ctl = controllers[i];
        const hardStop = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
        timers.push(hardStop);
        askOne(url, query, ctl.signal)
          .then((elements) => finish({ url, elements }))
          .catch((err) => {
            if (!settled) errors.push(`${host(url)} ${shortError(err)}`);
            if (--pending === 0) finish(null);
          })
          .finally(() => clearTimeout(hardStop));
      };
      if (i === 0) start();
      else timers.push(setTimeout(start, STAGGER_MS * i));
    });
  });

  if (!winner) throw new Error(`지도 데이터 서버에 연결하지 못했습니다 (${errors.join(", ")})`);
  preferred = winner.url;
  return winner.elements;
}
