// Tabs — designer contract: tabs, value, defaultValue, onChange. Underline
// style: the active tab carries a 2px signal-green rule over the hairline
// baseline, with an optional mono count pill. Follows
// components/navigation/Tabs.jsx in the DS bundle.
import { useState } from "react";

import { cn } from "~/lib/utils";

export interface TabItem {
  value: string;
  label: React.ReactNode;
  count?: number;
}

export interface TabsProps
  extends Omit<React.ComponentProps<"div">, "onChange" | "defaultValue"> {
  tabs: Array<TabItem | string>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}

export function Tabs({
  tabs,
  value,
  defaultValue,
  onChange,
  className,
  ...props
}: TabsProps) {
  const items = tabs.map((tab) =>
    typeof tab === "string" ? { value: tab, label: tab } : tab,
  );
  const [internal, setInternal] = useState(
    defaultValue !== undefined ? defaultValue : items[0]?.value,
  );
  const current = value !== undefined ? value : internal;

  const pick = (next: string) => {
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  return (
    <div
      role="tablist"
      className={cn("flex gap-1 border-b border-hairline", className)}
      {...props}
    >
      {items.map((tab) => {
        const active = current === tab.value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => pick(tab.value)}
            className={cn(
              "-mb-px inline-flex cursor-pointer items-center gap-1.75",
              "border-x-0 border-t-0 border-b-2 bg-transparent px-3.5 py-2.5",
              "font-sans text-sm transition-colors duration-100 ease-out",
              "focus-visible:shadow-focus-ring focus-visible:outline-none",
              active
                ? "border-accent-600 font-semibold text-ink-900"
                : "border-transparent font-normal text-gray-600 hover:text-ink-900",
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  "px-1.5 py-0.75 font-mono text-2xs font-medium tabular-nums",
                  active
                    ? "bg-accent-100 text-accent-700"
                    : "bg-gray-100 text-gray-600",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
