import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconMic = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export const IconMenu = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconLocate = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="8" opacity="0.45" />
  </svg>
);

export const IconLayers = (p: P) => (
  <svg {...base(p)}>
    <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
    <path d="m4 12.5 8 4.5 8-4.5" />
  </svg>
);

export const IconSwap = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4v13m0 0-3-3m3 3 3-3" />
    <path d="M17 20V7m0 0-3 3m3-3 3 3" />
  </svg>
);

export const IconWalk = (p: P) => (
  <svg {...base(p)}>
    <circle cx="13" cy="4" r="1.7" />
    <path d="M11 21l1.5-5.5L10 13V9l4-1 2.5 3.5 2.5 1" />
    <path d="M10 13 7 16l-1 5" />
  </svg>
);

export const IconBus = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="3" width="16" height="14" rx="3" />
    <path d="M4 11h16M8 21v-2M16 21v-2" />
    <circle cx="8.5" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconClock = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);

export const IconMoon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
);

export const IconTree = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3 6.5 11h3L5 17h14l-4.5-6h3L12 3Z" />
    <path d="M12 17v4" />
  </svg>
);

export const IconStairs = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 20h5v-4h5v-4h5V8h3" />
  </svg>
);

export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <path d="m4 11 8-7 8 7" />
    <path d="M6 10v10h12V10" />
  </svg>
);

export const IconBookmark = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4h10v16l-5-3.5L7 20V4Z" />
  </svg>
);

export const IconCompass = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
  </svg>
);

export const IconUser = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5" />
  </svg>
);

export const IconChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const IconCctv = (p: P) => (
  <svg {...base(p)}>
    <path d="m3 8 13-4 2 5-13 4L3 8Z" />
    <path d="M7 13v3a3 3 0 0 0 3 3h6" />
    <path d="M18 9l3-1" />
  </svg>
);

export const IconSubway = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="3" width="14" height="13" rx="4" />
    <path d="M5 10h14M9 21l1.5-2M15 21l-1.5-2" />
    <circle cx="9" cy="13" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconLeaf = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 4c0 8-5 12-11 12H5c0-7 5-11 11-11h4Z" />
    <path d="M5 20c2-4 5-6 9-8" />
  </svg>
);

export const IconShield = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
  </svg>
);

export const IconHill = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 18h20" />
    <path d="m4 18 5-7 3.5 4.5L16 10l4 8" />
  </svg>
);

export const IconPeople = (p: P) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3" />
    <circle cx="17" cy="9" r="2.2" />
    <path d="M3 19c1-3.2 3.4-5 6-5s5 1.8 6 5M16 14.5c2 .4 3.4 2 4 4.5" />
  </svg>
);

export const IconDetour = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 21V9a3 3 0 0 1 6 0v6a3 3 0 0 0 6 0V4" />
    <path d="m16 7 3-3 3 3" />
  </svg>
);

export const IconSeat = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4v9a2 2 0 0 0 2 2h6" />
    <path d="M17 8v12" />
    <path d="M7 20h9" />
  </svg>
);

export const IconSettings = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" />
  </svg>
);

export const IconChevronDown = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconTransfer = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8h13m0 0-3-3m3 3-3 3" />
    <path d="M20 16H7m0 0 3-3m-3 3 3 3" />
  </svg>
);

export const IconFlag = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 21V4h12l-2.5 4L18 12H6" />
  </svg>
);

export const IconCloud = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 18a4 4 0 0 1 .6-8A5 5 0 0 1 17 10a3.8 3.8 0 0 1 0 8H7Z" />
  </svg>
);

export const IconRain = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 15a4 4 0 0 1 .6-8A5 5 0 0 1 17 7a3.8 3.8 0 0 1 0 8H7Z" />
    <path d="M9 18.5 8 21M13 18.5 12 21M17 18.5 16 21" />
  </svg>
);

export const IconSnow = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 15a4 4 0 0 1 .6-8A5 5 0 0 1 17 7a3.8 3.8 0 0 1 0 8H7Z" />
    <path d="M9 19h.01M13 20h.01M17 19h.01" />
  </svg>
);

export const IconShelter = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 11 12 4l9 7" />
    <path d="M6 10.5V20h12v-9.5" />
    <path d="M10 20v-4h4v4" />
  </svg>
);

export const IconNavigate = (p: P) => (
  <svg {...base(p)}>
    <path d="m4 11 16-7-7 16-2-7-7-2Z" />
  </svg>
);
