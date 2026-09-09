import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 현재 기온·하늘 상태. Open-Meteo 는 키 없이 쓸 수 있고 상업적 이용도 허용한다.
 * 같은 동네를 계속 부르지 않도록 10분만 기억한다.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

/** WMO 날씨 코드 → 한 단어 */
function label(code: number) {
  if (code === 0) return "맑음";
  if (code <= 2) return "구름 조금";
  if (code === 3) return "흐림";
  if (code <= 48) return "안개";
  if (code <= 57) return "이슬비";
  if (code <= 67) return "비";
  if (code <= 77) return "눈";
  if (code <= 82) return "소나기";
  if (code <= 86) return "눈 소나기";
  return "뇌우";
}

export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return new NextResponse("lat, lng 가 필요합니다", { status: 400 });

  // 동네 단위(약 1km)로만 구분해 캐시 적중률을 높인다
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.data);

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}` +
    // 그늘을 따지는 앱이라 기온보다 **체감온도**가 본론이다. 습도·자외선도 같이 본다
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,uv_index,weather_code` +
    `&timezone=auto`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return new NextResponse("날씨를 불러오지 못했습니다", { status: 502 });
    const json = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        uv_index?: number;
        weather_code?: number;
      };
    };
    const cur = json.current ?? {};
    const code = cur.weather_code ?? 0;
    const tempC = Math.round(cur.temperature_2m ?? 0);
    const data = {
      tempC,
      // 체감온도를 못 받으면 기온으로 대신한다 (없는 값을 지어내지 않는다)
      feelsC: Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 0),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      uv: Math.round((cur.uv_index ?? 0) * 10) / 10,
      code,
      label: label(code),
    };
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 60) cache.delete(cache.keys().next().value as string);
    return NextResponse.json(data);
  } catch {
    return new NextResponse("날씨를 불러오지 못했습니다", { status: 502 });
  }
}
