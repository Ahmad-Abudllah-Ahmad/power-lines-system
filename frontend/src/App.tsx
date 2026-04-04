import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import VideoUpload from "./pages/VideoUpload";
import Settings from "./pages/Settings";
import AIDetection from "./pages/AIDetection";
import ThermalImages from "./pages/ThermalImages";
import LoadingSpinner from "./components/LoadingSpinner";
import { IconDrone } from "@tabler/icons-react";

function LiveDroneFeed() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 select-none">
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, var(--accent-start, #0ea5e9), var(--accent-end, #6366f1))" }}
      >
        <IconDrone size={48} stroke={1.5} className="text-white" />
      </div>
      <h1 className="text-3xl font-bold dash-text-primary tracking-tight">Coming Soon</h1>
      <p className="text-base dash-text-secondary max-w-md text-center leading-relaxed">
        Live Drone Data Feed is under development. Real-time aerial monitoring and streaming analytics will be available here soon.
      </p>
    </div>
  );
}

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Runs = lazy(() => import("./pages/Runs"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const CorridorMap = lazy(() => import("./pages/CorridorMap"));
const ReviewQueue = lazy(() => import("./pages/ReviewQueue"));
// Import BulkBatches directly to avoid lazy loading issues

const LazyRoute = ({ children }: { children: React.ReactNode }) => (
  <Suspense
    fallback={
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading..." />
      </div>
    }
  >
    {children}
  </Suspense>
);

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<LazyRoute><Dashboard /></LazyRoute>} />
        <Route path="/runs" element={<LazyRoute><Runs /></LazyRoute>} />
        <Route path="/runs/:id" element={<LazyRoute><RunDetail /></LazyRoute>} />
        <Route path="/ai-detection" element={<AIDetection />} />
        <Route path="/thermal-images" element={<ThermalImages />} />
        <Route path="/video-upload" element={<VideoUpload />} />
        <Route path="/map" element={<LazyRoute><CorridorMap /></LazyRoute>} />
        <Route path="/review-queue" element={<LazyRoute><ReviewQueue /></LazyRoute>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/live-drone-feed" element={<LiveDroneFeed />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}
