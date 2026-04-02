import React, { useEffect, useRef, useState } from "react";
import type { Finding } from "./api";
import { formatDetectionLabel } from "../utils/formatLabels";

type Props = {
  src: string;
  findings: Finding[];
  assumedSize?: { w: number; h: number }; // must match API PDF assumptions for the demo image
};

export default function ImageAnnotator({ src, findings, assumedSize }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Detect actual image dimensions when image loads
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete) {
      setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, [src]);

  function draw() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Use natural dimensions for accurate scaling
    const naturalW = img.naturalWidth || 1;
    const naturalH = img.naturalHeight || 1;
    
    // Get displayed dimensions
    const displayW = img.clientWidth;
    const displayH = img.clientHeight;
    
    // Calculate scale factor (maintain aspect ratio)
    const scaleX = displayW / naturalW;
    const scaleY = displayH / naturalH;
    const scale = Math.min(scaleX, scaleY); // Use minimum to maintain aspect ratio
    
    // Calculate actual displayed image size (may be smaller due to aspect ratio)
    const scaledW = naturalW * scale;
    const scaledH = naturalH * scale;
    
    // Calculate offset to center the image
    const offsetX = (displayW - scaledW) / 2;
    const offsetY = (displayH - scaledH) / 2;
    
    // Set canvas size to match displayed image
    canvas.width = displayW;
    canvas.height = displayH;
    
    // Clear canvas
    ctx.clearRect(0, 0, displayW, displayH);
    
    // Draw bounding boxes
    for (const f of findings) {
      const [x1, y1, x2, y2] = f.bbox_xyxy;
      
      // Scale bounding box coordinates from original image to displayed size
      const rx = offsetX + x1 * scale;
      const ry = offsetY + y1 * scale;
      const rw = (x2 - x1) * scale;
      const rh = (y2 - y1) * scale;
      
      // Skip if box is outside visible area
      if (rx + rw < 0 || rx > displayW || ry + rh < 0 || ry > displayH) {
        continue;
      }
      
      // Determine color based on severity
      const isHovered = hoverId === f.id;
      let strokeColor = "#e53935"; // Default red
      let fillColor = "#e53935";
      
      if (f.severity === "HIGH") {
        strokeColor = isHovered ? "#ff0000" : "#dc2626";
        fillColor = isHovered ? "#ff0000" : "#dc2626";
      } else if (f.severity === "MEDIUM") {
        strokeColor = isHovered ? "#f59e0b" : "#d97706";
        fillColor = isHovered ? "#f59e0b" : "#d97706";
      } else {
        strokeColor = isHovered ? "#10b981" : "#059669";
        fillColor = isHovered ? "#10b981" : "#059669";
      }
      
      // Draw bounding box with thicker, clearer lines
      ctx.lineWidth = isHovered ? 4 : 3;
      ctx.strokeStyle = strokeColor;
      ctx.setLineDash([]);
      ctx.strokeRect(rx, ry, rw, rh);
      
      // Draw inner border for better visibility
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
      ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      
      // Prepare label text (label only; no percentages)
      const label = formatDetectionLabel(f.label);
      
      // Calculate label dimensions
      ctx.font = "bold 12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
      const textMetrics = ctx.measureText(label);
      const pad = 6;
      const textW = Math.min(textMetrics.width + pad * 2, rw);
      const textH = 18;
      
      // Position label above box, or inside if not enough space
      let labelX = rx;
      let labelY = Math.max(ry - textH - 2, 2);
      
      // If label would go off screen, position it inside the box
      if (labelY < 2) {
        labelY = ry + 2;
      }
      
      // Ensure label doesn't go off right edge
      if (labelX + textW > displayW) {
        labelX = displayW - textW - 2;
      }
      
      // Draw label background with rounded corners effect
      ctx.fillStyle = fillColor;
      ctx.fillRect(labelX, labelY, textW, textH);
      
      // Draw label border
      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(labelX, labelY, textW, textH);
      
      // Draw label text
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(label, labelX + pad, labelY + 3);
    }
  }

  useEffect(() => {
    // Wait for image to load before drawing
    const img = imgRef.current;
    if (img) {
      if (img.complete) {
        draw();
      } else {
        img.onload = () => {
          setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
          draw();
        };
      }
    }
    
    const onResize = () => {
      // Small delay to ensure layout is complete
      setTimeout(draw, 10);
    };
    
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (img) {
        img.onload = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, JSON.stringify(findings), hoverId, imageSize]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoom(prev => {
      const newZoom = Math.max(0.5, Math.min(3, prev * delta));
      // Redraw after zoom change
      setTimeout(draw, 10);
      return newZoom;
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
    
    // Update hover state - account for zoom and pan
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    
    // Adjust for zoom and pan transforms
    const x = (e.clientX - rect.left - pan.x) / zoom;
    const y = (e.clientY - rect.top - pan.y) / zoom;
    
    const img = imgRef.current;
    if (img) {
      const naturalW = img.naturalWidth || 1;
      const naturalH = img.naturalHeight || 1;
      const displayW = img.clientWidth;
      const displayH = img.clientHeight;
      const scaleX = displayW / naturalW;
      const scaleY = displayH / naturalH;
      const scale = Math.min(scaleX, scaleY);
      const scaledW = naturalW * scale;
      const scaledH = naturalH * scale;
      const offsetX = (displayW - scaledW) / 2;
      const offsetY = (displayH - scaledH) / 2;
      
      // Convert mouse position to image coordinates
      const imgX = (x - offsetX) / scale;
      const imgY = (y - offsetY) / scale;
      
      // Check if mouse is over any finding
      let found = null;
      for (const f of findings) {
        const [x1, y1, x2, y2] = f.bbox_xyxy;
        if (imgX >= x1 && imgX <= x2 && imgY >= y1 && imgY <= y2) {
          found = f.id;
          break;
        }
      }
      setHoverId(found);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setTimeout(draw, 10);
  };

  return (
    <div className="relative w-full">
      <div className="absolute top-2 right-2 z-10 flex gap-2">
        <button
          onClick={resetView}
          className="rounded-lg bg-neutral-900/90 border border-neutral-700 text-white px-3 py-1.5 text-xs font-semibold hover:bg-neutral-800 transition-colors shadow-lg"
        >
          Reset View
        </button>
        <div className="rounded-lg bg-neutral-900/90 border border-neutral-700 text-white px-3 py-1.5 text-xs shadow-lg">
          {Math.round(zoom * 100)}%
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-2xl border border-neutral-700 shadow-premium bg-neutral-900"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <div
          className="relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.1s'
          }}
        >
          <img
            ref={imgRef}
            src={src}
            alt="tower inspection"
            className="w-full h-auto object-contain"
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImageSize({ w: img.naturalWidth, h: img.naturalHeight });
              setTimeout(draw, 10);
            }}
            onError={(e) => {
              // If image fails to load, show placeholder
              const img = e.currentTarget;
              img.style.display = 'none';
              console.error('Failed to load image:', src);
            }}
          />
          <canvas 
            ref={canvasRef} 
            className="absolute inset-0 pointer-events-none"
            style={{ 
              pointerEvents: 'auto',
              cursor: hoverId ? 'pointer' : 'default'
            }}
            onMouseLeave={() => setHoverId(null)}
          />
        </div>
      </div>
    </div>
  );
}
