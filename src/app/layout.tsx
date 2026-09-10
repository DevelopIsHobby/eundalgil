import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BRAND } from "@/lib/config";
import ServiceWorker from "@/components/ServiceWorker";

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: BRAND.description,
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: BRAND.name },
  /*
   * 안드로이드 설치 배너는 192·512 PNG 를, iOS 홈 화면은 apple-touch-icon 을 본다.
   * SVG 만 두면 아이폰에서 흐릿한 캡처 화면이 아이콘 자리에 박힌다.
   */
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0FA958",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
