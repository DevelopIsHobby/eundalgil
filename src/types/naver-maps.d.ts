/**
 * 네이버 지도 JS API v3 최소 타입 선언.
 * 공식 패키지 대신 실제로 쓰는 부분만 좁게 정의한다.
 */
declare namespace naver.maps {
  class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  class LatLngBounds {
    constructor(sw: LatLng, ne: LatLng);
    getSW(): LatLng;
    getNE(): LatLng;
    extend(latlng: LatLng): LatLngBounds;
  }

  class Point {
    constructor(x: number, y: number);
    x: number;
    y: number;
  }

  class Size {
    constructor(w: number, h: number);
    width: number;
    height: number;
  }

  interface Projection {
    fromCoordToOffset(coord: LatLng): Point;
    fromOffsetToCoord(offset: Point): LatLng;
  }

  interface MapOptions {
    center?: LatLng;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    mapDataControl?: boolean;
    logoControl?: boolean;
    logoControlOptions?: Record<string, unknown>;
    scaleControl?: boolean;
    zoomControl?: boolean;
    mapTypeControl?: boolean;
    tileTransition?: boolean;
    baseTileOpacity?: number;
    padding?: { top?: number; right?: number; bottom?: number; left?: number };
  }

  class Map {
    constructor(el: HTMLElement | string, opts?: MapOptions);
    setCenter(c: LatLng): void;
    getCenter(): LatLng;
    setZoom(z: number, effect?: boolean): void;
    getZoom(): number;
    getBounds(): LatLngBounds;
    getSize(): Size;
    getProjection(): Projection;
    getElement(): HTMLElement;
    panTo(c: LatLng, opts?: Record<string, unknown>): void;
    fitBounds(b: LatLngBounds, opts?: Record<string, unknown>): void;
    destroy(): void;
    setOptions(k: string | Record<string, unknown>, v?: unknown): void;
  }

  class Marker {
    constructor(opts: Record<string, unknown>);
    setMap(map: Map | null): void;
    setPosition(p: LatLng): void;
    getPosition(): LatLng;
  }

  class Polyline {
    constructor(opts: Record<string, unknown>);
    setMap(map: Map | null): void;
    setOptions(opts: Record<string, unknown>): void;
    setPath(path: LatLng[]): void;
  }

  class Circle {
    constructor(opts: Record<string, unknown>);
    setMap(map: Map | null): void;
  }

  namespace Event {
    function addListener(target: unknown, type: string, fn: (...args: any[]) => void): unknown;
    function removeListener(listener: unknown): void;
  }

  namespace Service {
    function geocode(
      opts: { query: string },
      cb: (status: unknown, res: any) => void
    ): void;
    function reverseGeocode(
      opts: { coords: LatLng; orders?: string },
      cb: (status: unknown, res: any) => void
    ): void;
    const Status: { OK: unknown; ERROR: unknown };
    const OrderType: { ADDR: string; ROAD_ADDR: string };
  }
}

interface Window {
  naver?: typeof naver;
}
