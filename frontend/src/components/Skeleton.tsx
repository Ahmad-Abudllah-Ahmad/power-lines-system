import React from "react";
import { motion } from "framer-motion";

interface SkeletonProps {
  className?: string;
  animate?: boolean;
}

export function Skeleton({ className = "", animate = true }: SkeletonProps) {
  const base = "bg-neutral-700/60 rounded";
  return (
    <motion.div
      className={`${base} ${className}`}
      initial={animate ? { opacity: 0.6 } : undefined}
      animate={animate ? { opacity: [0.6, 1, 0.6] } : undefined}
      transition={animate ? { repeat: Infinity, duration: 1.5, ease: "easeInOut" } : undefined}
    />
  );
}

export function TableRowSkeleton({ cols = 8 }: { cols?: number }) {
  return (
    <tr className="border-b border-neutral-800">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-6 py-4">
          <Skeleton className="h-5 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

export function TableSkeleton({ rows = 5, cols = 8 }: { rows?: number; cols?: number }) {
  return (
    <tbody className="divide-y divide-neutral-800">
      {Array.from({ length: rows }).map((_, i) => (
        <TableRowSkeleton key={i} cols={cols} />
      ))}
    </tbody>
  );
}
