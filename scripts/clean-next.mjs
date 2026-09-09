/**
 * dev 서버를 띄우기 전에, 남아 있는 **프로덕션 빌드 산출물**만 지운다.
 *
 * `next build` 뒤에 `next dev` 를 돌리면 dev 가 .next 를 스스로 비우려 하는데,
 * OneDrive 폴더에서는 그 삭제가 `EINVAL: readlink` 로 실패하며 서버가 그대로 죽는다.
 * (`.next/server/font-manifest.json` 에서 걸린다)
 *
 * 개발용 .next 는 건드리지 않는다 — 지우면 매번 전체 컴파일이라 느려진다.
 * 프로덕션 빌드에만 있는 BUILD_ID 로 구분한다.
 */
import { existsSync, rmSync } from "node:fs";

if (existsSync(".next/BUILD_ID")) {
  rmSync(".next", { recursive: true, force: true });
  console.log("[predev] 프로덕션 빌드 산출물(.next)을 지웠습니다 — dev 로 새로 컴파일합니다");
}
