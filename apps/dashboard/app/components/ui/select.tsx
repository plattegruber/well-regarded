// Select — native <select> in the Input treatment (designer contract:
// label, options, error; see component-apis.md). A plain select is the
// M0 answer for long option lists (#141); a searchable command palette is
// a later, per-surface decision.
import { useId } from "react";

import { cn } from "~/lib/utils";

export interface SelectProps extends React.ComponentProps<"select"> {
  label?: string;
  hint?: string;
  error?: string;
  options: ReadonlyArray<{ value: string; label?: string }>;
}

export function Select({
  label,
  hint,
  error,
  options,
  id: idProp,
  className,
  ...props
}: SelectProps) {
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
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          "appearance-none border bg-surface-card px-3 py-2.5 font-sans text-body text-ink-900",
          "transition-shadow duration-100 ease-out",
          "focus:shadow-focus-ring focus:outline-none",
          "disabled:bg-surface-sunken disabled:opacity-60",
          error
            ? "border-status-negative"
            : "border-outline-strong focus:border-accent-600",
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
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
