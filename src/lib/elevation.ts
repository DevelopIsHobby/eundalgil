import { PNG } from "pngjs";

/**
 * 고도 조회 — AWS Open Data 의 Terrain Tiles(terrarium) 를 쓴다.
 * 키도 요금도 없고, 한 타일이 도시 한 구획을 통째로 덮어서 경로 한 번에 한두 장이면 된다.
 *
 * 고도를 안 보면 언덕 동네에서 경로가 계속 산으로 샌다. 상도동에서 실제로 그랬다 —
 * 차도 터널을 막으니 차량 램프로, 램프를 막으니 숲속 산길로 갔다. 셋 다 "거리가 짧아서"
 * 골린 길이고, 36m 를 올라간다는 사실은 비용에 전혀 안 들어가 있었다.
 *
 * 픽셀 하나가 담는 값: elevation(m) = R*256 + G + B/256 - 32768
 */

/** z14 한 타일이 서울 위도에서 약 1.9km, 한 픽셀이 약 7.6m — 도보 경로에 충분하다 */
const ZOOM = 14;
const TILE = 256;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/** 한 번 받은 타일은 오래 둔다. 지형은 변하지 않는다. */
const CACHE_MAX = 64;
const cache = new Map<string, Float32Array>();
const inflight = new Map<string, Promise<Float32Array | null>>();

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

async function loadTile(x: number, y: number): Promise<Float32Array | null> {
  const key = `${ZOOM}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const res = await fetch(TILE_URL(ZOOM, x, y), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      if (png.width !== TILE || png.height !== TILE) return null;

      const grid = new Float32Array(TILE * TILE);
      for (let i = 0; i < grid.length; i++) {
        const o = i * 4;
        grid[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
      }
      cache.set(key, grid);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      return grid;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** 좌표 목록의 고도를 재는 함수. 타일을 못 받으면 null 을 돌려준다 (고도 없이 계산하면 된다) */
export type ElevationLookup = (lng: number, lat: number) => number;

/**
 * bbox 를 덮는 타일을 미리 받아 두고, 좌표 → 고도 함수를 돌려준다.
 * 타일을 하나도 못 받으면 null — 이때는 고도를 아예 쓰지 않는다.
 */
export async function loadElevation(
  bbox: [number, number, number, number]
): Promise<ElevationLookup | null> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const x0 = Math.floor(lonToTileX(minLng, ZOOM));
  const x1 = Math.floor(lonToTileX(maxLng, ZOOM));
  // 위도는 위로 갈수록 타일 y 가 작아진다
  const y0 = Math.floor(latToTileY(maxLat, ZOOM));
  const y1 = Math.floor(latToTileY(minLat, ZOOM));

  const tiles = new Map<string, Float32Array>();
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(
        loadTile(x, y).then((g) => {
          if (g) tiles.set(`${x}/${y}`, g);
        })
      );
    }
  }
  await Promise.all(jobs);
  if (!tiles.size) {
    // 조용히 넘어가면 고도 없이 계산되고, 그러면 경로가 다시 산으로 샌다. 로그는 남긴다.
    console.warn(
      `[elevation] DEM 타일을 하나도 받지 못했습니다 (z${ZOOM} x${x0}~${x1} y${y0}~${y1}). 오르막 없이 계산합니다.`
    );
    return null;
  }

  return (lng, lat) => {
    const fx = lonToTileX(lng, ZOOM);
    const fy = latToTileY(lat, ZOOM);
    const grid = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!grid) return 0;
    const px = Math.min(TILE - 1, Math.max(0, Math.floor((fx % 1) * TILE)));
    const py = Math.min(TILE - 1, Math.max(0, Math.floor((fy % 1) * TILE)));
    return grid[py * TILE + px];
  };
}

/**
 * DEM 한 픽셀이 7~8m 라, 몇 미터짜리 짧은 구간을 그대로 빼면 지형이 아니라 픽셀 잡음이 잡힌다.
 * 그대로 두면 평지를 걸어도 오르막이 수십 미터씩 쌓인다. 이동평균으로 한 번 다듬는다.
 */
export function smoothProfile(values: number[], window = 5): number[] {
  if (values.length <= 2) return values;
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let k = from; k <= to; k++) sum += values[k];
    return sum / (to - from + 1);
  });
}
