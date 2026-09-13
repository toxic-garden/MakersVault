import React from "react";
import { Loader2, X } from "lucide-react";
import { cancelAdminJob, getAdminJob, type AdminJobStatus } from "../lib/api";

const STORAGE_KEY = "makersvault_active_job";

/** Remember the globally active admin job id (survives page reloads). */
export function rememberJobId(jobId: string | null) {
  try {
    if (jobId) window.sessionStorage.setItem(STORAGE_KEY, jobId);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable — monitoring simply won't survive a reload
  }
}

function readJobId(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

type Props = {
  /** Called when the tracked job transitions to done/error so views can refresh. */
  onFinished?: (status: AdminJobStatus) => void;
};

/**
 * Floating chip that tracks the globally active admin background job
 * (thumbnail backfill, mount rescan). Lives on App level so progress remains
 * visible in every view; the job id survives a page reload via sessionStorage.
 */
export default function GlobalJobMonitor({ onFinished }: Props) {
  const [status, setStatus] = React.useState<AdminJobStatus | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    const jobId = readJobId();
    if (!jobId) return;
    let cancelled = false;
    let failures = 0;
    const tick = async () => {
      try {
        const s = await getAdminJob(jobId);
        failures = 0;
        if (cancelled) return;
        setStatus(s);
        if (s.status === "done" || s.status === "error") {
          if (!doneRef.current) {
            doneRef.current = true;
            rememberJobId(null);
            onFinished?.(s);
            // Keep the finished summary visible for a moment, then hide.
            window.setTimeout(() => { if (!cancelled) setStatus(null); }, 6000);
          }
          return false as unknown as void; // stop polling
        }
      } catch {
        // Transient failures: keep trying for up to 30s, then give up.
        failures += 1;
        if (failures > 30) { rememberJobId(null); return; }
      }
      if (!cancelled) window.setTimeout(tick, 1000);
    };
    void tick();
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;
  if (status.status === "done" || status.status === "error" || status.status === "cancelled") {
    const isError = status.status === "error";
    const isCancelled = status.status === "cancelled";
    return (
      <div
        className={`fixed bottom-3 right-3 z-40 flex items-center gap-2 px-3 py-2 rounded-lg border shadow-md bg-panel-strong text-xs ${
          isError ? "border-red-300 dark:border-red-700" : "border-panel-strong"
        }`}
        title={status.message || undefined}
      >
        {isError ? (
          <span className="font-medium text-red-500">{status.message || "Job failed"}</span>
        ) : (
          <span className="font-medium text-muted">
            {status.message || (isCancelled ? "Cancelled" : `Done — ${status.generated} ok, ${status.failed} failed`)}
          </span>
        )}
        <button className="text-muted hover:text-foreground ml-1" onClick={() => setStatus(null)} aria-label="Dismiss">×</button>
      </div>
    );
  }
  const pct = status.total > 0 ? Math.min(100, Math.round((status.processed / status.total) * 100)) : 0;
  return (
    <div
      className="fixed bottom-3 right-3 z-40 flex items-center gap-2.5 px-3 py-2 rounded-lg border border-panel-strong shadow-md bg-panel-strong text-xs max-w-[320px]"
      title={status.message || undefined}
    >
      <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-accent" />
      <div className="flex-1 flex flex-col gap-1">
        <span className="font-medium text-muted whitespace-nowrap overflow-hidden text-ellipsis">
          {status.message || `${status.processed}/${status.total} processed · ${status.generated} ok · ${status.failed} failed`}
        </span>
        <div className="h-1 w-full rounded-full bg-panel-soft overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <button
        className="shrink-0 text-muted hover:text-red-500 disabled:opacity-50"
        disabled={cancelling}
        onClick={async () => {
          setCancelling(true);
          try {
            const s = await cancelAdminJob(status.id);
            setStatus(s);
          } catch {
            // ignore — the poll loop picks up the final state
          } finally {
            setCancelling(false);
          }
        }}
        title="Stop this job after the current item"
        aria-label="Cancel job"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}