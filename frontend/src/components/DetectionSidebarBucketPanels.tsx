import React from "react";
import { formatDetectionSidebarLabel, type DetectionSidebarPartition } from "../utils/detectionSidebarBuckets";

export function DetectionSidebarBucketPanels({
  partition,
  hideRowCounts = false,
}: {
  partition: DetectionSidebarPartition;
  hideRowCounts?: boolean;
}) {
  const { components, defects } = partition;
  const rowCls = "flex items-center justify-between gap-2 py-1 text-xs";
  return (
    <div className="shrink-0 border-b border-[var(--dash-panel-border)] p-4 space-y-3">
      {components.length > 0 && (
        <div>
          <div className="text-xs font-semibold dash-text-body mb-1.5">Components</div>
          <div className="space-y-1">
            {components.map(({ key, count }) => (
              <div key={`c-${key}`} className={rowCls}>
                <span className="min-w-0 truncate dash-text-primary" title={formatDetectionSidebarLabel(key)}>
                  {formatDetectionSidebarLabel(key)}
                </span>
                {!hideRowCounts && (
                  <span className="shrink-0 dash-text-primary font-semibold tabular-nums">{count}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {defects.length > 0 && (
        <div>
          <div className="text-xs font-semibold dash-text-body mb-1.5">Defects</div>
          <div className="space-y-1">
            {defects.map(({ key, count }) => (
              <div key={`d-${key}`} className={rowCls}>
                <span className="min-w-0 truncate dash-text-primary" title={formatDetectionSidebarLabel(key)}>
                  {formatDetectionSidebarLabel(key)}
                </span>
                {!hideRowCounts && (
                  <span className="shrink-0 dash-text-primary font-semibold tabular-nums">{count}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
