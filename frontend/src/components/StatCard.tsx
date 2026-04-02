import React from "react";
import { HiOutlineArrowUp, HiOutlineArrowDown, HiOutlineArrowRight } from "react-icons/hi";

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  gradient?: "accent" | "success" | "warning" | "danger";
  trend?: "up" | "down" | "neutral";
}

export function StatCard({ label, value, sub, icon, gradient = "accent", trend }: StatCardProps) {
  const gradientClasses = {
    accent: "from-premium-accent to-premium-accent-dark",
    success: "from-premium-success to-green-600",
    warning: "from-premium-warning to-amber-600",
    danger: "from-premium-danger to-red-600",
  };

  const trendIcons = {
    up: HiOutlineArrowUp,
    down: HiOutlineArrowDown,
    neutral: HiOutlineArrowRight,
  };

  return (
    <div
      className="stat-card-themed group relative rounded-2xl border p-6 transition-all duration-300 hover:scale-[1.02] overflow-hidden"
      style={{
        background: "var(--stat-card-bg)",
        borderColor: "var(--stat-card-border)",
      }}
    >
      {/* Background gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradientClasses[gradient]} opacity-10 group-hover:opacity-20 transition-opacity duration-300`} />
      
      {/* Animated background pattern */}
      <div className="absolute inset-0 opacity-5">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `radial-gradient(circle at 2px 2px, var(--stat-pattern-dot) 1px, transparent 0)`,
            backgroundSize: "24px 24px",
          }}
        />
      </div>

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <div
              className="font-medium uppercase tracking-wider mb-1"
              style={{ fontSize: "16px", color: "var(--stat-label)" }}
            >
              {label}
            </div>
            <div
              className="font-bold mt-2 mb-1"
              style={{ fontSize: "16px", color: "var(--stat-value)" }}
            >
              {value}
            </div>
            {sub && (
              <div className="mt-2" style={{ color: "var(--stat-sub)" }}>
                {sub}
              </div>
            )}
          </div>
          
          {icon && (
            <div className={`ml-4 p-3 rounded-xl bg-gradient-to-br ${gradientClasses[gradient]} opacity-20 group-hover:opacity-30 transition-opacity`}>
              <div className="text-2xl">{icon}</div>
            </div>
          )}
        </div>

        {trend && (() => {
          const TrendIcon = trendIcons[trend];
          return (
            <div className="flex items-center gap-1 mt-3">
              <TrendIcon
                className={`text-sm ${
                  trend === "up"
                    ? "text-premium-success"
                    : trend === "down"
                      ? "text-premium-danger"
                      : ""
                }`}
                style={trend === "neutral" ? { color: "var(--stat-sub)" } : undefined}
              />
              <span style={{ color: "var(--stat-sub)" }}>vs previous period</span>
            </div>
          );
        })()}
      </div>

      {/* Shine effect on hover */}
      <div
        className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000"
        style={{ background: "linear-gradient(to right, transparent, var(--stat-shine), transparent)" }}
      />
    </div>
  );
}
