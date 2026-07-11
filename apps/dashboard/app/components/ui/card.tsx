// Card — designer contract: title, action, padding, sunken. A flat,
// hairline-bordered surface: no shadow, square corners. Styling follows
// components/display/Card.jsx in the DS bundle.
import { cn } from "~/lib/utils";

export interface CardProps extends React.ComponentProps<"div"> {
  /** Optional card title, rendered as an h3 in the title style. */
  title?: string;
  /** Optional right-aligned header slot (e.g. a ghost button). */
  action?: React.ReactNode;
  /** CSS padding override; defaults to the DS card padding (20px). */
  padding?: string;
  /** Sunken cards sit on the gray-50 ground (quoted content, wells). */
  sunken?: boolean;
}

export function Card({
  title,
  action,
  padding,
  sunken = false,
  className,
  style,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "border border-hairline p-5",
        sunken ? "bg-surface-sunken" : "bg-surface-card",
        className,
      )}
      style={padding !== undefined ? { padding, ...style } : style}
      {...props}
    >
      {(title || action) && (
        <div className="mb-3.5 flex items-center justify-between gap-3">
          {title && (
            <h3 className="m-0 text-title font-semibold text-ink-900">
              {title}
            </h3>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
