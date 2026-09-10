/**
 * 타일로 받아 둔 지도 데이터를 파일로 읽고 쓴다 (서버 전용).
 *
 * **프로젝트 안**(`data/osm-tiles/`)에 둔다. OS 임시 폴더에 두던 예전 캐시와 다른 점이다 —
 * 임시 폴더는 배포에 딸려 가지 않아서, 올릴 때마다 서울 전체를 다시 받아야 했다.
 * 미리 받아 둔 타일을 저장소에 함께 두면 배포와 함께 실려 가고, 그러면 운영 중에는
 * 공개 Overpass 를 한 번도 부르지 않는다.
 *
 * gzip 으로 눌러 둔다. 좌표가 대부분이라 잘 눌린다.
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import type { LngLat } from "./geo";
import type { OsmBundle } from "./osm";
import { tileKey, type Tile } from "./tiles";

/**
 * 저장 형식 표시. **Overpass 질의나 걸러내는 규칙을 바꾸면 반드시 올린다.**
 * 안 올리면 옛 규칙으로 걸러진 타일이 그대로 쓰인다.
 */
export const TILE_SCHEMA = "v1";
const DIR = join(process.cwd(), "data", "osm-tiles", TILE_SCHEMA);

const fileOf = (t: Tile) => join(DIR, `${tileKey(t)}.json.gz`);

/** 한 프로세스 안에서 같은 타일을 두 번 읽지 않는다 */
const memory = new Map<string, OsmBundle>();

export async function readTile(t: Tile): Promise<OsmBundle | null> {
  const key = tileKey(t);
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const buf = await readFile(fileOf(t));
    const data = JSON.parse(gunzipSync(buf).toString("utf8")) as OsmBundle;
    memory.set(key, data);
    return data;
  } catch {
    // 아직 안 받아 둔 타일이다
    return null;
  }
}

/**
 * 좌표 자리수를 줄인다. 7자리는 1cm 단위인데 우리에겐 그만한 정밀도가 필요 없다 —
 * 길에 올라서는 판정이 25m, 정류장 맞추기가 150m 단위다. 6자리면 11cm 라 눈에 띄지 않고,
 * 서울 전체가 60MB 에서 48MB 로 줄어든다. 저장소에 함께 싣는 자료라 이 차이가 크다.
 */
const DP = 6;
const round = (v: number, dp = DP) => Number(v.toFixed(dp));
const roundPath = (path: LngLat[]) => path.map((p) => [round(p[0]), round(p[1])] as LngLat);

function shrink(d: OsmBundle): OsmBundle {
  return {
    ...d,
    ways: d.ways.map((w) => ({
      ...w,
      path: roundPath(w.path),
      elev: w.elev?.map((v) => round(v, 1)),
    })),
    buildings: d.buildings.map((b) => ({
      ...b,
      ring: roundPath(b.ring),
      height: round(b.height, 1),
    })),
    trees: d.trees.map((t) => ({ ...t, p: [round(t.p[0]), round(t.p[1])] as LngLat })),
    safety: d.safety.map((s) => ({ ...s, p: [round(s.p[0]), round(s.p[1])] as LngLat })),
    entrances: d.entrances.map((e) => ({ ...e, p: [round(e.p[0]), round(e.p[1])] as LngLat })),
  };
}

export async function writeTile(t: Tile, raw: OsmBundle) {
  const data = shrink(raw);
  memory.set(tileKey(t), data);
  try {
    await mkdir(DIR, { recursive: true });
    // 쓰다 만 파일을 읽지 않도록 임시 이름에 썼다가 바꿔 단다
    const tmp = fileOf(t) + `.${process.pid}.tmp`;
    await writeFile(tmp, gzipSync(Buffer.from(JSON.stringify(data), "utf8"), { level: 9 }));
    await rename(tmp, fileOf(t));
  } catch (err) {
    // 배포된 서버에서는 프로젝트 폴더가 읽기 전용이다. 미리 받아 뒀다면 쓸 일도 없다
    console.warn("[tiles] 저장하지 못했습니다:", (err as Error).message);
  }
}

/** 받아 둔 타일 현황 — 진단에 쓴다 */
export async function tileStats() {
  try {
    const names = (await readdir(DIR)).filter((n) => n.endsWith(".json.gz"));
    let bytes = 0;
    for (const n of names) bytes += (await stat(join(DIR, n))).size;
    return { dir: DIR, schema: TILE_SCHEMA, files: names.length, bytes };
  } catch {
    return { dir: DIR, schema: TILE_SCHEMA, files: 0, bytes: 0 };
  }
}
