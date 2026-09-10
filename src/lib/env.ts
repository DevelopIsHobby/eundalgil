/**
 * 환경 변수를 읽는 작은 도우미 (서버 전용).
 *
 * `process.env.A ?? process.env.B` 는 **빈 문자열을 값으로 친다.** 배포 화면에서 변수 칸만
 * 만들어 두고 값을 안 넣으면 `A` 는 `undefined` 가 아니라 `""` 라, 뒤에 적어 둔 `B` 로
 * 넘어가지 않고 그대로 빈 키가 된다. 이 프로젝트에서 이미 두 번 걸렸다 —
 * `SEOUL_BUS_KEY` 를 빈 칸으로 두자 `TAGO_KEY` 로 넘어가지 않아 서울 버스가 통째로
 * 조용히 꺼졌고, 브이월드도 같은 모양이었다.
 *
 * 그래서 "비어 있으면 없는 것" 으로 보고 다음 후보로 넘어간다.
 */
export function envValue(...names: string[]) {
  for (const name of names) {
    const v = (process.env[name] ?? "").trim();
    if (v) return v;
  }
  return "";
}
