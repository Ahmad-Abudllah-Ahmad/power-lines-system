import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { getRuns, checkApiHealth, API_BASE } from "../api/api";
import { toast } from "../components/Toast";
import {
  Settings as SettingsIcon,
  Server,
  Download,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  FileJson,
} from "lucide-react";

export default function Settings() {
  const [exporting, setExporting] = useState(false);
  const [health, setHealth] = useState<{ healthy: boolean; latency?: number } | null>(null);

  useEffect(() => {
    const run = async () => {
      const h = await checkApiHealth();
      setHealth(h);
    };
    run();
  }, []);

  const apiBase = typeof import.meta.env.VITE_API_BASE === "string" ? import.meta.env.VITE_API_BASE : API_BASE;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      <div>
        <h1 className="text-3xl font-bold dash-text-primary mb-2">Settings</h1>
        <p className="dash-text-muted">
          API configuration, health status, and data export.
        </p>
      </div>

      {/* API & Health */}
      <div className="dash-panel rounded-2xl p-6 backdrop-blur-sm space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <Server className="text-cyan-400" size={22} />
          <h2 className="text-lg font-semibold dash-text-primary">API & Health</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="dash-nested rounded-xl p-4">
            <div className="text-xs font-medium dash-text-muted uppercase tracking-wider mb-2">API base URL</div>
            <div className="font-Poppins text-sm dash-text-primary break-all">{apiBase}</div>
            <div className="flex items-start gap-2 mt-2 text-xs dash-text-muted">
              <Info size={14} className="shrink-0 mt-0.5" />
              <span>Set VITE_API_BASE in .env (default: http://localhost:8080). Restart dev server after change.</span>
            </div>
          </div>
          <div className="dash-nested rounded-xl p-4">
            <div className="text-xs font-medium dash-text-muted uppercase tracking-wider mb-2">Health status</div>
            {health === null ? (
              <div className="text-sm dash-text-muted">Checking...</div>
            ) : (
              <div
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium ${
                  health.healthy
                    ? health.latency != null && health.latency > 2000
                      ? "bg-amber-500/10 border-amber-500/50 text-amber-400"
                      : "bg-emerald-500/10 border-emerald-500/50 text-emerald-400"
                    : "bg-red-500/10 border-red-500/50 text-red-400"
                }`}
              >
                {health.healthy ? (
                  health.latency != null && health.latency > 2000 ? (
                    <AlertCircle size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )
                ) : (
                  <XCircle size={16} />
                )}
                <span>
                  {health.healthy
                    ? health.latency != null
                      ? `Online (${health.latency}ms)`
                      : "Online"
                    : "Offline"}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Preferences */}
      <div className="dash-panel rounded-2xl p-6 backdrop-blur-sm space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon className="text-cyan-400" size={22} />
          <h2 className="text-lg font-semibold dash-text-primary">Preferences</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="dash-nested rounded-xl p-4">
            <div className="text-sm font-semibold dash-text-primary">Security</div>
            <div className="mt-2 text-sm dash-text-body">
              <span className="text-cyan-400">Zero-Exfiltration:</span> images and inference outputs can run on an offline workstation (air-gapped option).
            </div>
          </div>
          <div className="dash-nested rounded-xl p-4">
            <div className="text-sm font-semibold dash-text-primary">Model versions</div>
            <div className="mt-2 text-sm dash-text-muted">
              Shown in run detail metadata when available. Backend supplies pipeline/model info per run.
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
