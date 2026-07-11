// Dev-only design-system reference: every component in every variant, plus
// the token ramps. This is the review artifact for #115 and the drift check
// for later surface work. The loader 404s outside dev.
import { useState } from "react";

import { Overline, PageHeader } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { RatingStars } from "~/components/ui/rating-stars";
import { Tabs } from "~/components/ui/tabs";
import { Tag } from "~/components/ui/tag";

export function meta() {
  return [{ title: "Styleguide · Well Regarded" }];
}

export function loader() {
  if (import.meta.env.PROD) {
    throw new Response("Not found", { status: 404 });
  }
  return null;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12 border-t border-hairline pt-6">
      <Overline className="mb-5">{title}</Overline>
      {children}
    </section>
  );
}

function Swatch({ name }: { name: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="h-10 w-full border border-hairline"
        style={{ background: `var(--${name})` }}
      />
      <span className="font-mono text-2xs text-gray-500">--{name}</span>
    </div>
  );
}

const RAMP = [
  "ink-900",
  "ink-800",
  "ink-700",
  "gray-600",
  "gray-500",
  "gray-400",
  "gray-300",
  "gray-200",
  "gray-100",
  "gray-50",
  "accent-800",
  "accent-700",
  "accent-600",
  "accent-500",
  "accent-200",
  "accent-100",
  "accent-50",
  "red-700",
  "red-100",
  "amber-700",
  "amber-100",
];

const BADGE_TONES = [
  "neutral",
  "brand",
  "positive",
  "caution",
  "negative",
  "gold",
] as const;

export default function Styleguide() {
  const [tab, setTab] = useState("all");
  const [sources, setSources] = useState<string[]>(["all"]);

  return (
    <>
      <PageHeader
        overline="Design system"
        title="Styleguide"
        description="Every component in every variant. Dev-only; the drift check for later surfaces."
        action={<Button>Send request</Button>}
      />

      <Section title="Palette">
        <div className="grid grid-cols-7 gap-3">
          {RAMP.map((name) => (
            <Swatch key={name} name={name} />
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        <div className="flex flex-col gap-4">
          <p className="m-0 font-display text-display-lg font-medium tracking-display">
            A reputation that reflects the care you give.
          </p>
          <p className="m-0 font-display text-h1 font-medium tracking-display">
            Page title, 32px display
          </p>
          <p className="m-0 text-title font-semibold">
            Screen and card titles, 16px
          </p>
          <p className="m-0 text-body">
            Default body, 15px. Well Regarded automatically requests patient
            feedback, monitors your reviews, and helps your team respond
            thoughtfully.
          </p>
          <p className="m-0 text-small text-gray-600">
            Secondary and meta text, 13px.
          </p>
          <p className="m-0 font-mono text-quote">
            "Review excerpts and signal text read like logs, set in mono."
          </p>
          <p className="m-0 font-mono text-data tabular-nums">
            214 reviews · 2 locations · 4.8
          </p>
          <Overline>Mono overline label, 11px, +8% tracking</Overline>
        </div>
      </Section>

      <Section title="Button">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Send request</Button>
            <Button variant="secondary">Review reply</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Remove access</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
          </div>
          <Button fullWidth variant="secondary">
            Full width
          </Button>
        </div>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap items-center gap-3">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="Card">
        <div className="grid grid-cols-2 gap-5">
          <Card
            title="Needs your attention"
            action={
              <Button variant="ghost" size="sm">
                See all
              </Button>
            }
          >
            <p className="m-0 text-small text-gray-600">
              A flat, hairline-bordered surface. No shadow, square corners.
            </p>
          </Card>
          <Card sunken title="Sunken card">
            <p className="m-0 font-mono text-quote">
              "Quoted content sits on the gray-50 ground."
            </p>
          </Card>
        </div>
      </Section>

      <Section title="Tag">
        <div className="flex flex-wrap items-center gap-3">
          <Tag>Dental anxiety</Tag>
          <Tag selected>All sources</Tag>
          <Tag
            selected={sources.includes("google")}
            onClick={() =>
              setSources((s) =>
                s.includes("google")
                  ? s.filter((x) => x !== "google")
                  : [...s, "google"],
              )
            }
          >
            Google
          </Tag>
          <Tag onRemove={() => {}}>Wait time</Tag>
        </div>
      </Section>

      <Section title="Rating stars">
        <div className="flex flex-col gap-3">
          <RatingStars rating={4.8} showValue />
          <RatingStars rating={2.5} showValue />
          <RatingStars rating={5} />
          <RatingStars rating={0} />
          <RatingStars rating={4.8} size={12} showValue />
        </div>
      </Section>

      <Section title="Input">
        <div className="grid max-w-100 grid-cols-1 gap-5">
          <Input label="Practice name" placeholder="Cedar Ridge Dental" />
          <Input
            label="Reply-to address"
            hint="Patients see this on feedback requests."
            defaultValue="front-desk@cedarridge.dental"
          />
          <Input
            label="Location"
            error="A location name is required."
            defaultValue=""
          />
          <Input label="Disabled" disabled defaultValue="Read only" />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "all", label: "All", count: 7 },
            { value: "awaiting", label: "Awaiting reply", count: 3 },
            { value: "attention", label: "Needs attention", count: 1 },
            { value: "replied", label: "Replied", count: 3 },
          ]}
        />
        <p className="mt-4 mb-0 font-mono text-data text-gray-500">
          Selected: {tab}
        </p>
      </Section>
    </>
  );
}
