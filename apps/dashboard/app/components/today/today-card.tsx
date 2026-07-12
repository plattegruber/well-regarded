// TodayCard (#95): ONE card shape for every queue condition — a tone
// badge, a title line, a mono meta line, and exactly one action linking
// into the owning surface. Category renderers in the route map rows →
// these props; there are deliberately no bespoke card layouts per
// category, and the card never contains the workflow — it routes to it.
import { Link } from "react-router";

import { Badge, type BadgeProps } from "~/components/ui/badge";

export interface TodayCardData {
  /** Stable key within the queue (row id). */
  id: string;
  /** Mono micro-label naming the condition ("Urgent · critical"). */
  tag: string;
  tone: NonNullable<BadgeProps["tone"]>;
  /** The card's one sentence — what this is. */
  title: string;
  /** Quiet mono context line ("Google · 3d ago"). */
  meta: string;
  /** The single action's label ("Respond"). */
  cta: string;
  /** Where the action goes — the owning surface. */
  to: string;
}

export function TodayCard({ card }: { card: TodayCardData }) {
  return (
    <Link
      to={card.to}
      data-testid="today-card"
      className="group flex items-start gap-3.5 border border-hairline bg-surface-card px-5 py-4 no-underline transition-colors duration-100 hover:bg-gray-50"
    >
      <span className="min-w-0 flex-1">
        <Badge tone={card.tone}>{card.tag}</Badge>
        <span className="mt-1.5 block font-sans text-body font-medium text-ink-900">
          {card.title}
        </span>
        <span className="mt-1 block font-mono text-label font-medium text-gray-500">
          {card.meta}
        </span>
      </span>
      <span className="mt-0.5 whitespace-nowrap font-mono text-label font-semibold uppercase tracking-label text-accent-700">
        {`${card.cta} →`}
      </span>
    </Link>
  );
}

export interface TodaySectionData {
  key: string;
  cards: TodayCardData[];
  /** "N more →" into the owning surface's list, when the cap was hit. */
  more: { count: number; to: string } | null;
}

export function TodaySection({ section }: { section: TodaySectionData }) {
  if (section.cards.length === 0) return null;
  return (
    <section
      data-testid={`today-section-${section.key}`}
      className="flex flex-col gap-2.5"
    >
      {section.cards.map((card) => (
        <TodayCard key={card.id} card={card} />
      ))}
      {section.more && (
        <Link
          to={section.more.to}
          className="self-start font-mono text-label font-medium uppercase tracking-label text-link no-underline"
        >
          {`${section.more.count} more →`}
        </Link>
      )}
    </section>
  );
}
