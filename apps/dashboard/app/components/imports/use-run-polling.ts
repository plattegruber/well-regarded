// Live-progress polling for import runs (issue #137): re-run the route's
// loader every ~5s while a run is in flight — the dashboard's established
// revalidation pattern (React Router `useRevalidator`), deliberately not a
// websocket. Callers pass `active: false` on terminal statuses and the
// interval tears down.
import { useEffect } from "react";
import { useRevalidator } from "react-router";

export const IMPORT_RUN_POLL_INTERVAL_MS = 5_000;

export function useImportRunPolling(active: boolean): void {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, IMPORT_RUN_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [active, revalidator]);
}
