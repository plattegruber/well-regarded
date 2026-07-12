// VisibilityBadge (#88): public vs private must be impossible to misread —
// publishing confusion is a real risk. Public renders as a quiet outlined
// chip (the mockup's treatment); private is deliberately louder: a filled
// amber chip with a lock icon. Shared by the inbox rows and the detail
// header.
import type { SignalVisibility } from "@wellregarded/core";
import { Lock } from "lucide-react";

import { cn } from "~/lib/utils";

export interface VisibilityBadgeProps extends React.ComponentProps<"span"> {
  visibility: SignalVisibility;
}

export function VisibilityBadge({
  visibility,
  className,
  ...props
}: VisibilityBadgeProps) {
  return (
    <span
      data-testid="visibility-badge"
      data-visibility={visibility}
      className={cn(
        "inline-flex items-center gap-1.25 whitespace-nowrap border px-1.5 py-1",
        "font-mono text-2xs font-medium uppercase tracking-label",
        visibility === "public"
          ? "border-accent-700 bg-transparent text-accent-700"
          : "border-amber-700 bg-amber-100 text-amber-700",
        className,
      )}
      {...props}
    >
      {visibility === "private" && (
        <Lock size={10} strokeWidth={2.5} aria-hidden="true" />
      )}
      {visibility}
    </span>
  );
}
