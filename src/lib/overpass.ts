/**
 * Overpass API 클라이언트 (서버 전용).
 *
 * 공개 미러는 망 환경에 따라 아무 응답 없이 막히는 경우가 흔하다.
 * 그래서 순차 재시도 대신 "지연 헤지(staggered hedging)"를 쓴다.
 * 1번 미러를 먼저 부르고, STAGGER_MS 안에 응답이 없으면 2번을 겹쳐 부르는 식으로
 * 가장 먼저 성공한 응답을 채택하고 나머지는 즉시 취소한다.
 */

/*
 * 미러를 늘려 봤지만 아무거나 넣으면 안 된다.
 * overpass.osm.ch 는 200 에 빈 몸통을 1초 만에 돌려주고(작은 미러라 우리 쿼리를
 * 감당하지 못한다), overpass.osm.jp 는 연결 자체가 되지 않았다.
 * 그런 미러가 먼저 답하면 "이 동네에는 길이 없다" 는 결과를 받게 된다.
 */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/**
 * 다음 미러를 겹쳐 부르기까지 기다리는 시간.
 * 미러가 곧바로 실패하면(429·503 등) 기다리지 않고 바로 다음을 부른다 —
 * 공개 미러는 붐빌 때 즉시 거절하는데, 그때마다 7초씩 흘려보내면 안 된다.
 */
const STAGGER_MS = 4_000;
/**
 * 한 요청의 상한.
 * 길게 잡으면 붐비는 미러 하나에 그만큼 매달린다 — 그 사이 다른 미러는 이미
 * 답했을 수도 있다. 넉넉하되 무한정 기다리지는 않을 만큼만 준다.
 */
const REQUEST_TIMEOUT_MS = 45_000;

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
  const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
  /*
   * 붐비는 미러는 오류 대신 200 에 remark 만 담아 돌려준다
   * ("runtime error: Query timed out"). 그걸 정상으로 받으면 빈 결과가 그대로 흘러간다.
   */
  if (json.remark) throw new Error(json.remark.slice(0, 60));
  const elements = json.elements ?? [];
  // 도시 범위를 물었는데 아무것도 없으면 미러가 제대로 못 답한 것이다. 다음 미러로 넘긴다
  if (!elements.length) throw new Error("빈 응답");
  return elements;
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

    /** 아직 부르지 않은 미러 중 다음 것을 곧바로 부른다 */
    let next = 0;
    const started = new Set<number>();

    const startAt = (i: number) => {
      if (settled || i >= order.length || started.has(i)) return;
      started.add(i);
      if (i >= next) next = i + 1;
      const url = order[i];
      const ctl = controllers[i];
      const hardStop = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      timers.push(hardStop);
      askOne(url, query, ctl.signal)
        .then((elements) => finish({ url, elements }))
        .catch((err) => {
          if (settled) return;
          errors.push(`${host(url)} ${shortError(err)}`);
          // 거절당한 미러를 기다릴 이유가 없다. 곧장 다음 미러로 넘어간다
          startAt(next);
          if (--pending === 0) finish(null);
        })
        .finally(() => clearTimeout(hardStop));
    };

    startAt(0);
    // 아무 소식이 없는 경우에 대비해, 정해진 간격으로도 하나씩 더 겹쳐 부른다
    for (let i = 1; i < order.length; i++) {
      timers.push(setTimeout(() => startAt(i), STAGGER_MS * i));
    }
  });

  if (!winner) throw new Error(`지도 데이터 서버에 연결하지 못했습니다 (${errors.join(", ")})`);
  preferred = winner.url;
  return winner.elements;
}
