/**
 * 서울 전체 타일을 미리 받아 둔다.
 *
 * 운영 중에 공개 Overpass 를 부르지 않으려면 미리 받아 둬야 한다. 서울은 96타일이고,
 * 한 장에 몇 초에서 수십 초가 걸린다 — 미러가 붐비는 정도에 달렸다.
 *
 * **다시 돌려도 된다.** 이미 받아 둔 타일은 건너뛰므로, 도중에 끊기면 다시 실행하면 된다.
 * 공개 미러에 예의를 지키려고 한 장씩 순서대로 받고 사이를 띄운다.
 *
 *   npm run warm            개발 서버(3000)를 통해 받는다
 *   npm run warm -- 3100    다른 포트로
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = process.argv[2] || "3000";
const BASE = `http://localhost:${PORT}`;

const TILE_DEG = 0.04;
const SEOUL = { minLng: 126.75, minLat: 37.41, maxLng: 127.19, maxLat: 37.71 };
/** 한 장 받고 쉬는 시간 — 공개 미러가 우리를 막지 않게 */
const PAUSE_MS = 1500;

const DIR = join(process.cwd(), "data", "osm-tiles", "v1");

const tiles = [];
const lo = { x: Math.floor(SEOUL.minLng / TILE_DEG), y: Math.floor(SEOUL.minLat / TILE_DEG) };
const hi = { x: Math.floor(SEOUL.maxLng / TILE_DEG), y: Math.floor(SEOUL.maxLat / TILE_DEG) };
for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) tiles.push({ x, y });

const has = (t) => existsSync(join(DIR, `${t.x}_${t.y}.json.gz`));
const todo = tiles.filter((t) => !has(t));

console.log(`서울 ${tiles.length}타일 중 ${todo.length}장을 받습니다 (${tiles.length - todo.length}장은 이미 있음)`);


const started = Date.now();
let ok = 0;
let fail = 0;

for (const [i, t] of todo.entries()) {
  // 타일 한 장을 딱 덮는 범위를 물어보면 그 타일만 받아 저장된다
  const b = [t.x * TILE_DEG, t.y * TILE_DEG, (t.x + 1) * TILE_DEG, (t.y + 1) * TILE_DEG];
  const at = Date.now();
  try {
    const res = await fetch(`${BASE}/api/osm?bbox=${b.map((v) => v.toFixed(6)).join(",")}`);
    const body = await res.json().catch(() => null);
    const got = body?.bundles?.[0];
    if (!res.ok || !got) throw new Error(`${res.status}${body ? "" : " (본문 없음)"}`);
    ok++;
    console.log(
      `[${i + 1}/${todo.length}] ${t.x}_${t.y}  ${((Date.now() - at) / 1000).toFixed(1)}s  ` +
        `길 ${got.ways.length} · 건물 ${got.buildings.length} · 나무 ${got.trees.length}`
    );
  } catch (err) {
    fail++;
    console.log(`[${i + 1}/${todo.length}] ${t.x}_${t.y}  실패 — ${err.message}`);
  }
  if (i < todo.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
}

/*
 * 철도 노선도 한 번 받아 둔다.
 * 서울 지하철·광역전철을 통째로 받아 파일 하나로 남기므로, 길찾기 한 번만 시켜 보면 된다.
 * (한 번 만들어 두면 그 뒤로는 파일만 읽는다)
 */
process.stdout.write("철도 노선 받는 중… ");
const railAt = Date.now();
try {
  const res = await fetch(`${BASE}/api/transit?a=126.97800,37.56600&b=127.02700,37.49800&r=1200`);
  const j = await res.json();
  const rail = (j.patterns || []).filter((p) => p.mode !== "bus");
  console.log(`${((Date.now() - railAt) / 1000).toFixed(1)}s — 이 구간에 걸리는 노선 ${rail.length}개`);
} catch (err) {
  console.log(`실패 — ${err.message}`);
}

let bytes = 0;
if (existsSync(DIR)) for (const n of readdirSync(DIR)) bytes += statSync(join(DIR, n)).size;
const railFile = join(process.cwd(), "data", "rail", "seoul-v1.json.gz");
if (existsSync(railFile)) bytes += statSync(railFile).size;

console.log(
  `\n끝: 성공 ${ok} · 실패 ${fail} · ${((Date.now() - started) / 60000).toFixed(1)}분\n` +
    `저장 ${(bytes / 1024 / 1024).toFixed(1)}MB — ${DIR}\n` +
    (fail ? "실패한 타일은 다시 실행하면 이어서 받습니다.\n" : "")
);
