// Parameterized over the copy table in app/lib/surfaces.ts — the single
// source both the routes and this test read, per #132: each surface must
// render its exact empty-state heading and body copy.
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { SURFACES, surfaceTitle, todayOverline } from "~/lib/surfaces";
import Coverage, {
  loader as coverageLoader,
  meta as coverageMeta,
} from "./coverage";
import { loader as homeLoader } from "./home";
import Insights, {
  loader as insightsLoader,
  meta as insightsMeta,
} from "./insights";
import { loader as notFoundLoader } from "./not-found";
import Presence, {
  loader as presenceLoader,
  meta as presenceMeta,
} from "./presence";
import Proof, { loader as proofLoader, meta as proofMeta } from "./proof";
import Recovery, {
  loader as recoveryLoader,
  meta as recoveryMeta,
} from "./recovery";
import Reviews, {
  loader as reviewsLoader,
  meta as reviewsMeta,
} from "./reviews";
import Settings, {
  SETTINGS_SECTIONS,
  loader as settingsLoader,
  meta as settingsMeta,
} from "./settings";
import Today, { loader as todayLoader, meta as todayMeta } from "./today";

// biome-ignore lint/suspicious/noExplicitAny: route component/loader prop types are per-route; the table erases them on purpose
type AnyComponent = (props: any) => React.ReactNode;

// /signals graduated to a data-backed loader in #88 — its rendering is
// covered by signals.route.test.tsx, not this static table.
const EMPTY_STATE_ROUTES: Array<{
  key: Exclude<keyof typeof SURFACES, "signals" | "settings">;
  Component: AnyComponent;
  loader: () => unknown;
  meta: () => Array<{ title: string }>;
}> = [
  { key: "today", Component: Today, loader: todayLoader, meta: todayMeta },
  {
    key: "reviews",
    Component: Reviews,
    loader: reviewsLoader,
    meta: reviewsMeta,
  },
  {
    key: "recovery",
    Component: Recovery,
    loader: recoveryLoader,
    meta: recoveryMeta,
  },
  { key: "proof", Component: Proof, loader: proofLoader, meta: proofMeta },
  {
    key: "coverage",
    Component: Coverage,
    loader: coverageLoader,
    meta: coverageMeta,
  },
  {
    key: "insights",
    Component: Insights,
    loader: insightsLoader,
    meta: insightsMeta,
  },
  {
    key: "presence",
    Component: Presence,
    loader: presenceLoader,
    meta: presenceMeta,
  },
];

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#x27;");
}

describe.each(EMPTY_STATE_ROUTES)("$key route", ({
  key,
  Component,
  loader,
  meta,
}) => {
  const surface = SURFACES[key];

  it("loader returns the surface's static meta", () => {
    expect(loader()).toMatchObject({ surface });
  });

  it("renders the page header and the exact empty-state copy", () => {
    if (!surface.empty) {
      throw new Error("empty-state route without empty-state copy");
    }
    const html = renderToString(<Component loaderData={loader()} />);
    expect(html).toContain('data-testid="page-header"');
    expect(html).toContain(escapeHtml(surface.title));
    expect(html).toContain(escapeHtml(surface.description));
    expect(html).toContain('data-testid="empty-state"');
    expect(html).toContain(escapeHtml(surface.empty.heading));
    expect(html).toContain(escapeHtml(surface.empty.body));
  });

  it("titles the tab '<Surface> · Well Regarded'", () => {
    expect(meta()).toContainEqual({ title: surfaceTitle(surface) });
  });
});

describe("empty-state actions", () => {
  it.each([
    { key: "presence", label: "Connect Google" },
  ] as const)("$key renders '$label' disabled with a coming-soon tooltip", ({
    key,
    label,
  }) => {
    const { Component, loader } = EMPTY_STATE_ROUTES.find(
      (route) => route.key === key,
    ) as (typeof EMPTY_STATE_ROUTES)[number];
    const html = renderToString(<Component loaderData={loader()} />);
    expect(html).toContain(label);
    expect(html).toContain("disabled");
    expect(html).toContain('title="Coming soon"');
  });

  it("all other surfaces have no action", () => {
    for (const { key, Component, loader } of EMPTY_STATE_ROUTES) {
      if (key === "presence") {
        continue;
      }
      const html = renderToString(<Component loaderData={loader()} />);
      expect(html).not.toContain("<button");
    }
  });
});

describe("today's overline", () => {
  it("is the formatted date, per the mockup", () => {
    expect(todayOverline(new Date("2026-07-08T12:00:00Z"))).toBe(
      "Wednesday, July 8",
    );
    const data = todayLoader();
    const TodayAny = Today as AnyComponent;
    const html = renderToString(<TodayAny loaderData={data} />);
    expect(html).toContain(data.overline);
  });
});

describe("settings route", () => {
  it("renders the section list instead of an empty state", () => {
    const SettingsAny = Settings as AnyComponent;
    const Stub = createRoutesStub([
      {
        path: "/settings",
        Component: () => <SettingsAny loaderData={settingsLoader()} />,
      },
    ]);
    const html = renderToString(<Stub initialEntries={["/settings"]} />);
    expect(html).not.toContain('data-testid="empty-state"');
    for (const section of SETTINGS_SECTIONS) {
      expect(html).toContain(escapeHtml(section.title));
      expect(html).toContain(escapeHtml(section.description));
    }
    // Practice profile and Imports (#133) are live; the other five are
    // placeholders.
    expect(html).toContain('href="/settings/practice"');
    expect(html).toContain('href="/settings/imports"');
    expect((html.match(/Coming soon/g) ?? []).length).toBe(5);
    expect(settingsMeta()).toContainEqual({
      title: "Settings · Well Regarded",
    });
  });
});

describe("index and catch-all", () => {
  it("/ redirects to /today", () => {
    const response = homeLoader();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/today");
  });

  it("unmatched paths throw a 404 for the root boundary", () => {
    try {
      notFoundLoader();
      throw new Error("expected the loader to throw");
    } catch (thrown) {
      expect(thrown).toMatchObject({ init: { status: 404 } });
    }
  });
});
