import React, { useEffect, useState } from "react";
import { Moon, Sun, User } from "lucide-react";
import {
  IconLayoutDashboard,
  IconTarget,
  IconListNumbers,
  IconMap2,
  IconClipboardList,
  IconSettings,
} from "@tabler/icons-react";
import { ToastContainer, useToast } from "./Toast";
import { ThemeProvider, type Theme } from "../context/ThemeContext";
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

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("theme");
  return stored === "light" || stored === "dark" ? stored : "dark";
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { toasts, remove } = useToast();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const logoSrc =
    theme === "light" ? encodeURI("/logo-1.png") : "/logo-2.png";

  return (
    <ThemeProvider value={{ theme, setTheme }}>
    <div
      className="min-h-screen relative overflow-x-hidden transition-[background-color,color] duration-200"
      style={{ backgroundColor: "var(--layout-bg)", color: "var(--layout-text)" }}
    >
      <ToastContainer toasts={toasts} onRemove={remove} />

      {/* ── Header ── */}
      <header
        className="fixed top-0 left-0 right-0 z-50 h-20 flex items-center justify-between px-5 md:px-8 backdrop-blur-md border-b transition-[background-color,border-color] duration-200"
        style={{
          backgroundColor: "var(--header-bg)",
          borderBottomColor: "var(--header-border)",
        }}
      >

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
              src={logoSrc}
              alt="AzərEnerji"
              style={{
                width: "620px",
                height: "144px",
                objectFit: "contain",
                transform: theme === "light" ? "scale(1.3)" : "scale(1.3)",
                transformOrigin: "left",
              }}
              className={theme === "light" ? "w-full h-full object-contain" : "w-full h-full object-contain"}
            />
          </div>
        </div>

        {/* Right — Theme + User */}
        <div className="flex items-center gap-3">

          {/* Theme: segmented toggle (Lucide Sun / Moon) */}
          <div
            className="inline-flex h-9 shrink-0 items-center rounded-full border p-1 gap-0.5"
            style={{
              backgroundColor: "var(--theme-toggle-bg)",
              borderColor: "var(--theme-toggle-border)",
            }}
            role="group"
            aria-label="Color theme"
          >
            <button
              type="button"
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
              aria-label="Light theme"
              title="Light theme"
              className={`flex size-7 items-center justify-center rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--layout-bg)] ${
                theme === "dark" ? "opacity-60 hover:opacity-100" : ""
              }`}
              style={
                theme === "light"
                  ? {
                      backgroundColor: "var(--theme-segment-active-bg)",
                      color: "var(--theme-segment-active-fg)",
                      boxShadow: "var(--theme-segment-active-shadow)",
                    }
                  : { color: "var(--theme-segment-muted)" }
              }
            >
              <Sun className="size-4" strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
              aria-label="Dark theme"
              title="Dark theme"
              className={`flex size-7 items-center justify-center rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--layout-bg)] ${
                theme === "light" ? "opacity-60 hover:opacity-100" : ""
              }`}
              style={
                theme === "dark"
                  ? {
                      backgroundColor: "var(--theme-segment-active-bg)",
                      color: "var(--theme-segment-active-fg)",
                      boxShadow: "var(--theme-segment-active-shadow)",
                    }
                  : { color: "var(--theme-segment-muted)" }
              }
            >
              <Moon className="size-4" strokeWidth={2} aria-hidden />
            </button>
          </div>

          {/* Divider */}
          <div
            className="hidden sm:block w-px h-5 transition-colors duration-200"
            style={{ backgroundColor: "var(--divider)" }}
          />

          {/* User chip */}
          <div className="hidden sm:flex items-center gap-2.5 cursor-pointer group">
            <div
              className="w-8 h-8 rounded-full border flex items-center justify-center transition-colors group-hover:[border-color:var(--user-chip-border-hover)]"
              style={{
                background: `linear-gradient(to bottom right, var(--user-chip-from), var(--user-chip-to))`,
                borderColor: "var(--user-chip-border)",
                color: "var(--user-chip-icon)",
              }}
            >
              <User size={15} />
            </div>
            <span
              className="text-sm max-w-[96px] truncate transition-colors group-hover:[color:var(--user-text-hover)]"
              style={{ color: "var(--user-text)" }}
            >
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
    </ThemeProvider>
  );
}