import type { StyleSpecification } from "maplibre-gl";

export type BasemapId = "openfreemap" | "vworld";

/** 브이월드 키. 없으면 OpenFreeMap 한 가지로만 돈다 (키 없이 완전 동작) */
export const VWORLD_KEY = (process.env.NEXT_PUBLIC_VWORLD_KEY ?? "").trim();
export const hasVWorld = VWORLD_KEY.length > 0;

/**
 * OpenFreeMap — 키·요금·사용량 제한이 모두 없는 벡터 타일.
 *
 * 처음엔 회색 일색인 positron(55개 레이어)을 썼는데, 그늘은 잘 보여도 지도 자체가
 * 안 읽혔다. 걷는 길을 고르는 앱이라 공원·건물·도로 등급이 색으로 구분돼야 한다.
 * bright(119개 레이어)는 색이 제대로 들어가고, 그늘은 mix-blend-mode 로 곱해서 얹으므로
 * 바탕이 화려해도 묻히지 않는다. (MapView 의 그림자 캔버스)
 *
 * liberty 도 비슷하게 화려하지만 쓰지 않는다. 줌 7까지만 그려지는 natural_earth 래스터
 * 레이어가 들어 있는데, 그 PNG 디코딩이 실패하는 환경에서 지도가 통째로 안 그려진다.
 * bright 에는 래스터 레이어가 아예 없다.
 */
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/bright";

/**
 * 브이월드 배경지도 레이어. 쓸 수 있는 값은 Base · midnight · Hybrid · Satellite · white 뿐이다.
 * (다른 이름을 넣으면 타일 대신 InvalidParameterValue XML 이 와서 지도가 빈 화면이 된다)
 *
 * 그늘 오버레이만 놓고 보면 라벨이 거의 없는 white 가 제일 깔끔하지만,
 * 브이월드를 고르는 이유가 국내 지명·건물이므로 라벨이 있는 Base 를 쓴다.
 */
const VWORLD_LAYER = "Base";

/**
 * 브이월드(국토교통부 공간정보 오픈플랫폼) WMTS 래스터.
 * 타일 좌표가 {z}/{y}/{x} 순서라 흔한 XYZ 와 x·y 자리가 뒤바뀐 점에 주의.
 */
function vworldStyle(key: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      vworld: {
        type: "raster",
        tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${key}/${VWORLD_LAYER}/{z}/{y}/{x}.png`],
        tileSize: 256,
        // 브이월드가 실제로 내려 주는 범위. 넘어서면 타일 대신 오류 XML 이 온다
        minzoom: 6,
        maxzoom: 18,
        attribution:
          '© <a href="https://www.vworld.kr" target="_blank" rel="noreferrer">국토교통부 브이월드</a>',
      },
    },
    layers: [{ id: "vworld-base", type: "raster", source: "vworld" }],
  };
}

export function basemapStyle(id: BasemapId): string | StyleSpecification {
  if (id === "vworld" && hasVWorld) return vworldStyle(VWORLD_KEY);
  return OPENFREEMAP_STYLE;
}

export function basemapLabel(id: BasemapId) {
  return id === "vworld" ? "브이월드" : "기본 지도";
}

/** 지도 타일과 별개로, 우리가 직접 받아 쓰는 데이터의 출처 표기 */
export const EXTRA_ATTRIBUTION =
  '건물·보행로 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> 기여자';
