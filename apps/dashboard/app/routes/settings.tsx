// Settings (#132): a section list instead of an EmptyState — six cards,
// one per settings area. Practice profile is live (the #141 reference
// page); the rest are placeholders that later epics activate (API keys via
// Epic #14, integrations via Epics #7/#8).
import { Link } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Card } from "~/components/ui/card";
import { SURFACES, surfaceTitle } from "~/lib/surfaces";
import type { Route } from "./+types/settings";

const surface = SURFACES.settings;

interface Section {
  title: string;
  description: string;
  /** Present when the section's page exists. */
  to?: string;
}

export const SETTINGS_SECTIONS: Section[] = [
  {
    title: "Practice profile",
    description: "Name, contact details, and time zone.",
    to: "/settings/practice",
  },
  { title: "Locations", description: "The physical places patients visit." },
  { title: "Providers", description: "The clinicians patients write about." },
  {
    title: "Team",
    description: "Who is on the account, and what they can do.",
  },
  {
    title: "Integrations",
    description: "Google Business Profile and other feedback sources.",
  },
  {
    title: "API keys",
    description: "Programmatic access for your website and tools.",
  },
];

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

export function loader() {
  // TODO(auth): requireAuth — Epic #4 (#59).
  return { surface };
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { surface } = loaderData;
  return (
    <>
      <PageHeader
        overline={surface.overline}
        title={surface.title}
        description={surface.description}
      />
      <div className="flex flex-col gap-3.5">
        {SETTINGS_SECTIONS.map((section) =>
          section.to ? (
            <Link
              key={section.title}
              to={section.to}
              className="no-underline focus-visible:shadow-focus-ring focus-visible:outline-none"
            >
              <Card
                title={section.title}
                className="transition-colors duration-100 ease-out hover:bg-gray-50"
              >
                <p className="m-0 text-small text-gray-600">
                  {section.description}
                </p>
              </Card>
            </Link>
          ) : (
            <Card
              key={section.title}
              title={section.title}
              action={
                <span className="font-mono text-2xs font-medium uppercase tracking-label text-gray-400">
                  Coming soon
                </span>
              }
              className="opacity-60"
            >
              <p className="m-0 text-small text-gray-600">
                {section.description}
              </p>
            </Card>
          ),
        )}
      </div>
    </>
  );
}
