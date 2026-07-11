// Tag — designer contract: selected, onRemove, onClick. A mono chip
// outlined in ink; selected inverts to ink-on-white → white-on-ink.
// Styling follows components/display/Tag.jsx in the DS bundle.
import { X } from "lucide-react";

import { cn } from "~/lib/utils";

export interface TagProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "onClick"> {
  selected?: boolean;
  onClick?: (event: React.SyntheticEvent<HTMLElement>) => void;
  onRemove?: () => void;
}

export function Tag({
  selected = false,
  onClick,
  onRemove,
  className,
  children,
  ...props
}: TagProps) {
  const interactive = onClick !== undefined;
  const classes = cn(
    "inline-flex items-center gap-1.5 whitespace-nowrap border",
    "px-2.5 py-1.75 font-mono text-xs font-medium leading-none",
    "transition-colors duration-100 ease-out",
    selected
      ? "border-ink-900 bg-ink-900 text-on-dark"
      : "border-outline-strong bg-surface-card text-ink-900",
    interactive && !selected && "cursor-pointer hover:bg-gray-50",
    interactive && "focus-visible:shadow-focus-ring focus-visible:outline-none",
    className,
  );

  const remove = onRemove && (
    <button
      type="button"
      aria-label="Remove"
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
      className="cursor-pointer border-none bg-transparent p-0 text-current opacity-60 hover:opacity-100"
    >
      <X size={12} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );

  // Filter chips are buttons; static tags are spans. A remove control can
  // sit inside a span but not inside a button (invalid nesting), so a tag
  // with both onClick and onRemove is a span with button semantics.
  if (interactive && !onRemove) {
    return (
      <button type="button" onClick={onClick} className={classes} {...props}>
        {children}
      </button>
    );
  }

  if (interactive) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: the remove control is a real <button>, which cannot nest inside another button — the chip itself must stay a span
      <span
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick?.(event);
          }
        }}
        className={classes}
        {...props}
      >
        {children}
        {remove}
      </span>
    );
  }

  return (
    <span className={classes} {...props}>
      {children}
      {remove}
    </span>
  );
}
