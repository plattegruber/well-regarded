import { describe, expect, it } from "vitest";

import { CONSENT_CHANNELS } from "./consent/index.js";
import {
  consentChannelForPlacement,
  PLACEMENT_CHANNELS,
  PLACEMENT_DEACTIVATION_CONSENT_REVOKED,
} from "./proof.js";

describe("placement → consent channel mapping", () => {
  it("maps every placement channel to a real consent channel", () => {
    for (const channel of PLACEMENT_CHANNELS) {
      expect(CONSENT_CHANNELS).toContain(consentChannelForPlacement(channel));
    }
  });

  it("gbp_post placements are governed by the gbp consent grant", () => {
    expect(consentChannelForPlacement("gbp_post")).toBe("gbp");
    // Everything else maps by name.
    expect(consentChannelForPlacement("website")).toBe("website");
    expect(consentChannelForPlacement("email")).toBe("email");
    expect(consentChannelForPlacement("in_office")).toBe("in_office");
  });
});

describe("consent-revoked deactivation reason", () => {
  it("is the machine-written value issue #91 records", () => {
    expect(PLACEMENT_DEACTIVATION_CONSENT_REVOKED).toBe("consent_revoked");
  });
});
