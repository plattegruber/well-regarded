// Toasts (#141): sonner restyled to the design system — square corners,
// ink border, mono uppercase title, flat white surface with the raised
// hairline shadow. Mounted once in the shell; fire with `toast(...)` for
// client-only updates or `setFlash` in an action for post-redirect
// success (docs/frontend-conventions.md covers which to use when).
import { Toaster as Sonner, toast } from "sonner";

import type { FlashMessage } from "~/lib/flash.server";
import { cn } from "~/lib/utils";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      // No icons: tone is carried by the title text, per the DS's quiet
      // register. Duration matches the house motion feel — brief, calm.
      icons={{ success: null, error: null, info: null }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn(
            "flex w-89 flex-col gap-1 border border-ink-900 bg-surface-card",
            "px-3.5 py-3 shadow-raised",
          ),
          title:
            "font-mono text-label font-semibold uppercase tracking-label text-ink-900",
          description: "font-sans text-small text-gray-600",
        },
      }}
    />
  );
}

/** Fire a toast for a server flash message (root loader → shell). */
export function showFlashToast(flash: FlashMessage) {
  const options = { description: flash.detail };
  switch (flash.tone) {
    case "positive":
      toast.success(flash.message, options);
      break;
    case "negative":
      toast.error(flash.message, options);
      break;
    default:
      toast(flash.message, options);
  }
}
