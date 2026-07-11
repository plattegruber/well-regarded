// The navigation contract: the eight product surfaces in the mockup's
// order, plus Settings. Route paths match what the skeleton issue (#132)
// creates; labels are the designer's, verbatim (sentence case).
// Icons are Lucide at 1.75 stroke in currentColor — the DS's flagged icon
// substitution (no brand icons exist).
import {
  Activity,
  BookText,
  Globe,
  Inbox,
  LineChart,
  type LucideIcon,
  Settings,
  Star,
  Sun,
  Target,
} from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * Badge slot: a short mono count for queue-like surfaces (awaiting
   * replies, open recovery items). Data wiring replaces these; see the
   * placeholder counts in app-shell.tsx.
   */
  badge?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/today", label: "Today", icon: Sun },
  { to: "/signals", label: "Signals", icon: Inbox },
  { to: "/reviews", label: "Reviews", icon: Star },
  { to: "/recovery", label: "Recovery", icon: Activity },
  { to: "/proof", label: "Patient proof", icon: BookText },
  { to: "/coverage", label: "Trust coverage", icon: Target },
  { to: "/insights", label: "Insights", icon: LineChart },
  { to: "/presence", label: "Presence", icon: Globe },
];

export const SETTINGS_ITEM: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: Settings,
};
