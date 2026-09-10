/**
 * 서울 철도(지하철·광역전철) 노선을 파일로 받아 둔다 (서버 전용).
 *
 * 버스는 TOPIS 가 실시간으로 주지만, 철도 노선은 OSM 에서 온다. 그런데 노선과 선로는
 * 몇 달에 한 번 바뀔까 말까 한 자료다. 길찾기 한 번에 공개 Overpass 를 부를 이유가 없다.
 *
 * 타일과 달리 **한 덩어리**로 둔다. 노선은 서울을 가로질러 뻗어 있어 격자로 자르면
 * 역 순서가 끊기기 때문이다.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import type { TransitPattern, TransitStop } from "./transit";

/** **선로 처리 규칙을 바꾸면 반드시 올린다** */
export const RAIL_SCHEMA = "v1";
const FILE = join(process.cwd(), "data", "rail", `seoul-${RAIL_SCHEMA}.json.gz`);

export type RailData = { stops: TransitStop[]; patterns: TransitPattern[]; builtAt: number };

let memory: RailData | null = null;

export async function readRail(): Promise<RailData | null> {
  if (memory) return memory;
  try {
    memory = JSON.parse(gunzipSync(await readFile(FILE)).toString("utf8")) as RailData;
    return memory;
  } catch {
    return null;
  }
}

export async function writeRail(data: RailData) {
  memory = data;
  try {
    await mkdir(join(process.cwd(), "data", "rail"), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await writeFile(tmp, gzipSync(Buffer.from(JSON.stringify(data), "utf8"), { level: 9 }));
    await rename(tmp, FILE);
  } catch (err) {
    // 배포된 서버에서는 프로젝트 폴더가 읽기 전용이다. 미리 받아 뒀다면 쓸 일도 없다
    console.warn("[rail] 저장하지 못했습니다:", (err as Error).message);
  }
}

export async function railStats() {
  try {
    const { size } = await stat(FILE);
    const d = await readRail();
    return {
      file: FILE,
      schema: RAIL_SCHEMA,
      bytes: size,
      stops: d?.stops.length ?? 0,
      patterns: d?.patterns.length ?? 0,
    };
  } catch {
    return { file: FILE, schema: RAIL_SCHEMA, bytes: 0, stops: 0, patterns: 0 };
  }
}
