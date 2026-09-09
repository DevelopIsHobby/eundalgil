/**
 * 작은 JSON 디스크 캐시 (서버 전용).
 *
 * 노선이 지나는 정류장 순서처럼 **거의 바뀌지 않는데 받아 오는 데 오래 걸리는** 자료를
 * 프로세스 밖에 남겨 둔다. 서울 버스 노선 하나를 받는 데 0.3~1초씩 걸리고, 한 번 길을
 * 찾을 때 수십 개를 부르니 서버를 다시 띄울 때마다 그 값을 다시 치르게 된다.
 *
 * 지도 번들은 `osmCache.ts` 가 따로 다룬다 (덩치가 크고 스키마 관리가 필요해서다).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), "eundalgil-cache");

const dirs = new Map<string, Promise<void>>();
function ensureDir(ns: string) {
  const dir = join(ROOT, ns);
  let ready = dirs.get(ns);
  if (!ready) {
    ready = mkdir(dir, { recursive: true }).then(() => undefined);
    dirs.set(ns, ready);
  }
  return ready.then(() => dir);
}

function fileOf(dir: string, key: string) {
  return join(dir, `${createHash("sha1").update(key).digest("hex")}.json`);
}

export async function readJson<T>(ns: string, key: string, ttlMs: number): Promise<T | null> {
  try {
    const dir = await ensureDir(ns);
    const path = fileOf(dir, key);
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > ttlMs) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(ns: string, key: string, value: unknown) {
  try {
    const dir = await ensureDir(ns);
    const path = fileOf(dir, key);
    // 쓰다 만 파일을 다음 요청이 읽지 않도록 옆에 썼다가 옮긴다
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value), "utf8");
    await rename(tmp, path);
  } catch {
    /* 캐시는 있으면 좋은 것이지 없으면 안 되는 것이 아니다 */
  }
}
