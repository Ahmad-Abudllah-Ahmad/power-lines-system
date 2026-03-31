import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import VideoUpload from "./pages/VideoUpload";
import Settings from "./pages/Settings";
import AIDetection from "./pages/AIDetection";
import ThermalImages from "./pages/ThermalImages";
import LoadingSpinner from "./components/LoadingSpinner";

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
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}
