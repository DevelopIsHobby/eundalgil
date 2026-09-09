import { LngLat, distMeters, EARTH_M_PER_DEG_LAT, mPerDegLon, resample } from "./geo";
import type { WalkWay } from "./osm";
import type { ShadeIndex } from "./shadow";
import type { SafetyIndex } from "./safety";
import { FASTEST_WEIGHTS, weightsAreNeutral, type RouteWeights } from "./prefs";

export type Edge = {
  to: number;
  /** 이 방향에서의 좌표열 (from → to) */
  path: LngLat[];
  length: number;
  kind: WalkWay["kind"];
  covered: boolean;
  /** 0~1 그늘 비율 (applyShade 이후 채워짐) */
  shade: number;
  /** 0~1 방범시설 근접도 (applySafety 이후 채워짐) */
  safety: number;
  /** 이 방향으로 갈 때 올라가는 높이(m). 내리막이면 0 */
  climb: number;
  /** 차량이 많은 큰길인지 — "길 분위기" 취향에 쓴다 */
  major: boolean;
  name?: string;
};

export type Graph = {
  nodes: LngLat[];
  adj: Edge[][];
  /** 격자 인덱스: 셀키 → 노드 인덱스 목록 */
  grid: Map<string, number[]>;
  cellLng: number;
  cellLat: number;
  /**
   * 노드가 속한 연결 덩어리 번호.
   * 보행로 데이터는 통째로 이어져 있지 않다 — 대학 캠퍼스 안길처럼 바깥과 끊긴 섬이 흔하다.
   * 출발·도착을 각자 가장 가까운 노드에 붙이면 서로 다른 섬에 앉아 경로가 "없다" 고 나온다.
   */
  comp: Int32Array;
};

const KEY_PRECISION = 7;
const nodeKey = (p: LngLat) => `${p[0].toFixed(KEY_PRECISION)},${p[1].toFixed(KEY_PRECISION)}`;

/** 도로 종류별 보행 속도 배율 (1 = 평범한 인도) */
const KIND_SPEED: Record<WalkWay["kind"], number> = {
  footway: 1.0,
  park: 1.05,
  crossing: 0.9,
  steps: 0.45,
  road: 0.95, // 차도 갓길
  // 램프는 갓길도 신호도 없는 차량 전용 갈래길이다. 지날 수는 있지만 마지막 수단이 되게 한다
  ramp: 0.6,
  /*
   * 산길(포장 안 된 path·track). 흙길·급경사·가로등 없음이 겹친다.
   * 거리로만 보면 언제나 지름길이라, 0.5 정도로는 200m 쯤 돌아가는 정상적인 길에 계속 이겼다.
   * 도심 보행 경로로 쓸 길이 아니므로 크게 깎는다. 그래도 아주 막지는 않는다 —
   * 산길 말고는 북쪽으로 이어지는 길이 없는 동네가 실제로 있다.
   */
  trail: 0.15,
  /*
   * 차도 터널의 보도. 걸을 수는 있다 (상도터널이 그렇다).
   * 다만 시끄럽고 매연이 있어 선뜻 고를 길은 아니므로, 돌아가는 길이 크게 길 때만
   * 이기도록 눌러 둔다. 터널은 늘 그늘이라 그늘 가산은 붙지 않는다.
   */
  tunnel: 0.55,
};

/** 횡단보도 한 곳당 평균 대기 시간(초) */
const CROSSING_WAIT_S = 8;

/**
 * 1m 올라갈 때 더 드는 시간(초). 등산에서 쓰는 네이스미스 규칙(600m 오르는 데 1시간)을
 * 그대로 가져왔다. 내리막은 더하지 않는다 — 빨라지긴 해도 무릎이 힘든 건 별개라 0으로 둔다.
 */
const ASCENT_SEC_PER_M = 3600 / 600;

/**
 * 기준 보행 속도. 1.25m/s(4.5km/h)는 평지를 성큼성큼 걷는 속도라 국내 지도 앱보다
 * 3분쯤 짧게 나왔다. (상도동 855m 구간: 우리 13분 / 네이버 15~16분)
 * 우리는 경사를 비용에 넣지 않으므로, 오르내림이 섞인 실제 보행을 평균으로 흡수하는
 * 1.0m/s(3.6km/h)로 잡아 국내 앱 표기와 맞춘다.
 */
const WALK_SPEED_MPS = 1.0;

/** 가장 빠른 노면 기준 1m 당 최소 소요 시간 — A* 휴리스틱이 실제 비용을 넘지 않게 하는 데 쓴다 */
const MIN_SEC_PER_M = 1 / (WALK_SPEED_MPS * Math.max(...Object.values(KIND_SPEED)));

export function buildGraph(ways: WalkWay[], refLat = 37.5, cellMeters = 80): Graph {
  const index = new Map<string, number>();
  const nodes: LngLat[] = [];
  const adj: Edge[][] = [];

  const idOf = (p: LngLat) => {
    const k = nodeKey(p);
    const found = index.get(k);
    if (found !== undefined) return found;
    const id = nodes.length;
    index.set(k, id);
    nodes.push(p);
    adj.push([]);
    return id;
  };

  for (const w of ways) {
    for (let i = 1; i < w.path.length; i++) {
      const a = w.path[i - 1];
      const b = w.path[i];
      const len = distMeters(a, b);
      if (len < 0.3) continue;
      const ia = idOf(a);
      const ib = idOf(b);
      if (ia === ib) continue;
      const base = {
        length: len,
        kind: w.kind,
        covered: !!w.covered,
        major: !!w.major,
        shade: 0,
        safety: 0,
        name: w.name,
      };
      // 고도 차이는 방향에 따라 한쪽만 오르막이다
      const rise = w.elev ? w.elev[i] - w.elev[i - 1] : 0;
      adj[ia].push({ ...base, to: ib, path: [a, b], climb: Math.max(0, rise) });
      adj[ib].push({ ...base, to: ia, path: [b, a], climb: Math.max(0, -rise) });
    }
  }

  const cellLat = cellMeters / EARTH_M_PER_DEG_LAT;
  const cellLng = cellMeters / mPerDegLon(refLat);
  const grid = new Map<string, number[]>();
  nodes.forEach((p, i) => {
    const k = `${Math.floor(p[0] / cellLng)}:${Math.floor(p[1] / cellLat)}`;
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  });

  // 연결 덩어리 번호 매기기 (너비 우선)
  const comp = new Int32Array(nodes.length).fill(-1);
  let next = 0;
  const queue: number[] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (comp[start] !== -1) continue;
    const id = next++;
    comp[start] = id;
    queue.length = 0;
    queue.push(start);
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head];
      for (const e of adj[u]) {
        if (comp[e.to] !== -1) continue;
        comp[e.to] = id;
        queue.push(e.to);
      }
    }
  }

  return { nodes, adj, grid, cellLng, cellLat, comp };
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** 각 간선의 그늘 비율을 계산해 채운다 */
export function applyShade(graph: Graph, shade: ShadeIndex) {
  const memo = new Map<string, number>();
  for (let i = 0; i < graph.adj.length; i++) {
    for (const e of graph.adj[i]) {
      if (e.covered) {
        e.shade = 1;
        continue;
      }
      const a = e.path[0];
      const b = e.path[e.path.length - 1];
      // 양방향 간선이 같은 값을 공유하도록 정규화된 키를 쓴다
      const k =
        a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
          ? `${nodeKey(a)}|${nodeKey(b)}`
          : `${nodeKey(b)}|${nodeKey(a)}`;
      const cached = memo.get(k);
      if (cached !== undefined) {
        e.shade = cached;
        continue;
      }
      const samples = e.length > 14 ? resample(e.path, 7) : [midpoint(a, b)];
      let sum = 0;
      for (const s of samples) sum += shade.shadeAt(s);
      const v = sum / samples.length;
      memo.set(k, v);
      e.shade = v;
    }
  }
}

/**
 * 각 간선의 방범시설(가로등·CCTV·비상벨) 근접도를 채운다.
 * 야간에 "방범시설 많은 길" 취향을 켰을 때만 쓰이므로 그때만 부른다.
 */
export function applySafety(graph: Graph, safety: SafetyIndex) {
  const memo = new Map<string, number>();
  for (let i = 0; i < graph.adj.length; i++) {
    for (const e of graph.adj[i]) {
      const a = e.path[0];
      const b = e.path[e.path.length - 1];
      const k =
        a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
          ? `${nodeKey(a)}|${nodeKey(b)}`
          : `${nodeKey(b)}|${nodeKey(a)}`;
      const cached = memo.get(k);
      if (cached !== undefined) {
        e.safety = cached;
        continue;
      }
      const samples = e.length > 30 ? resample(e.path, 15) : [midpoint(a, b)];
      let sum = 0;
      for (const s of samples) sum += safety.coverAt(s);
      const v = sum / samples.length;
      memo.set(k, v);
      e.safety = v;
    }
  }
}

/** 좌표 주변의 그래프 노드들을 가까운 순으로 (반경 내) */
function nearbyNodes(graph: Graph, p: LngLat, maxMeters: number, limit = 16): number[] {
  const cx = Math.floor(p[0] / graph.cellLng);
  const cy = Math.floor(p[1] / graph.cellLat);
  const found: { i: number; d: number }[] = [];
  const rings = Math.max(2, Math.ceil(maxMeters / 80));
  for (let x = cx - rings; x <= cx + rings; x++) {
    for (let y = cy - rings; y <= cy + rings; y++) {
      const arr = graph.grid.get(`${x}:${y}`);
      if (!arr) continue;
      for (const i of arr) {
        const d = distMeters(p, graph.nodes[i]);
        if (d <= maxMeters) found.push({ i, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, limit).map((f) => f.i);
}

/**
 * 출발·도착을 **서로 이어진** 노드에 붙인다.
 * 각자 가장 가까운 노드에 붙이면 캠퍼스 안길 같은 섬에 앉아 "경로 없음" 이 되기 쉽다.
 * 조금 더 걸어 나오더라도 같은 덩어리에 있는 조합을 고른다.
 */
export function snapPair(
  graph: Graph,
  a: LngLat,
  b: LngLat,
  maxMeters = 350
): [number, number] | null {
  const as = nearbyNodes(graph, a, maxMeters);
  const bs = nearbyNodes(graph, b, maxMeters);
  let best: [number, number] | null = null;
  let bestCost = Infinity;
  for (const i of as) {
    for (const j of bs) {
      if (i === j || graph.comp[i] !== graph.comp[j]) continue;
      const cost = distMeters(a, graph.nodes[i]) + distMeters(b, graph.nodes[j]);
      if (cost < bestCost) {
        bestCost = cost;
        best = [i, j];
      }
    }
  }
  return best;
}

/** 좌표에서 가장 가까운 그래프 노드 (반경 내 없으면 -1) */
export function snap(graph: Graph, p: LngLat, maxMeters = 250): number {
  const cx = Math.floor(p[0] / graph.cellLng);
  const cy = Math.floor(p[1] / graph.cellLat);
  let best = -1;
  let bestD = maxMeters;
  for (let r = 0; r <= 4; r++) {
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (r > 0 && Math.abs(x - cx) !== r && Math.abs(y - cy) !== r) continue;
        const arr = graph.grid.get(`${x}:${y}`);
        if (!arr) continue;
        for (const i of arr) {
          const d = distMeters(p, graph.nodes[i]);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0 && r >= 1) break;
  }
  return best;
}

export type RouteResult = {
  path: LngLat[];
  /** m */
  distance: number;
  /** 초 */
  duration: number;
  /** 0~1 */
  shadeRatio: number;
  /** 0~1 — 지나는 길의 방범시설 근접도 (야간 안내용) */
  safetyRatio: number;
  stepsMeters: number;
  crossings: number;
  /** 총 오르막 높이(m) */
  ascent: number;
  /** 구간별 그늘 여부 — 지도에 구간 색을 다르게 칠하기 위한 것 */
  segments: { path: LngLat[]; shade: number }[];
  /**
   * 지나는 길 목록. "왜 이런 길로 가지?" 를 눈으로 확인하려고 둔다.
   * (`/api/diagnose` 가 그대로 내려 준다)
   */
  streets: { name: string; kind: WalkWay["kind"]; meters: number }[];
};

/** 간선 하나를 걷는 데 걸리는 실제 시간(초) */
function edgeTime(e: Edge, hillPenalty = 1) {
  const speed = WALK_SPEED_MPS * (KIND_SPEED[e.kind] ?? 1);
  return (
    e.length / speed +
    // 언덕을 피하고 싶다는 취향은 "오르막이 실제보다 더 힘들게 느껴진다"로 번역한다
    e.climb * ASCENT_SEC_PER_M * hillPenalty +
    (e.kind === "crossing" ? CROSSING_WAIT_S : 0)
  );
}

class MinHeap {
  private vals: number[] = [];
  private keys: number[] = [];

  get size() {
    return this.vals.length;
  }

  push(key: number, val: number) {
    this.vals.push(val);
    this.keys.push(key);
    let i = this.vals.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(): number | undefined {
    if (!this.vals.length) return undefined;
    const top = this.vals[0];
    const lastV = this.vals.pop()!;
    const lastK = this.keys.pop()!;
    if (this.vals.length) {
      this.vals[0] = lastV;
      this.keys[0] = lastK;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.vals.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.vals.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(m, i);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
    const tv = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = tv;
  }
}

/**
 * 탐색 비용. 기본 단위는 "체감 시간(초)"이다.
 * 이렇게 두면 최단 경로가 화면에 표시되는 소요 시간 기준으로도 실제 최단이 된다.
 */
function edgeCost(e: Edge, w: RouteWeights) {
  if (w.excludeSteps && e.kind === "steps") return Infinity;

  let t = edgeTime(e, w.hillPenalty);
  if (e.kind === "steps") t *= w.stepPenalty;

  // 가산은 모두 1 이상의 배율로만 붙인다. 비용이 실제 소요 시간보다 작아지지 않아야
  // A* 의 직선거리 휴리스틱이 계속 유효하다.
  let m = 1;
  m += w.sunPenalty * (1 - e.shade); // 그늘 선호 — 햇빛 구간에 가산
  m += w.shadePenalty * e.shade; // 볕 선호 — 그늘 구간에 가산
  m += e.major ? w.majorPenalty : w.minorPenalty; // 길 분위기
  m += w.darkPenalty * (1 - e.safety); // 야간 방범시설
  return t * m;
}

/** A* (직선거리 휴리스틱). 목적지까지 최소비용 경로의 간선 목록을 반환 */
function search(graph: Graph, from: number, to: number, w: RouteWeights): Edge[] | null {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge: (Edge | null)[] = new Array(n).fill(null);
  const done = new Uint8Array(n);
  const target = graph.nodes[to];
  // 휴리스틱이 실제 비용을 넘지 않도록 1m 당 최소 소요 시간을 곱한다
  const h = (i: number) => distMeters(graph.nodes[i], target) * MIN_SEC_PER_M;

  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(h(from), from);

  while (heap.size) {
    const u = heap.pop()!;
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const e of graph.adj[u]) {
      const cost = edgeCost(e, w);
      if (!Number.isFinite(cost)) continue;
      const nd = dist[u] + cost;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prevNode[e.to] = u;
        prevEdge[e.to] = e;
        heap.push(nd + h(e.to), e.to);
      }
    }
  }

  if (!Number.isFinite(dist[to])) return null;
  const edges: Edge[] = [];
  let cur = to;
  let guard = 0;
  while (cur !== from) {
    const e = prevEdge[cur];
    if (!e || guard++ > n) return null;
    edges.push(e);
    cur = prevNode[cur];
  }
  edges.reverse();
  return edges;
}

function toResult(edges: Edge[], start: LngLat, end: LngLat): RouteResult {
  const path: LngLat[] = [start];
  const segments: { path: LngLat[]; shade: number }[] = [];
  let distance = 0;
  let seconds = 0;
  let stepsMeters = 0;
  let crossings = 0;
  let ascent = 0;
  let shadeWeighted = 0;
  let safetyWeighted = 0;
  const streets: RouteResult["streets"] = [];

  for (const e of edges) {
    for (let i = 1; i < e.path.length; i++) path.push(e.path[i]);
    distance += e.length;
    seconds += edgeTime(e);
    shadeWeighted += e.shade * e.length;
    safetyWeighted += e.safety * e.length;
    if (e.kind === "steps") stepsMeters += e.length;
    if (e.kind === "crossing") crossings += 1;
    ascent += e.climb;

    // 같은 길이 이어지면 한 줄로 합친다
    const label = e.name ?? "(이름 없음)";
    const tail = streets[streets.length - 1];
    if (tail && tail.name === label && tail.kind === e.kind) tail.meters += e.length;
    else streets.push({ name: label, kind: e.kind, meters: e.length });

    const isShady = e.shade >= 0.5;
    const last = segments[segments.length - 1];
    if (last && last.shade >= 0.5 === isShady) {
      for (let i = 1; i < e.path.length; i++) last.path.push(e.path[i]);
      last.shade = (last.shade + e.shade) / 2;
    } else {
      segments.push({ path: e.path.slice(), shade: e.shade });
    }
  }
  path.push(end);

  // 그래프에 스냅되기까지의 접근 거리도 합산
  const approach =
    distMeters(start, path[1] ?? end) + distMeters(path[path.length - 2] ?? start, end);
  const total = distance + approach;

  return {
    path,
    distance: total,
    duration: seconds + approach / WALK_SPEED_MPS,
    shadeRatio: distance > 0 ? shadeWeighted / distance : 0,
    safetyRatio: distance > 0 ? safetyWeighted / distance : 0,
    stepsMeters,
    crossings,
    ascent: Math.round(ascent),
    segments,
    streets: streets.map((x) => ({ ...x, meters: Math.round(x.meters) })),
  };
}

export type RouteOption = RouteResult & {
  id: "fast" | "shade";
  label: string;
};

/**
 * 두 지점 사이의 경로 하나. 대중교통 여정의 접근·환승·마무리 도보 구간에 쓴다.
 * 그래프 밖이면 null 이다. 직선으로 어림잡지 않는다 — 없는 길이 생긴다.
 */
export function routeBetween(
  graph: Graph,
  start: LngLat,
  end: LngLat,
  w: RouteWeights,
  snapRadius = 220
): RouteResult | null {
  const pair = snapPair(graph, start, end, snapRadius);
  if (!pair) return null;
  const [s, t] = pair;
  let edges = search(graph, s, t, w);
  // 계단을 완전히 뺐더니 길이 끊기면, 그 조건만 풀어서 한 번 더 찾는다
  if (!edges && w.excludeSteps) edges = search(graph, s, t, { ...w, excludeSteps: false });
  if (!edges) return null;
  return toResult(edges, start, end);
}

export function findRoutes(
  graph: Graph,
  start: LngLat,
  end: LngLat,
  weights: RouteWeights,
  preferLabel = "그늘 우선"
): { routes: RouteOption[]; error?: string } {
  if (distMeters(start, end) < 30) return { routes: [], error: "출발지와 목적지가 너무 가깝습니다." };
  const pair = snapPair(graph, start, end);
  if (!pair) {
    // 가까운 길은 있는데 서로 이어지지 않는 경우까지 구분해 알린다
    const near = snap(graph, start, 350) >= 0 && snap(graph, end, 350) >= 0;
    return {
      routes: [],
      error: near
        ? "두 지점을 잇는 보행로가 데이터에 없습니다. (터널·철길 등으로 끊긴 구간일 수 있어요)"
        : "출발지·목적지 근처에 보행 가능한 길 데이터가 없습니다.",
    };
  }
  const [s, t] = pair;

  const fastEdges = search(graph, s, t, FASTEST_WEIGHTS);
  if (!fastEdges)
    return { routes: [], error: "경로를 찾지 못했습니다. 조금 더 가까운 지점으로 시도해 주세요." };
  const fast = toResult(fastEdges, start, end);

  const routes: RouteOption[] = [{ ...fast, id: "fast", label: "최단" }];

  // 취향이 최단 경로와 같은 답을 낼 수밖에 없는 설정이면 한 번만 찾는다
  if (!weightsAreNeutral(weights)) {
    let prefEdges = search(graph, s, t, weights);
    if (!prefEdges && weights.excludeSteps)
      prefEdges = search(graph, s, t, { ...weights, excludeSteps: false });
    if (prefEdges) {
      const pref = toResult(prefEdges, start, end);
      const sameLength = Math.abs(pref.distance - fast.distance) < 5;
      const sameShade = Math.abs(pref.shadeRatio - fast.shadeRatio) < 0.02;
      if (!(sameLength && sameShade)) routes.push({ ...pref, id: "shade", label: preferLabel });
    }
  }
  return { routes };
}

export function formatDistance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export function formatDuration(sec: number) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

export { WALK_SPEED_MPS };
