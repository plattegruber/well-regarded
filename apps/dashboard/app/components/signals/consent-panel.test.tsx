// The consent panel (#90): publishability stated strictly in terms of
// recorded consent — the no-rows case renders the exact honest default.
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConsentPanel, consentToneClass } from "./consent-panel";

describe("ConsentPanel", () => {
  it("renders the exact honest default when nothing is recorded", () => {
    const html = renderToString(
      <ConsentPanel
        consent={{
          publishable: false,
          status: "none",
          summary: "No consent recorded — not publishable",
          details: null,
        }}
      />,
    );
    expect(html).toContain("No consent recorded — not publishable");
    expect(html).toContain("text-gray-500");
    // No details grid renders for a state that has no consent row.
    expect(html).not.toContain("Attribution");
  });

  it("renders a grant with channels, attribution, source, and date", () => {
    const html = renderToString(
      <ConsentPanel
        consent={{
          publishable: true,
          status: "granted",
          summary: "Website + In office permission granted",
          details: {
            channels: ["Website", "In office"],
            attribution: "First name",
            source: "Practice attested",
            grantedOn: "March 2, 2026",
            expiresOn: null,
            revokedOn: null,
            version: 1,
            allowMinorEdits: false,
          },
        }}
      />,
    );
    expect(html).toContain("Website + In office permission granted");
    expect(html).toContain("text-accent-700");
    expect(html).toContain("First name");
    expect(html).toContain("Practice attested");
    expect(html).toContain("March 2, 2026");
    expect(html).toContain("Not allowed");
    expect(html).toContain("v1");
  });

  it("states a revocation with its reason and date", () => {
    const html = renderToString(
      <ConsentPanel
        consent={{
          publishable: false,
          status: "revoked",
          summary: "Consent revoked — not publishable",
          details: {
            channels: ["Website"],
            attribution: "Initials",
            source: "Patient link",
            grantedOn: "January 10, 2026",
            expiresOn: null,
            revokedOn: "April 2, 2026",
            version: 2,
            allowMinorEdits: true,
          },
        }}
      />,
    );
    expect(html).toContain("Consent revoked — not publishable");
    expect(html).toContain("text-red-700");
    expect(html).toContain("April 2, 2026");
  });
});

describe("consentToneClass", () => {
  it("maps the mockup's color coding", () => {
    expect(consentToneClass("granted")).toBe("text-accent-700");
    expect(consentToneClass("none")).toBe("text-gray-500");
    expect(consentToneClass("revoked")).toBe("text-red-700");
    expect(consentToneClass("expired")).toBe("text-red-700");
  });
});
