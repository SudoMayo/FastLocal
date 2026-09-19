// Small presentational pieces shared by the phone page and the operator screen.
import type { Cause, StationStatus } from "@/lib/types";

export const STATUS_LABEL: Record<StationStatus, string> = {
  CLEAR: "Running",
  ALERT: "Risk alert",
  DISRUPTED: "Service stopped",
};

const STATUS_STYLE: Record<StationStatus, { pill: string; dot: string }> = {
  CLEAR: { pill: "bg-slate-500/15 text-slate-300 ring-slate-400/30", dot: "bg-slate-400" },
  ALERT: { pill: "bg-amber-500/15 text-amber-300 ring-amber-400/40", dot: "bg-amber-400" },
  DISRUPTED: { pill: "bg-rose-500/15 text-rose-300 ring-rose-400/50", dot: "bg-rose-500" },
};

export function StatusDot({ status, className = "" }: { status: StationStatus; className?: string }) {
  return (
    <span className={`relative inline-flex h-2.5 w-2.5 ${className}`}>
      {status === "DISRUPTED" && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${STATUS_STYLE[status].dot} opacity-75`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${STATUS_STYLE[status].dot}`} />
    </span>
  );
}

export function StatusPill({ status, size = "sm" }: { status: StationStatus; size?: "sm" | "lg" }) {
  const text = size === "lg" ? "text-base px-3 py-1.5" : "text-xs px-2.5 py-1";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full font-semibold ring-1 ${STATUS_STYLE[status].pill} ${text}`}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StationBoard({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "text-3xl px-5 py-2" : size === "sm" ? "text-sm px-2.5 py-0.5" : "text-xl px-4 py-1.5";
  return <span className={`station-board inline-block ${cls}`}>{name}</span>;
}

export function TrainMark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="11" fill="#38bdf8" />
      <rect x="10" y="8" width="20" height="19" rx="5" fill="#070b14" />
      <rect x="13" y="11" width="14" height="7" rx="2" fill="#facc15" />
      <circle cx="15" cy="23" r="1.8" fill="#38bdf8" />
      <circle cx="25" cy="23" r="1.8" fill="#38bdf8" />
      <path d="M12 32l4-5M28 32l-4-5" stroke="#070b14" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** Icon per disruption cause. Rain gets a cloud with drops. */
export function CauseIcon({ cause, className = "h-5 w-5" }: { cause: Cause; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (cause) {
    case "RAIN_FLOOD":
      return (
        <svg {...common}>
          <path d="M7 15a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 18.5 9 3.5 3.5 0 0 1 18 16H7" />
          <path d="M8 19l-1 2M12 19l-1 2M16 19l-1 2" />
        </svg>
      );
    case "SIGNAL_FAILURE":
      return (
        <svg {...common}>
          <rect x="8" y="2" width="8" height="16" rx="3" />
          <circle cx="12" cy="6.5" r="1.3" />
          <circle cx="12" cy="10" r="1.3" />
          <circle cx="12" cy="13.5" r="1.3" />
          <path d="M12 18v4" />
        </svg>
      );
    case "POWER_FAILURE":
      return (
        <svg {...common}>
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
        </svg>
      );
    case "TRACK_FAULT":
      return (
        <svg {...common}>
          <path d="M8 2L6 22M16 2l2 20M6.5 6h11M6 11h12M5.5 16h13" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      );
  }
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function ShieldIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6l8-3z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

export function CheckIcon({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Small pulsing dot that says "live". */
export function LiveDot({ className = "bg-emerald-400" }: { className?: string }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${className}`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${className}`} />
    </span>
  );
}
