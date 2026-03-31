import React, { useState } from "react";
import {
  HiOutlineCamera,
  HiOutlineChip,
  HiOutlineChartBar,
  HiOutlineDocumentReport,
  HiOutlineCheckCircle,
  HiOutlineX,
  HiOutlineUpload,
  HiOutlineVideoCamera,
  HiOutlineAcademicCap,
  HiOutlineLightningBolt,
  HiOutlineDatabase,
  HiOutlineCloudUpload,
  HiOutlineArrowRight,
} from "react-icons/hi";

export default function HowItWorks() {
  const [isOpen, setIsOpen] = useState(true);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full glass rounded-2xl border border-neutral-800 p-4 shadow-premium hover:bg-premium-card-hover transition-colors text-left"
      >
        <div className="flex items-center justify-between">
          <div className="font-semibold text-white">How It Works</div>
          <div className="text-sm text-neutral-400">Click to expand</div>
        </div>
      </button>
    );
  }

  return (
    <div className="glass rounded-2xl border border-neutral-800 p-6 shadow-premium">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-sm text-neutral-400 uppercase tracking-wider mb-2">System Overview</div>
          <div className="text-2xl font-bold text-white">How It Works</div>
          <div className="text-sm text-neutral-300 mt-2">
            Complete workflow from data capture to report generation
          </div>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="text-neutral-400 hover:text-white transition-colors"
        >
          <HiOutlineX className="text-xl" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Step 1 */}
        <div 
          className={`rounded-xl border p-4 cursor-pointer transition-all ${
            expandedStep === 1 
              ? "border-premium-accent bg-premium-accent/10" 
              : "border-neutral-700 bg-premium-card/50 hover:border-premium-accent/50"
          }`}
          onClick={() => setExpandedStep(expandedStep === 1 ? null : 1)}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-accent flex items-center justify-center text-white font-bold">
              1
            </div>
            <HiOutlineCamera className="text-2xl text-premium-accent" />
          </div>
          <div className="font-semibold text-white mb-2">Data Capture</div>
          <div className="text-sm text-neutral-400 leading-relaxed mb-3">
            Upload images or video files from drone flights. Supports RGB and thermal imagery. 
            Live detection available for real-time processing.
          </div>
          {expandedStep === 1 && (
            <div className="mt-3 pt-3 border-t border-neutral-700 space-y-2">
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineUpload className="text-premium-accent" />
                <span>Single image upload</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineVideoCamera className="text-premium-accent" />
                <span>Video file processing</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineCloudUpload className="text-premium-accent" />
                <span>Bulk upload support</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineCamera className="text-premium-accent" />
                <span>Live camera feed</span>
              </div>
            </div>
          )}
        </div>

        {/* Step 2 */}
        <div 
          className={`rounded-xl border p-4 cursor-pointer transition-all ${
            expandedStep === 2 
              ? "border-premium-accent bg-premium-accent/10" 
              : "border-neutral-700 bg-premium-card/50 hover:border-premium-accent/50"
          }`}
          onClick={() => setExpandedStep(expandedStep === 2 ? null : 2)}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-accent flex items-center justify-center text-white font-bold">
              2
            </div>
            <HiOutlineChip className="text-2xl text-premium-accent" />
          </div>
          <div className="font-semibold text-white mb-2">AI Processing</div>
          <div className="text-sm text-neutral-400 leading-relaxed mb-3">
            YOLOv8 models analyze images to detect defects, components, and anomalies. 
            Custom trained models automatically applied for accurate detection.
          </div>
          {expandedStep === 2 && (
            <div className="mt-3 pt-3 border-t border-neutral-700 space-y-2">
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineLightningBolt className="text-premium-accent" />
                <span>YOLOv8 detection engine</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineAcademicCap className="text-premium-accent" />
                <span>Custom trained models</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineChip className="text-premium-accent" />
                <span>GPU/CPU acceleration</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineChartBar className="text-premium-accent" />
                <span>Real-time inference</span>
              </div>
            </div>
          )}
        </div>

        {/* Step 3 */}
        <div 
          className={`rounded-xl border p-4 cursor-pointer transition-all ${
            expandedStep === 3 
              ? "border-premium-accent bg-premium-accent/10" 
              : "border-neutral-700 bg-premium-card/50 hover:border-premium-accent/50"
          }`}
          onClick={() => setExpandedStep(expandedStep === 3 ? null : 3)}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-accent flex items-center justify-center text-white font-bold">
              3
            </div>
            <HiOutlineChartBar className="text-2xl text-premium-accent" />
          </div>
          <div className="font-semibold text-white mb-2">Analysis & Grading</div>
          <div className="text-sm text-neutral-400 leading-relaxed mb-3">
            Findings are automatically classified by severity (HIGH/MEDIUM/LOW) and assigned 
            confidence scores. Tower status calculated based on detected issues.
          </div>
          {expandedStep === 3 && (
            <div className="mt-3 pt-3 border-t border-neutral-700 space-y-2">
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <span className="w-2 h-2 rounded-full bg-premium-danger" />
                <span>HIGH: Critical defects</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <span className="w-2 h-2 rounded-full bg-premium-warning" />
                <span>MEDIUM: Moderate issues</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <span className="w-2 h-2 rounded-full bg-premium-success" />
                <span>LOW: Normal components</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineChartBar className="text-premium-accent" />
                <span>Confidence scoring</span>
              </div>
            </div>
          )}
        </div>

        {/* Step 4 */}
        <div 
          className={`rounded-xl border p-4 cursor-pointer transition-all ${
            expandedStep === 4 
              ? "border-premium-accent bg-premium-accent/10" 
              : "border-neutral-700 bg-premium-card/50 hover:border-premium-accent/50"
          }`}
          onClick={() => setExpandedStep(expandedStep === 4 ? null : 4)}
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-accent flex items-center justify-center text-white font-bold">
              4
            </div>
            <HiOutlineDocumentReport className="text-2xl text-premium-accent" />
          </div>
          <div className="font-semibold text-white mb-2">Report Generation</div>
          <div className="text-sm text-neutral-400 leading-relaxed mb-3">
            Comprehensive PDF reports generated with annotated images, findings list, 
            severity breakdown, and recommendations. Export data in JSON/CSV formats.
          </div>
          {expandedStep === 4 && (
            <div className="mt-3 pt-3 border-t border-neutral-700 space-y-2">
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineDocumentReport className="text-premium-accent" />
                <span>Professional PDF reports</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineDatabase className="text-premium-accent" />
                <span>JSON/CSV export</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineChartBar className="text-premium-accent" />
                <span>Annotated images</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-neutral-300">
                <HiOutlineCheckCircle className="text-premium-accent" />
                <span>Executive summaries</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Workflow Diagram */}
      <div className="mt-6 pt-6 border-t border-neutral-800">
        <div className="text-sm font-semibold text-white mb-4">Complete Workflow</div>
        <div className="flex items-center justify-between gap-4 overflow-x-auto pb-4">
          <div className="flex items-center gap-2 min-w-fit">
            <div className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 p-3">
              <HiOutlineCamera className="text-2xl text-premium-accent" />
            </div>
            <div className="text-xs text-neutral-400">Capture</div>
          </div>
          <HiOutlineArrowRight className="text-premium-accent flex-shrink-0" />
          <div className="flex items-center gap-2 min-w-fit">
            <div className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 p-3">
              <HiOutlineUpload className="text-2xl text-premium-accent" />
            </div>
            <div className="text-xs text-neutral-400">Upload</div>
          </div>
          <HiOutlineArrowRight className="text-premium-accent flex-shrink-0" />
          <div className="flex items-center gap-2 min-w-fit">
            <div className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 p-3">
              <HiOutlineChip className="text-2xl text-premium-accent" />
            </div>
            <div className="text-xs text-neutral-400">Process</div>
          </div>
          <HiOutlineArrowRight className="text-premium-accent flex-shrink-0" />
          <div className="flex items-center gap-2 min-w-fit">
            <div className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 p-3">
              <HiOutlineChartBar className="text-2xl text-premium-accent" />
            </div>
            <div className="text-xs text-neutral-400">Analyze</div>
          </div>
          <HiOutlineArrowRight className="text-premium-accent flex-shrink-0" />
          <div className="flex items-center gap-2 min-w-fit">
            <div className="rounded-xl border border-premium-accent/50 bg-premium-accent/10 p-3">
              <HiOutlineDocumentReport className="text-2xl text-premium-accent" />
            </div>
            <div className="text-xs text-neutral-400">Report</div>
          </div>
        </div>
      </div>

      {/* Key Features */}
      <div className="mt-6 pt-6 border-t border-neutral-800">
        <div className="text-sm font-semibold text-white mb-4">Key Features</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-premium-success/30 bg-premium-success/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <HiOutlineCheckCircle className="text-premium-success text-xl" />
              <div className="font-semibold text-white">Zero-Exfiltration</div>
            </div>
            <div className="text-sm text-neutral-300 leading-relaxed">
              All processing happens locally. No data leaves your system. Perfect for sensitive infrastructure and air-gapped environments.
            </div>
          </div>

          <div className="rounded-xl border border-premium-accent/30 bg-premium-accent/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <HiOutlineAcademicCap className="text-premium-accent text-xl" />
              <div className="font-semibold text-white">Custom Models</div>
            </div>
            <div className="text-sm text-neutral-300 leading-relaxed">
              Train your own YOLOv8 models with your datasets. Full control over detection accuracy, classes, and model variants (nano to xlarge).
            </div>
          </div>

          <div className="rounded-xl border border-premium-warning/30 bg-premium-warning/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <HiOutlineVideoCamera className="text-premium-warning text-xl" />
              <div className="font-semibold text-white">Real-Time Processing</div>
            </div>
            <div className="text-sm text-neutral-300 leading-relaxed">
              Live detection and video processing. Get instant results as you fly or process recorded footage frame-by-frame.
            </div>
          </div>
        </div>
      </div>

      {/* Technical Details */}
      <div className="mt-6 pt-6 border-t border-neutral-800">
        <div className="text-sm font-semibold text-white mb-4">Technical Details</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-neutral-700 bg-premium-card/30 p-3">
            <div className="text-xs text-neutral-400 mb-1">Detection Format</div>
            <div className="text-sm font-semibold text-white">YOLOv8</div>
          </div>
          <div className="rounded-lg border border-neutral-700 bg-premium-card/30 p-3">
            <div className="text-xs text-neutral-400 mb-1">Output Format</div>
            <div className="text-sm font-semibold text-white">Bbox XYXY</div>
          </div>
          <div className="rounded-lg border border-neutral-700 bg-premium-card/30 p-3">
            <div className="text-xs text-neutral-400 mb-1">Report Format</div>
            <div className="text-sm font-semibold text-white">PDF + JSON</div>
          </div>
          <div className="rounded-lg border border-neutral-700 bg-premium-card/30 p-3">
            <div className="text-xs text-neutral-400 mb-1">Processing</div>
            <div className="text-sm font-semibold text-white">Local/Offline</div>
          </div>
        </div>
      </div>
    </div>
  );
}

