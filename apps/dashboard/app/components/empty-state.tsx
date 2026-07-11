// EmptyState (#132): every surface ships with one until real data arrives.
// It teaches what the surface will do in one or two calm sentences — muted
// styling, centered in the content area, the surface's own sidebar icon.
//
// The optional action renders disabled with a "Coming soon" tooltip: the
// target flows belong to later epics (#7, #8), but the buttons stake out
// where they will live.
import type { LucideIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface EmptyStateProps extends React.ComponentProps<"div"> {
  icon: LucideIcon;
  heading: string;
  body: string;
  /** Label for a disabled, coming-soon action button. */
  actionLabel?: string;
}

export function EmptyState({
  icon: Icon,
  heading,
  body,
  actionLabel,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        "flex flex-col items-center border border-hairline bg-surface-card px-8 py-24 text-center",
        className,
      )}
      {...props}
    >
      <Icon
        size={20}
        strokeWidth={1.75}
        className="text-gray-400"
        aria-hidden
      />
      <h2 className="mt-4.5 mb-0 text-title font-semibold text-ink-900">
        {heading}
      </h2>
      <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
        {body}
      </p>
      {actionLabel && (
        // A disabled <button> swallows pointer events, so the tooltip
        // (plain title text for now; the DS Tooltip arrives with a surface
        // that needs it) lives on a wrapping span.
        <span title="Coming soon" className="mt-6 inline-flex">
          <Button variant="secondary" size="sm" disabled>
            {actionLabel}
          </Button>
        </span>
      )}
    </div>
  );
}
