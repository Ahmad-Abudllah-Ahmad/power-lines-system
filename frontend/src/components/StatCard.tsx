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
    <div className="group relative rounded-2xl bg-gradient-card border border-neutral-800 p-6 shadow-premium card-glow-hover transition-all duration-300 hover:scale-[1.02] overflow-hidden">
      {/* Background gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${gradientClasses[gradient]} opacity-10 group-hover:opacity-20 transition-opacity duration-300`} />
      
      {/* Animated background pattern */}
      <div className="absolute inset-0 opacity-5">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 2px 2px, rgba(6, 182, 212, 0.3) 1px, transparent 0)`,
          backgroundSize: '24px 24px'
        }} />
      </div>

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <div className="font-medium text-neutral-400 uppercase tracking-wider mb-1"style={{ fontSize: '16px' }}>{label}</div>
            <div className="font-bold text-white mt-2 mb-1"style={{ fontSize: '16px' }}>{value}</div>
            {sub && (
              <div className="text-xs text-neutral-400 mt-2">{sub}</div>
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
            <div className="flex items-center gap-1 mt-3 text-xs">
              <TrendIcon className={`text-sm ${
                trend === "up" ? "text-premium-success" : 
                trend === "down" ? "text-premium-danger" : 
                "text-neutral-400"
              }`} />
              <span className="text-neutral-400">vs previous period</span>
            </div>
          );
        })()}
      </div>

      {/* Shine effect on hover */}
      <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
    </div>
  );
}
