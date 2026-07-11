// Per-screen header pattern from the mockup: an 11px mono uppercase
// overline, a 32px Space Grotesk h1 at -3% tracking, an optional subhead,
// and an optional right-aligned action.
//
// Voice rules (design/design-system/readme.md) — these components carry the
// product's voice, so copy passed to them must follow:
// - Sentence case everywhere; the only uppercase is mono micro-labels
//   (Overline renders that transform itself).
// - No exclamation points, no emoji. Warmth comes from word choice.
// - Understatement over hype; plain, honest numbers.
import { cn } from "~/lib/utils";

/** Mono uppercase micro-label — overlines, column heads, key-value labels. */
export function Overline({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "font-mono text-label font-medium uppercase tracking-label text-gray-500",
        className,
      )}
      {...props}
    />
  );
}

export interface PageHeaderProps extends React.ComponentProps<"header"> {
  /** Mono overline above the title (e.g. the date, or the surface name). */
  overline?: React.ReactNode;
  title: string;
  /** One quiet sentence under the title. Sentence case, period included. */
  description?: React.ReactNode;
  /** Right-aligned slot, usually a primary Button. */
  action?: React.ReactNode;
}

export function PageHeader({
  overline,
  title,
  description,
  action,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-testid="page-header"
      className={cn("mb-6.5 flex items-end justify-between gap-4", className)}
      {...props}
    >
      <div>
        {overline && <Overline className="mb-2.5">{overline}</Overline>}
        <h1 className="m-0 font-display text-h1 font-medium tracking-display text-ink-900">
          {title}
        </h1>
        {description && (
          <p className="mt-2 mb-0 text-body text-gray-600">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}
