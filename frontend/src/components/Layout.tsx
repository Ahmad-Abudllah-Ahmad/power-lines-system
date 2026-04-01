import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  User,
} from "lucide-react";
import {
  IconLayoutDashboard,
  IconTarget,
  IconListNumbers,
  IconMap2,
  IconClipboardList,
  IconSettings,
} from "@tabler/icons-react";
import { ToastContainer, useToast } from "./Toast";
import { checkApiHealth } from "../api/api";
import { FloatingDock, type FloatingDockItem } from "./ui/floating-dock";

const dockItems: FloatingDockItem[] = [
  {
    title: "Dashboard",
    href: "/dashboard",
    end: true,
    icon: <IconLayoutDashboard stroke={1.5} className="size-[22px]" />,
  },
  {
    title: "AI Detection",
    href: "/ai-detection",
    icon: <IconTarget stroke={1.5} className="size-[22px]" />,
  },
  {
    title: "Recent Uploads",
    href: "/runs",
    icon: <IconListNumbers stroke={1.5} className="size-[22px]" />,
  },
  {
    title: "Corridor Map",
    href: "/map",
    icon: <IconMap2 stroke={1.5} className="size-[22px]" />,
  },
  {
    title: "Review Queue",
    href: "/review-queue",
    icon: <IconClipboardList stroke={1.5} className="size-[22px]" />,
  },
  {
    title: "Settings",
    href: "/settings",
    icon: <IconSettings stroke={1.5} className="size-[22px]" />,
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { toasts, remove } = useToast();
  const [apiHealth, setApiHealth] = useState<{ healthy: boolean; latency?: number }>({
    healthy: false,
  });

  useEffect(() => {
    const run = async () => {
      const h = await checkApiHealth();
      setApiHealth(h);
    };
    run();
    const id = setInterval(run, 30000);
    return () => clearInterval(id);
  }, []);

  const statusColor =
    apiHealth.healthy
      ? apiHealth.latency != null && apiHealth.latency > 2000
        ? { bg: "bg-amber-500/10", border: "border-amber-500/40", text: "text-amber-400", dot: "bg-amber-400" }
        : { bg: "bg-emerald-500/10", border: "border-emerald-500/40", text: "text-emerald-400", dot: "bg-emerald-400" }
      : { bg: "bg-red-500/10", border: "border-red-500/40", text: "text-red-400", dot: "bg-red-500" };

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white relative overflow-x-hidden">
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ── */}
      <header className="fixed top-0 left-0 right-0 z-50 h-20 flex items-center justify-between px-5 md:px-8 bg-[#0d1117]/95 border-b border-white/[0.06] backdrop-blur-md">

        {/* Left — Logo */}
        <div className="flex items-center h-full py-3">
          {/*
            KEY FIX:
            • No more nested fixed-size box trapping the image.
            • The img itself is sized directly: h-9 (36px) gives it real height.
            • py-1 on the wrapper provides top/bottom breathing room inside the header.
            • object-contain preserves the aspect ratio so wide logos don't distort.
          */}
          <div className="flex items-center justify-center w-[200px] md:w-[240px] h-full px-4">
            <img
              src="/azerenerji-logo.png"
              alt="AzərEnerji"
              style={{ width: "620px", height: "144px", objectFit: "contain", transform: "scale(1.3)", transformOrigin: "left" }}
              className="w-full h-full object-contain scale-125"
            />
          </div>
        </div>

        {/* Right — Status + User */}
        <div className="flex items-center gap-3">

          {/* API health pill */}
          <div
            className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-all
              ${statusColor.bg} ${statusColor.border} ${statusColor.text}`}
            title={
              apiHealth.healthy
                ? `API OK${apiHealth.latency != null ? ` · ${apiHealth.latency}ms` : ""}`
                : "API offline"
            }
          >
            {/* Animated dot instead of icon — cleaner at small sizes */}
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor.dot} ${apiHealth.healthy ? "animate-pulse" : ""}`} />
            <span>
              {apiHealth.healthy
                ? apiHealth.latency != null && apiHealth.latency > 2000
                  ? `Slow · ${apiHealth.latency}ms`
                  : "Online"
                : "Offline"}
            </span>
          </div>

          {/* Divider */}
          <div className="hidden sm:block w-px h-5 bg-white/10" />

          {/* User chip */}
          <div className="hidden sm:flex items-center gap-2.5 cursor-pointer group">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-neutral-700 to-neutral-800 border border-white/10 flex items-center justify-center text-neutral-400 group-hover:border-white/20 transition-colors">
              <User size={15} />
            </div>
            <span className="text-sm text-neutral-400 group-hover:text-neutral-300 transition-colors max-w-[96px] truncate">
              User
            </span>
          </div>
        </div>
      </header>

      <FloatingDock items={dockItems} />

      <main className="pt-20 min-h-screen pb-28 md:pb-32">
        <div className="p-4 md:p-6 max-w-[1600px] mx-auto">{children}</div>
      </main>
    </div>
  );
}