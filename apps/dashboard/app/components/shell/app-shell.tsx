// App shell per the mockup (design/well-regarded-dashboard.dc.html):
// a 236px sticky white sidebar with a hairline right border — plain-type
// wordmark (no logo mark, by design), mode chip, the eight surfaces plus
// Settings, and a practice footer — beside a 1120px-max content column.
// There is no global top bar; each screen opens with its own PageHeader.
import { NavLink, useFetchers } from "react-router";

import { RatingStars } from "~/components/ui/rating-stars";
import { cn } from "~/lib/utils";
import { NAV_ITEMS, type NavItem, SETTINGS_ITEM } from "./nav";

// PLACEHOLDER until data wiring: the designer's demo practice (name now
// comes from the shell loader). The nav badge counts below are the same
// fixture (Reviews awaiting reply, open urgent Recovery items).
const PRACTICE = {
  rating: 4.8,
  meta: "214 reviews · 2 locations",
  mode: "Full Trust Loop",
};
const PLACEHOLDER_BADGES: Record<string, string> = {
  "/reviews": "2",
  "/recovery": "1",
};

function SidebarNavLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  const badge = item.badge ?? PLACEHOLDER_BADGES[item.to];
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          "flex w-full items-center gap-2.75 px-2.5 py-2.25 text-left",
          "font-sans text-small leading-none no-underline",
          "transition-colors duration-100 ease-out",
          "focus-visible:shadow-focus-ring focus-visible:outline-none",
          isActive
            ? "bg-accent-50 font-semibold text-accent-700 hover:text-accent-700"
            : "font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-600",
        )
      }
    >
      <Icon size={17} strokeWidth={1.75} className="shrink-0" aria-hidden />
      <span>{item.label}</span>
      {badge && (
        <span className="ml-auto bg-red-100 px-1.5 py-0.75 font-mono text-2xs font-medium leading-none text-red-700">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The optimistic-update reference (#141) — this is the copy-paste source.
 *
 * The practice-profile form (/settings/practice) submits with a fetcher.
 * While that submission is in flight, `useFetchers` exposes its pending
 * `formData` anywhere in the app, so the sidebar footer can show the new
 * name immediately instead of waiting for the round trip:
 *
 * 1. Submit → the fetcher's formData appears here → the footer renders
 *    the submitted name (optimistic).
 * 2. Action succeeds → loaders revalidate → the shell loader returns the
 *    saved name → same value, no visible change (reconciled).
 * 3. Action fails (validation or otherwise) → the fetcher settles without
 *    a mutation → revalidation returns the old name → the footer snaps
 *    back (rolled back). No manual cleanup — the fetcher's lifecycle is
 *    the state machine.
 */
function useOptimisticPracticeName(practiceName: string): string {
  const fetchers = useFetchers();
  const pending = fetchers.find(
    (fetcher) =>
      fetcher.formAction === "/settings/practice" &&
      fetcher.formData?.has("name"),
  );
  const submitted = pending?.formData?.get("name");
  const optimistic = typeof submitted === "string" ? submitted.trim() : "";
  return optimistic || practiceName;
}

export interface AppShellProps {
  /** The practice display name from the shell loader. */
  practiceName: string;
  children: React.ReactNode;
}

export function AppShell({ practiceName, children }: AppShellProps) {
  const displayName = useOptimisticPracticeName(practiceName);
  return (
    <div className="flex min-h-screen bg-surface-page font-sans text-ink-900">
      <aside
        data-testid="app-sidebar"
        className="sticky top-0 flex h-screen w-59 shrink-0 flex-col border-r border-hairline bg-surface-card px-3 py-5.5"
      >
        <div className="px-2.5 pb-1">
          {/* The wordmark is plain type — the DS forbids drawing a mark. */}
          <div className="font-display text-xl font-medium leading-none tracking-display text-ink-900">
            Well Regarded
          </div>
        </div>
        <div className="mx-2.5 mt-3 mb-1.5 border-b border-hairline pb-4.5">
          <span className="inline-flex items-center gap-1.5 bg-accent-50 px-2 py-1.25 font-mono text-2xs font-medium uppercase tracking-label text-accent-700">
            <span className="size-1.5 rounded-full bg-accent-600" />
            {PRACTICE.mode}
          </span>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <SidebarNavLink key={item.to} item={item} />
          ))}
        </nav>
        <nav aria-label="Secondary" className="mt-auto flex flex-col">
          <SidebarNavLink item={SETTINGS_ITEM} />
        </nav>
        <div className="mx-2.5 mt-3.5 flex flex-col gap-2 border-t border-hairline pt-3.5">
          <span className="text-small font-semibold leading-snug text-ink-900">
            {displayName}
          </span>
          <RatingStars rating={PRACTICE.rating} size={12} showValue />
          <span className="font-mono text-label font-medium text-gray-500">
            {PRACTICE.meta}
          </span>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-10.5 pt-7.5 pb-18">
        <div className="mx-auto max-w-280">{children}</div>
      </main>
    </div>
  );
}
