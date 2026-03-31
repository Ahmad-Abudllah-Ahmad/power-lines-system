import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

const icons = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const colorClasses: Record<ToastType, string> = {
  success: "border-emerald-500/50 bg-emerald-500/10 text-emerald-400",
  error: "border-red-500/50 bg-red-500/10 text-red-400",
  warning: "border-amber-500/50 bg-amber-500/10 text-amber-400",
  info: "border-blue-500/50 bg-blue-500/10 text-blue-400",
};

const ToastItem = React.forwardRef<HTMLDivElement, ToastItemProps>(({ toast, onRemove }, ref) => {
  useEffect(() => {
    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      const t = setTimeout(() => onRemove(toast.id), duration);
      return () => clearTimeout(t);
    }
  }, [toast.id, toast.duration, onRemove]);

  const Icon = icons[toast.type];
  const colorClass = colorClasses[toast.type];

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: 80, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 80, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className={`rounded-xl border ${colorClass} p-4 flex items-start gap-3 min-w-[300px] max-w-[420px] shadow-lg backdrop-blur-sm`}
    >
      <Icon className="shrink-0 mt-0.5" size={20} />
      <div className="flex-1 text-sm font-medium">{toast.message}</div>
      <button
        type="button"
        onClick={() => onRemove(toast.id)}
        className="shrink-0 text-neutral-400 hover:text-white transition-colors rounded p-1 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
        aria-label="Dismiss"
      >
        <X size={18} />
      </button>
    </motion.div>
  );
});

ToastItem.displayName = "ToastItem";

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-[9999] flex flex-col gap-2 max-w-[calc(100vw-3rem)]">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={onRemove} />
        ))}
      </AnimatePresence>
    </div>
  );
};

let toastIdCounter = 0;
const toastListeners: Set<(toasts: Toast[]) => void> = new Set();
let toasts: Toast[] = [];

const notify = () => toastListeners.forEach((fn) => fn([...toasts]));

export const toast = {
  success: (message: string, duration?: number) => {
    const id = `toast-${++toastIdCounter}`;
    toasts = [...toasts, { id, message, type: "success", duration }];
    notify();
    return id;
  },
  error: (message: string, duration?: number) => {
    const id = `toast-${++toastIdCounter}`;
    toasts = [...toasts, { id, message, type: "error", duration }];
    notify();
    return id;
  },
  warning: (message: string, duration?: number) => {
    const id = `toast-${++toastIdCounter}`;
    toasts = [...toasts, { id, message, type: "warning", duration }];
    notify();
    return id;
  },
  info: (message: string, duration?: number) => {
    const id = `toast-${++toastIdCounter}`;
    toasts = [...toasts, { id, message, type: "info", duration }];
    notify();
    return id;
  },
  remove: (id: string) => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  },
  clear: () => {
    toasts = [];
    notify();
  },
};

export function useToast() {
  const [list, setList] = React.useState<Toast[]>([]);

  useEffect(() => {
    const fn = (next: Toast[]) => setList(next);
    toastListeners.add(fn);
    setList([...toasts]);
    return () => {
      toastListeners.delete(fn);
    };
  }, []);

  return { toasts: list, remove: toast.remove, clear: toast.clear };
}
