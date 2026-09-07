"use client";

import { useEffect } from "react";
import { useApp } from "@/lib/store";

export default function Toast() {
  const { toast, showToast } = useApp();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => showToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast, showToast]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-40 flex justify-center px-6">
      <div className="animate-fade-up rounded-full bg-black/80 px-4 py-2 text-[13px] text-white">
        {toast}
      </div>
    </div>
  );
}
