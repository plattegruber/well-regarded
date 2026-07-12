/**
 * Manual-entry adapter (issue #138): the shared contract suite over the
 * recorded-shape fixtures (minimal text-only + full patient/consent), plus
 * the source-specific mappings the suite doesn't cover.
 */

import { describe, expect, it } from "vitest";

import { describeAdapterContract } from "../testing.js";
import { manualEntryAdapter } from "./adapter.js";
import {
  manualEntryEmptyArtifact,
  manualEntryFullArtifact,
  manualEntryMinimalArtifact,
} from "./fixtures.js";
import { buildManualEntryArtifact } from "./schema.js";

describeAdapterContract(manualEntryAdapter, {
  valid: [
    {
      name: "minimal text-only entry",
      artifact: manualEntryMinimalArtifact,
      expectedCount: 1,
    },
    {
      name: "full entry (patient + attested consent + hints)",
      artifact: manualEntryFullArtifact,
      expectedCount: 1,
    },
  ],
  empty: manualEntryEmptyArtifact,
});

describe("manualEntryAdapter specifics", () => {
  it("pins visibility private and uses the embedded sourceId", async () => {
    const [signal] = await manualEntryAdapter.normalize(
      manualEntryMinimalArtifact,
    );
    expect(signal).toMatchObject({
      visibility: "private",
      sourceKind: "manual",
      sourceId: manualEntryMinimalArtifact.sourceId,
      originalText: manualEntryMinimalArtifact.entry?.text,
      rating: null,
      authorDisplayName: null,
      sourceUrl: null,
    });
  });

  it('maps "not asked" consent to imported_unknown with no detail', async () => {
    const [signal] = await manualEntryAdapter.normalize(
      manualEntryMinimalArtifact,
    );
    expect(signal?.consentHint).toBe("imported_unknown");
    expect(signal?.consentDetail).toBeUndefined();
    expect(signal?.patientHint).toBeUndefined();
  });

  it("maps an attestation to practice_attested with channels, note, and attester", async () => {
    const [signal] = await manualEntryAdapter.normalize(
      manualEntryFullArtifact,
    );
    expect(signal?.consentHint).toBe("practice_attested");
    expect(signal?.consentDetail).toEqual({
      channels: ["website", "gbp"],
      note: "Said yes over the phone, 3/2, spoke with Dana.",
      grantedBy: manualEntryFullArtifact.enteredBy,
      grantedAt: manualEntryFullArtifact.enteredAt,
    });
  });

  it("structured choices land as hints with basis manual; patient as patientHint", async () => {
    const [signal] = await manualEntryAdapter.normalize(
      manualEntryFullArtifact,
    );
    expect(signal?.providerHint).toEqual({
      text: "Dr. Patel",
      basis: "manual",
    });
    expect(signal?.locationHint).toEqual({
      text: "Main Street office",
      basis: "manual",
    });
    expect(signal?.patientHint).toEqual({
      name: "Rosa Alvarez",
      email: "rosa.alvarez@example.com",
      phone: "+1 555 014 0021",
    });
  });

  it("a malformed envelope throws (our bug, loud path)", async () => {
    await expect(
      manualEntryAdapter.normalize({ kind: "manual.entry" }),
    ).rejects.toThrow();
    await expect(
      manualEntryAdapter.normalize({
        ...manualEntryMinimalArtifact,
        unexpected: true,
      }),
    ).rejects.toThrow();
  });

  it("re-normalizing yields the identical signal (idempotent artifact)", async () => {
    const artifact = buildManualEntryArtifact({
      practiceId: manualEntryFullArtifact.practiceId,
      sourceId: manualEntryFullArtifact.sourceId,
      enteredBy: manualEntryFullArtifact.enteredBy,
      enteredAt: manualEntryFullArtifact.enteredAt,
      // biome-ignore lint/style/noNonNullAssertion: fixture has an entry
      entry: manualEntryFullArtifact.entry!,
    });
    const first = await manualEntryAdapter.normalize(artifact);
    const second = await manualEntryAdapter.normalize(artifact);
    expect(second).toEqual(first);
  });
});
