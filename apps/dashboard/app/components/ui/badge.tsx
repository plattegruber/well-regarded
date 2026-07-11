// Badge — designer contract: tone: neutral | brand | positive | caution |
// negative | gold. Mono uppercase micro-label on a flat tinted ground;
// square corners. Styling follows components/display/Badge.jsx in the DS
// bundle (positive and gold intentionally share a rendering there).
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  cn(
    "inline-flex items-center gap-1.25 whitespace-nowrap",
    "px-2 py-1.25 font-mono text-2xs font-medium uppercase tracking-label",
  ),
  {
    variants: {
      tone: {
        neutral: "bg-gray-100 text-gray-600",
        brand: "bg-ink-900 text-on-dark",
        positive: "bg-status-positive-bg text-accent-800",
        caution: "bg-status-caution-bg text-status-caution",
        negative: "bg-status-negative-bg text-status-negative",
        gold: "bg-accent-100 text-accent-800",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
