import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { getRuns, type Run } from "../api/api";
import LoadingSpinner from "../components/LoadingSpinner";
import { toast } from "../components/Toast";
import {
  ClipboardList,
  Search,
  AlertCircle,
  ChevronRight,
  Filter,
  Info,
} from "lucide-react";

export default function ReviewQueue() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");

  useEffect(() => {
    setLoading(true);
    getRuns()
      .then(setRuns)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Failed to load runs";
        setError(msg);
        toast.error(msg, 5000);
      })
      .finally(() => setLoading(false));
  }, []);

  const needsReview = runs.filter((r) => (r.must_review_count ?? 0) > 0);
  const filtered = needsReview.filter((run) => {
    const id = run.run_id ?? run.id;
    const matchSearch =
      !searchQuery ||
      id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (run.tower_id ?? "").toLowerCase().includes(searchQuery.toLowerCase());
    return matchSearch;
  });

  const sortTime = (r: Run) => new Date(r.created_at ?? r.timestamp ?? 0).getTime();
  const sorted = [...filtered].sort((a, b) => sortTime(b) - sortTime(a));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading review queue..." />
      </div>
    );
  }

  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border border-red-500/50 bg-red-500/10 p-6 text-red-400"
      >
        <div className="font-semibold mb-2">Error Loading Review Queue</div>
        <div className="text-sm mb-4">{error}</div>
        <button
          onClick={() => {
            setError(null);
            setLoading(true);
            getRuns()
              .then(setRuns)
              .catch((e) => setError(e instanceof Error ? e.message : "Failed"))
              .finally(() => setLoading(false));
          }}
          className="rounded-xl bg-cyan-500/20 text-cyan-300 px-4 py-2 text-sm font-semibold hover:bg-cyan-500/30 transition-colors"
        >
          Retry
        </button>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Review Queue</h1>
        <p className="text-neutral-400">
          Runs with findings that need human review. Approve, reject, or relabel (local mode until backend supports saving).
        </p>
      </div>

      {/* Local review mode banner */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 flex items-start gap-3"
      >
        <Info className="text-amber-400 shrink-0 mt-0.5" size={20} />
        <div>
          <div className="font-semibold text-amber-200">Local review mode</div>
          <div className="text-sm text-amber-200/80 mt-0.5">
            Review actions (approve/reject/relabel) are stored in this browser only. Backend persistence is not yet connected.
          </div>
        </div>
      </motion.div>

      {/* Filters */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={18} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by run ID or tower ID..."
              className="w-full rounded-xl bg-neutral-800 border border-neutral-700 text-white placeholder-neutral-500 pl-10 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="text-neutral-400" size={18} />
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="rounded-xl bg-neutral-800 border border-neutral-700 text-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-cyan-500/50"
            >
              <option value="all">All</option>
            </select>
          </div>
        </div>
      </div>

      {/* Queue list */}
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 overflow-hidden backdrop-blur-sm">
        {sorted.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <ClipboardList className="mx-auto text-neutral-500 mb-4" size={48} />
            <div className="text-neutral-400 font-medium">
              {needsReview.length === 0
                ? "No runs need review. All inspections are clear or already reviewed."
                : "No runs match your filters."}
            </div>
            {runs.length > 0 && needsReview.length === 0 && (
              <Link
                to="/runs"
                className="mt-4 inline-flex items-center gap-2 text-sm text-cyan-400 hover:text-cyan-300 font-medium"
              >
                View all runs
                <ChevronRight size={16} />
              </Link>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {sorted.map((run, i) => {
              const runId = run.run_id ?? run.id;
              const count = run.must_review_count ?? 0;
              return (
                <motion.li
                  key={run.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-neutral-800/50 transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-amber-500/20 text-amber-400">
                      <AlertCircle size={20} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-white truncate">{runId}</div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-neutral-400">
                        <span>{(run.created_at ?? run.timestamp) ? new Date(run.created_at ?? run.timestamp).toLocaleString() : "—"}</span>
                        {run.tower_id && <span>{run.tower_id}</span>}
                        <span className="text-amber-400 font-medium">{count} needs review</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`px-2 py-1 rounded-lg text-xs font-semibold ${
                        run.status === "completed"
                          ? "bg-green-500/20 text-green-400 border border-green-500/50"
                          : run.status === "failed"
                          ? "bg-red-500/20 text-red-400 border border-red-500/50"
                          : "bg-neutral-500/20 text-neutral-400 border border-neutral-500/50"
                      }`}
                    >
                      {run.status.toUpperCase()}
                    </span>
                    <Link
                      to={`/runs/${runId}`}
                      className="inline-flex items-center gap-1 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 px-4 py-2 text-sm font-semibold hover:bg-cyan-500/30 transition-colors"
                    >
                      Review
                      <ChevronRight size={16} />
                    </Link>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>
    </motion.div>
  );
}
