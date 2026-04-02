import React, { Fragment } from "react";
import { ChevronRight } from "lucide-react";

type Variant = "cyan" | "emerald" | "purple";

const titleAccent: Record<Variant, string> = {
  cyan: "text-cyan-400",
  emerald: "text-emerald-400",
  purple: "text-purple-300",
};

type UploadPipelineStripProps = {
  title: string;
  steps: string[];
  variant?: Variant;
};

export default function UploadPipelineStrip({ title, steps, variant = "cyan" }: UploadPipelineStripProps) {
  return (
    <div className="glass rounded-2xl border border-[var(--dash-panel-border)] p-4 shadow-premium">
      <div className={`mb-3 text-sm font-semibold dash-text-primary ${titleAccent[variant]}`}>{title}</div>
      <div className="-mx-1 overflow-x-auto pb-1">
        <div className="flex min-w-min flex-row flex-nowrap items-center gap-2 px-1">
          {steps.map((step, i) => (
            <Fragment key={i}>
              {i > 0 ? <ChevronRight className="shrink-0 text-neutral-500" size={18} aria-hidden /> : null}
              <div className="shrink-0 rounded-xl border border-[var(--dash-panel-border)] px-3 py-2.5 text-center text-xs font-medium dash-text-body whitespace-nowrap">
                {step}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
