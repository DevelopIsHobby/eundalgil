/**
 * 버스 색 — 화면에서도 실제 도로에서 보는 버스와 같은 색으로 보이게 한다.
 *
 * 서울은 노선 유형에 도색이 정해져 있고(간선 파랑·지선 초록·순환 노랑·광역 빨강),
 * 사람들은 그 색으로 버스를 구분한다. 모든 버스를 같은 파란 선으로 그리면
 * "무슨 버스인지" 가 지도에서 사라진다.
 */

/**
 * 서울 TOPIS busRouteType 코드별 도색.
 *
 * 7(인천)·8(경기) 는 일부러 뺐다. TOPIS 는 서울 밖 노선도 함께 주는데, 그 지역은
 * 도색 체계가 서울과 달라서 코드만으로는 무슨 색 버스인지 알 수 없다.
 * (수원에서 시내버스 72개가 통째로 광역 빨강이 되는 문제가 있었다)
 */
const SEOUL_BY_TYPE: Record<string, string> = {
  "1": "#AA9872", // 공항
  "2": "#53B332", // 마을
  "3": "#3D5BAB", // 간선
  "4": "#53B332", // 지선
  "5": "#F99D1C", // 순환
  "6": "#E60012", // 광역
};

/** 유형을 모를 때 — 가장 흔한 간선 색으로 둔다 */
export const DEFAULT_BUS_COLOR = "#3D5BAB";

export function seoulBusColor(routeType: string): string {
  return SEOUL_BY_TYPE[routeType.trim()] ?? DEFAULT_BUS_COLOR;
}

/**
 * TAGO 는 코드가 아니라 "일반버스" 같은 말로 유형을 준다.
 * 지역마다 도색이 제각각이라 수도권 기준에 맞춰 큰 갈래만 나눈다.
 */
export function tagoBusColor(routeType: string): string {
  const t = routeType.trim();
  if (!t) return DEFAULT_BUS_COLOR;
  if (t.includes("공항")) return "#AA9872";
  if (t.includes("마을") || t.includes("농어촌")) return "#53B332";
  if (t.includes("직행") || t.includes("급행") || t.includes("광역")) return "#E60012";
  return DEFAULT_BUS_COLOR;
}
