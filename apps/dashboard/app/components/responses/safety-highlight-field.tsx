// SafetyHighlightField (#79 requirement 4): a textarea with inline span
// highlights for `checkResponseSafety` findings — the mark-overlay
// technique. A positioned mark layer sits BEHIND a transparent-background
// textarea, rendering the same text (itself transparent) with <mark>s at
// finding spans; both layers share identical font metrics and padding, so
// the marks line up under the real characters, and scroll is mirrored.
//
// Accessibility: the overlay is decorative (aria-hidden; the marks would
// read as duplicate text otherwise). The findings themselves are conveyed
// by the visible findings list the composer renders below the field —
// wire it via `describedBy` so the textarea's aria-describedby points at
// it — and block-level findings set aria-invalid.
import { useRef } from "react";

import { type ComposerSafetyFinding, segmentText } from "~/lib/safety-spans";
import { cn } from "~/lib/utils";

/** Both layers must agree on every metric that affects glyph layout. */
const SHARED_TEXT_METRICS =
  "px-3 py-2.5 font-sans text-body whitespace-pre-wrap break-words";

export interface SafetyHighlightFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Findings for exactly `value`; pass [] while a check is stale/pending. */
  findings: readonly ComposerSafetyFinding[];
  /** id of the visible findings list (aria-describedby target). */
  describedBy?: string | undefined;
  label: string;
  name?: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Imperative handle so the composer can place the caret after inserts. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export function SafetyHighlightField({
  value,
  onChange,
  findings,
  describedBy,
  label,
  name,
  rows = 5,
  placeholder,
  disabled,
  textareaRef,
}: SafetyHighlightFieldProps) {
  const overlayRef = useRef<HTMLSpanElement>(null);
  const segments = segmentText(value, findings);
  const hasBlock = findings.some(
    (finding) => finding.level === "block" && finding.span !== null,
  );

  // Mirror the textarea's scroll offset onto the overlay so marks track
  // their characters while scrolling (recompute-on-scroll, no rAF needed —
  // it's a transform-free scrollTop copy).
  const syncScroll = (element: HTMLTextAreaElement) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.scrollTop = element.scrollTop;
    overlay.scrollLeft = element.scrollLeft;
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-label font-medium uppercase tracking-label text-gray-600">
        {label}
      </span>
      <span
        className={cn(
          "relative block border bg-surface-card",
          "transition-shadow duration-100 ease-out",
          "focus-within:shadow-focus-ring",
          hasBlock
            ? "border-status-negative"
            : "border-outline-strong focus-within:border-accent-600",
        )}
      >
        {/* The mark layer: same text, transparent glyphs, colored marks. */}
        <span
          ref={overlayRef}
          aria-hidden="true"
          data-testid="safety-highlight-overlay"
          className={cn(
            "pointer-events-none absolute inset-0 block overflow-hidden text-transparent",
            SHARED_TEXT_METRICS,
          )}
        >
          {segments.map((segment, index) => {
            const key = `${index}:${segment.level ?? "plain"}`;
            return segment.level === null ? (
              <span key={key}>{segment.text}</span>
            ) : (
              <mark
                key={key}
                data-level={segment.level}
                className={cn(
                  "text-transparent",
                  segment.level === "block"
                    ? "bg-status-negative-bg shadow-[inset_0_-2px_0_var(--status-negative)]"
                    : "bg-status-caution-bg shadow-[inset_0_-2px_0_var(--status-caution)]",
                )}
              >
                {segment.text}
              </mark>
            );
          })}
          {/* A trailing newline in a textarea adds a display line the
              overlay must reproduce, or marks near the end drift a line. */}
          {value.endsWith("\n") ? "\n" : null}
        </span>
        <textarea
          ref={textareaRef}
          name={name}
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={hasBlock || undefined}
          aria-describedby={describedBy}
          data-testid="composer-body"
          onChange={(event) => {
            onChange(event.currentTarget.value);
            syncScroll(event.currentTarget);
          }}
          onScroll={(event) => syncScroll(event.currentTarget)}
          className={cn(
            "relative block w-full resize-y bg-transparent text-ink-900",
            "placeholder:text-gray-400 focus:outline-none",
            "disabled:bg-surface-sunken disabled:opacity-60",
            SHARED_TEXT_METRICS,
          )}
        />
      </span>
    </label>
  );
}
