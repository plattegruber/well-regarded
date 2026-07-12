/**
 * Recorded-shape manual-entry fixtures (issue #138) — exactly what
 * `getRawArtifact` returns for artifacts the submission endpoint stored.
 * Exported via `@wellregarded/sources/testing` for the adapter's own
 * contract run and the pipeline/API integration suites; never imported by
 * runtime code.
 */

import {
  buildManualEntryArtifact,
  type ManualEntryArtifact,
} from "./schema.js";

export const MANUAL_FIXTURE_PRACTICE_ID =
  "7d444840-9dc0-11d1-b245-5ffdce74fad2";

/** The minimal envelope: text + date + source description, nothing else. */
export const manualEntryMinimalArtifact: ManualEntryArtifact =
  buildManualEntryArtifact({
    practiceId: MANUAL_FIXTURE_PRACTICE_ID,
    sourceId: "a2f47b6e-3d2c-4f21-9a67-6d2f9c1e5b01",
    enteredBy: "b3c58c7f-4e3d-4a32-8b78-7e3f0d2f6c12",
    enteredAt: "2026-03-02T15:00:00Z",
    entry: {
      text: "Front desk fit me in the same day for a broken crown.",
      occurredAt: "2026-03-02T00:00:00Z",
      sourceDescription: "in person",
      consent: { choice: "unknown" },
    },
  });

/** The full envelope: patient + attested consent + provider/location hints. */
export const manualEntryFullArtifact: ManualEntryArtifact =
  buildManualEntryArtifact({
    practiceId: MANUAL_FIXTURE_PRACTICE_ID,
    sourceId: "c4d69d80-5f4e-4b43-9c89-8f4a1e3a7d23",
    enteredBy: "b3c58c7f-4e3d-4a32-8b78-7e3f0d2f6c12",
    enteredAt: "2026-03-03T09:30:00Z",
    entry: {
      text:
        "Dr. Patel was wonderful with my daughter — she actually looks " +
        "forward to the dentist now.",
      occurredAt: "2026-03-02T14:30:00Z",
      sourceDescription: "phone call",
      locationName: "Main Street office",
      providerName: "Dr. Patel",
      patient: {
        name: "Rosa Alvarez",
        email: "rosa.alvarez@example.com",
        phone: "+1 555 014 0021",
      },
      consent: {
        choice: "practice_attested",
        channels: ["website", "gbp"],
        note: "Said yes over the phone, 3/2, spoke with Dana.",
      },
    },
  });

/** The degenerate envelope the contract suite feeds the adapter. */
export const manualEntryEmptyArtifact: ManualEntryArtifact = {
  kind: "manual.entry",
  envelopeVersion: 1,
  practiceId: MANUAL_FIXTURE_PRACTICE_ID,
  sourceId: "d5e70e91-6a5f-4c54-8d90-9a5b2f4b8e34",
  enteredBy: "b3c58c7f-4e3d-4a32-8b78-7e3f0d2f6c12",
  enteredAt: "2026-03-04T10:00:00Z",
  entry: null,
};
