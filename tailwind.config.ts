import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 네이버 지도 계열 뉴트럴 (직접 정의한 자체 토큰)
        ink: {
          900: "#1A1A1A",
          700: "#3A3A3A",
          500: "#767676",
          400: "#9A9A9A",
          300: "#C6C6C6",
        },
        line: {
          DEFAULT: "#E9E9E9",
          strong: "#DADADA",
        },
        brand: {
          DEFAULT: "#0FA958", // 응달길 그린 (네이버 그린과 구분되는 톤)
          dark: "#0B8A47",
          soft: "#E7F7EE",
        },
        route: {
          fast: "#2E6FF2", // 최단
          shade: "#12B886", // 그늘
          night: "#7C5CFF", // 야간 안전
        },
        sun: "#F5A524",
      },
      boxShadow: {
        card: "0 2px 10px rgba(0,0,0,0.10)",
        float: "0 3px 12px rgba(0,0,0,0.16)",
        sheet: "0 -2px 16px rgba(0,0,0,0.10)",
      },
      borderRadius: {
        sheet: "16px",
      },
    },
  },
  plugins: [],
};
export default config;
