/**
 * 받아 둔 OSM 번들을 디스크에도 남긴다 (서버 전용).
 *
 * 메모리 캐시는 프로세스와 함께 사라진다. 개발 중 서버를 다시 띄우거나 배포를 새로 올리면
 * 이미 봤던 동네도 다시 공개 Overpass 에 줄을 서야 한다 — 붐빌 때는 한 번에 수십 초다.
 * 지도 데이터는 하루 이틀 사이에 바뀔 것이 아니므로, 파일로 남겨 두고 다시 쓰는 편이 낫다.
 * 덤으로 **Overpass 가 죽어 있어도 가 본 동네는 그대로 안내된다.**
 *
 * 캐시는 OneDrive 가 동기화하지 않도록 프로젝트 밖(OS 임시 폴더)에 둔다.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsmBundle } from "./osm";

/**
 * 저장 형식 표시. **Overpass 질의나 걸러내는 규칙을 바꾸면 반드시 올린다.**
 * 안 올리면 옛 규칙으로 걸러진 데이터가 며칠씩 남아 "왜 아직도 터널로 가지?" 가 된다.
 */
const SCHEMA = "v1";
const DIR = join(tmpdir(), "eundalgil-osm", SCHEMA);

/** 지도 데이터는 자주 바뀌지 않는다. 사흘이면 충분히 신선하다 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** 파일 수 상한 — 넘으면 오래된 것부터 지운다 (번들 하나가 보통 1~5MB) */
const MAX_FILES = 300;

let ready: Promise<void> | null = null;
function ensureDir() {
  ready ??= mkdir(DIR, { recursive: true }).then(() => undefined);
  return ready;
}

/** 파일 이름에 쓸 수 없는 문자가 섞이지 않게 키를 해시로 바꾼다 */
function fileOf(key: string) {
  return join(DIR, `${createHash("sha1").update(key).digest("hex")}.json`);
}

/**
 * @param stale 만료된 것도 받아들일지.
 *   평소에는 false 다. 다만 Overpass 가 통째로 죽은 날에는 "조금 오래된 지도" 가
 *   "지도 없음" 보다 낫다 — 건물과 길은 며칠 사이에 달라지지 않는다.
 */
export async function readCachedBundle(key: string, stale = false): Promise<OsmBundle | null> {
  try {
    await ensureDir();
    const path = fileOf(key);
    const info = await stat(path);
    if (!stale && Date.now() - info.mtimeMs > TTL_MS) return null;
    return JSON.parse(await readFile(path, "utf8")) as OsmBundle;
  } catch {
    // 없거나 깨졌으면 그냥 새로 받는다
    return null;
  }
}

export async function writeCachedBundle(key: string, data: OsmBundle) {
  try {
    await ensureDir();
    const path = fileOf(key);
    // 쓰다 만 파일을 다음 요청이 읽지 않도록 옆에 썼다가 옮긴다
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, path);
    void prune();
  } catch (err) {
    // 캐시는 있으면 좋은 것이지 없으면 안 되는 것이 아니다
    console.warn("[osm-cache] 저장 실패:", (err as Error).message);
  }
}

let pruning = false;
async function prune() {
  if (pruning) return;
  pruning = true;
  try {
    const names = (await readdir(DIR)).filter((n) => n.endsWith(".json"));
    if (names.length <= MAX_FILES) return;
    const stamped = await Promise.all(
      names.map(async (n) => {
        try {
          return { n, at: (await stat(join(DIR, n))).mtimeMs };
        } catch {
          return { n, at: 0 };
        }
      })
    );
    stamped.sort((a, b) => a.at - b.at);
    for (const { n } of stamped.slice(0, stamped.length - MAX_FILES)) {
      await unlink(join(DIR, n)).catch(() => {});
    }
  } catch {
    /* 정리는 실패해도 그만이다 */
  } finally {
    pruning = false;
  }
}

/** 개발용 — 지금 캐시가 어디에 얼마나 쌓였는지 */
export async function cacheStats() {
  try {
    await ensureDir();
    const names = (await readdir(DIR)).filter((n) => n.endsWith(".json"));
    let bytes = 0;
    for (const n of names) {
      try {
        bytes += (await stat(join(DIR, n))).size;
      } catch {
        /* 지워졌으면 넘어간다 */
      }
    }
    return { dir: DIR, files: names.length, bytes };
  } catch {
    return { dir: DIR, files: 0, bytes: 0 };
  }
}
