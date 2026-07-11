// Layout route: wraps every product surface in the app shell. Resource
// routes (healthz) stay outside it in routes.ts.
//
// This is also where the app-wide chrome from #141 mounts, once: the
// navigation progress bar, the toaster, and the flash-toast bridge that
// turns the root loader's one-shot flash message into a toast.
import { useEffect, useRef } from "react";
import { Outlet, useRouteLoaderData } from "react-router";

import { AppShell } from "~/components/shell/app-shell";
import { NavigationProgress } from "~/components/shell/navigation-progress";
import { showFlashToast, Toaster } from "~/components/ui/toaster";
import { DEMO_PRACTICE_ID, practiceStore } from "~/lib/practice-store.server";
import type { loader as rootLoader } from "~/root";
import type { Route } from "./+types/shell";

export async function loader() {
  // TODO(auth): requireAuth — Epic #4 (#59); the practice then comes from
  // the actor instead of the demo fixture.
  const practice = await practiceStore.get(DEMO_PRACTICE_ID);
  return { practiceName: practice?.name ?? "Well Regarded" };
}

/**
 * Fires a toast when the root loader delivers a flash message. Keyed off
 * the flash's random id so revalidations can't replay it.
 */
function FlashToasts() {
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const flash = root?.flash ?? null;
  const shownId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (flash && shownId.current !== flash.id) {
      shownId.current = flash.id;
      showFlashToast(flash);
    }
  }, [flash]);

  return null;
}

export default function ShellLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell practiceName={loaderData.practiceName}>
      <NavigationProgress />
      <Toaster />
      <FlashToasts />
      <Outlet />
    </AppShell>
  );
}
