// Layout route: wraps every product surface in the app shell. Resource
// routes (healthz) stay outside it in routes.ts.
import { Outlet } from "react-router";

import { AppShell } from "~/components/shell/app-shell";

export default function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
