// Combobox — a searchable single-select in the Input treatment, for lists
// where a plain <select> is too clumsy to scan (#134's per-column mapping
// dropdowns). ARIA 1.2 combobox-with-listbox pattern: the text input
// filters, arrows move the active option, Enter picks, Escape closes and
// reverts. The chosen VALUE travels in a hidden input so the component
// works in plain <Form> posts with no client state to lose.
//
// Design system: square corners, ink outline, focus ring; the popup is a
// flat bordered surface (no shadow beyond the overlay token, no blur).
import { useId, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** One quiet qualifier rendered right-aligned in mono (e.g. "suggested"). */
  hint?: string;
}

export interface ComboboxProps {
  /** Form field name — the selected VALUE posts under this name. */
  name: string;
  options: ReadonlyArray<ComboboxOption>;
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the input (visually the table header labels it). */
  ariaLabel: string;
  id?: string;
  className?: string;
  inputClassName?: string;
}

export function Combobox({
  name,
  options,
  value,
  onChange,
  ariaLabel,
  id: idProp,
  className,
  inputClassName,
}: ComboboxProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const listboxId = `${id}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // null = not editing: the input shows the selected option's label.
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = options.find((option) => option.value === value);
  const filtered =
    query === null || query.trim() === ""
      ? options
      : options.filter((option) =>
          option.label.toLowerCase().includes(query.trim().toLowerCase()),
        );
  const active = filtered[activeIndex];

  function openList() {
    setOpen(true);
    setActiveIndex(
      Math.max(
        0,
        filtered.findIndex((option) => option.value === value),
      ),
    );
    // Select the shown label so typing REPLACES it — first keystroke
    // starts a fresh filter instead of appending to the old label.
    inputRef.current?.select();
  }

  function close() {
    setOpen(false);
    setQuery(null);
  }

  function pick(optionValue: string) {
    onChange(optionValue);
    close();
  }

  return (
    <div className={cn("relative", className)}>
      {/* The value the form actually posts. */}
      <input type="hidden" name={name} value={value} />
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && active ? `${id}-option-${active.value}` : undefined
        }
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        value={query ?? selected?.label ?? ""}
        placeholder="Don't import"
        onFocus={openList}
        onClick={openList}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={close}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) openList();
            else setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter") {
            if (open) {
              // Only intercept the form submit while choosing.
              event.preventDefault();
              if (active) pick(active.value);
            }
          } else if (event.key === "Escape") {
            if (open) {
              event.stopPropagation();
              close();
            }
          } else if (event.key === "Tab") {
            close();
          }
        }}
        className={cn(
          "w-full border border-outline-strong bg-surface-card px-2.5 py-2 font-sans text-small text-ink-900",
          "transition-shadow duration-100 ease-out",
          "placeholder:text-gray-400",
          "focus:shadow-focus-ring focus:outline-none",
          inputClassName,
        )}
      />
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 z-20 mt-1 max-h-64 w-56 min-w-full overflow-y-auto border border-ink-900 bg-surface-card shadow-overlay"
        >
          {filtered.length === 0 && (
            <div className="px-2.5 py-2 text-small text-gray-500">
              Nothing matches
            </div>
          )}
          {filtered.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-option-${option.value}`}
              role="option"
              // Focus stays on the combobox input (aria-activedescendant
              // points here); options are never tab stops themselves.
              tabIndex={-1}
              aria-selected={option.value === value}
              // mousedown, not click: it must win the race against onBlur.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(option.value);
              }}
              className={cn(
                "flex cursor-pointer items-baseline justify-between gap-3 px-2.5 py-2 text-small",
                index === activeIndex ? "bg-gray-100" : "hover:bg-gray-50",
                option.value === value
                  ? "font-semibold text-ink-900"
                  : "text-ink-900",
              )}
            >
              <span>{option.label}</span>
              {option.hint && (
                <span className="font-mono text-2xs uppercase tracking-label text-gray-500">
                  {option.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
