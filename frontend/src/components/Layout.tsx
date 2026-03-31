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
  IconUser,
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
  const [apiHealth, setApiHealth] = useState<{ healthy: boolean; latency?: number }>({ healthy: false });

  useEffect(() => {
    const run = async () => {
      const h = await checkApiHealth();
      setApiHealth(h);
    };
    run();
    const id = setInterval(run, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white relative overflow-x-hidden">
      <ToastContainer toasts={toasts} onRemove={remove} />

      <header className="fixed top-0 left-0 right-0 z-50 h-14 flex items-center justify-between px-4 md:px-6 bg-[#0f1419]/95 border-b border-neutral-800 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/azerenerji-logo.png"
              alt="AzərEnerji Logo"
              className="h-20 md:h-24 w-auto object-contain"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className={`hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              apiHealth.healthy
                ? apiHealth.latency != null && apiHealth.latency > 2000
                  ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                  : "bg-emerald-500/10 border-emerald-500/50 text-emerald-400"
                : "bg-red-500/10 border-red-500/50 text-red-400"
            }`}
            title={apiHealth.healthy ? `API OK${apiHealth.latency != null ? ` (${apiHealth.latency}ms)` : ""}` : "API offline"}
          >
            {apiHealth.healthy ? (
              apiHealth.latency != null && apiHealth.latency > 2000 ? (
                <AlertCircle size={14} />
              ) : (
                <CheckCircle2 size={14} />
              )
            ) : (
              <XCircle size={14} />
            )}
            <span className="hidden sm:inline">
              {apiHealth.healthy ? (apiHealth.latency != null ? `${apiHealth.latency}ms` : "Online") : "Offline"}
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-neutral-700">
            <div className="w-8 h-8 rounded-lg bg-neutral-800 flex items-center justify-center text-neutral-400">
              <User size={18} />
            </div>
            <span className="text-sm text-neutral-400 max-w-[100px] truncate">User</span>
          </div>
        </div>
      </header>

      <FloatingDock items={dockItems} />

      <main className="pt-14 min-h-screen pb-28 md:pb-32">
        <div className="p-4 md:p-6 max-w-[1600px] mx-auto">{children}</div>
      </main>
    </div>
  );
}
