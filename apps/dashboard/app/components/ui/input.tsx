// Input — designer contract: label, hint, error. The label is a mono
// uppercase overline; the field is outlined in ink (interactive chrome is
// outlined in black), turning green on focus and red on error. Follows
// components/forms/Input.jsx in the DS bundle.
import { useId } from "react";

import { cn } from "~/lib/utils";

export interface InputProps extends React.ComponentProps<"input"> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({
  label,
  hint,
  error,
  id: idProp,
  className,
  ...props
}: InputProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const description = error || hint;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label
          htmlFor={id}
          className="font-mono text-label font-medium uppercase tracking-label text-gray-600"
        >
          {label}
        </label>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          "border bg-surface-card px-3 py-2.5 font-sans text-body text-ink-900",
          "placeholder:text-gray-400",
          "transition-shadow duration-100 ease-out",
          "focus:shadow-focus-ring focus:outline-none",
          "disabled:bg-surface-sunken disabled:opacity-60",
          error
            ? "border-status-negative"
            : "border-outline-strong focus:border-accent-600",
        )}
        {...props}
      />
      {description && (
        <span
          id={descriptionId}
          className={cn("text-small", error ? "text-danger" : "text-gray-500")}
        >
          {description}
        </span>
      )}
    </div>
  );
}
