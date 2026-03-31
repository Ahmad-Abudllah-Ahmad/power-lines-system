import React from "react";
import { 
  HiOutlineExclamationCircle,
  HiOutlineExclamation,
  HiOutlineCheckCircle
} from "react-icons/hi";

export default function StatusBadge({ status }: { status: string }) {
  const s = status;
  const config =
    s === "REQUIRES_INSPECTION"
      ? {
          bg: "bg-premium-danger/30",
          text: "text-premium-danger",
          border: "border-premium-danger/70",
          icon: HiOutlineExclamationCircle,
        }
      : s === "MONITOR"
      ? {
          bg: "bg-premium-warning/30",
          text: "text-premium-warning",
          border: "border-premium-warning/70",
          icon: HiOutlineExclamation,
        }
      : {
          bg: "bg-premium-success/30",
          text: "text-premium-success",
          border: "border-premium-success/70",
          icon: HiOutlineCheckCircle,
        };

  const label = s.replaceAll("_", " ");
  const IconComponent = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${config.bg} ${config.text} ${config.border} shadow-sm`}
    >
      <IconComponent className="text-sm" />
      <span>{label}</span>
    </span>
  );
}
