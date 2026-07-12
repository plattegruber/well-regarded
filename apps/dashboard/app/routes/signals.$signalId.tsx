// Signal detail (#90): what is this, how do we know, and what can we do
// about it — for any signal, not just reviews. The page's two invariants:
// every derived fact shows provenance and confidence (the shared
// BasisBadge), and publishability is stated strictly in terms of recorded
// consent (the ConsentPanel). Sections render conditionally — a manual
// private note has no source link and no excerpts, and the page should
// feel complete, not full of empty sections.
import {
  CONSENT_CHANNEL_LABELS,
  can,
  DERIVATION_DIMENSIONS,
  describeConsentState,
  SUSPECTED_DUPLICATE_RESOLUTIONS,
} from "@wellregarded/core";
import { getSignalDetail, resolveSuspectedDuplicate } from "@wellregarded/db";
import { data, Link, redirect } from "react-router";
import { z } from "zod";

import { Overline, PageHeader } from "~/components/shell/page-header";
import { BasisBadge } from "~/components/signals/basis-badge";
import {
  ConsentPanel,
  type ConsentPanelData,
} from "~/components/signals/consent-panel";
import {
  type DuplicateCardData,
  type DuplicatePreview,
  DuplicateResolveCard,
} from "~/components/signals/duplicate-resolve-card";
import {
  ATTRIBUTION_LABELS,
  CONSENT_SOURCE_LABELS,
  DIMENSION_LABELS,
  formatDate,
  judgmentValueLabel,
  SOURCE_KIND_LABELS,
  SOURCE_KIND_TITLES,
} from "~/components/signals/labels";
import { VisibilityBadge } from "~/components/signals/visibility-badge";
import { Card } from "~/components/ui/card";
import { RatingStars } from "~/components/ui/rating-stars";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import { parseForm } from "~/lib/forms.server";
import { requirePracticeContext } from "~/lib/practice-context.server";
import type { Route } from "./+types/signals.$signalId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meta({ data: loaderData }: Route.MetaArgs) {
  return [
    {
      title: `${loaderData?.title ?? "Signal"} · Well Regarded`,
    },
  ];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  if (!UUID_RE.test(params.signalId)) {
    throw data(null, { status: 404 });
  }
  return withRequestDb(context, async (db) => {
    // TODO(#59): requirePracticeContext is the auth seam — see its module doc.
    const ctx = await requirePracticeContext(db);
    const detail = await getSignalDetail(db, {
      practiceId: ctx.practiceId,
      signalId: params.signalId,
      viewer: ctx.viewer,
      actor: ctx.auditActor,
    });
    // Missing, cross-practice, and not-permitted all read the same: 404.
    if (!detail) {
      throw data(null, { status: 404 });
    }

    const { signal } = detail;
    const now = new Date();
    const consentState = describeConsentState(detail.consents, now);
    const consent: ConsentPanelData = {
      publishable: consentState.publishable,
      status: consentState.status,
      summary: consentState.summary,
      details: consentState.consent
        ? {
            channels: consentState.consent.channels.map(
              (channel) => CONSENT_CHANNEL_LABELS[channel],
            ),
            attribution: ATTRIBUTION_LABELS[consentState.consent.attribution],
            source: CONSENT_SOURCE_LABELS[consentState.consent.source],
            grantedOn: formatDate(consentState.consent.grantedAt),
            expiresOn: consentState.consent.expiresAt
              ? formatDate(consentState.consent.expiresAt)
              : null,
            revokedOn: consentState.consent.revokedAt
              ? formatDate(consentState.consent.revokedAt)
              : null,
            version: consentState.consent.consentVersion,
            allowMinorEdits: consentState.consent.allowMinorEdits,
          }
        : null,
    };

    const sourceLabel = SOURCE_KIND_LABELS[signal.sourceKind];
    const currentPreview: DuplicatePreview = {
      sourceLabel,
      occurredOn: formatDate(signal.occurredAt),
      text: detail.currentText,
      rating:
        detail.currentRating === null ? null : Number(detail.currentRating),
    };

    return {
      title: SOURCE_KIND_TITLES[signal.sourceKind],
      overline: `Trust signal · ${sourceLabel}`,
      visibility: signal.visibility,
      occurredOn: formatDate(signal.occurredAt),
      locationName: detail.locationName,
      providerName: detail.providerName,
      patientLabel:
        detail.patient === null
          ? null
          : detail.patient.redacted
            ? "Patient (hidden)"
            : (detail.patient.displayName ?? "Patient (unnamed)"),
      patientRedacted: detail.patient?.redacted ?? false,
      original: {
        text: signal.originalText,
        rating:
          signal.originalRating === null ? null : Number(signal.originalRating),
      },
      edited: signal.currentVersionId !== null,
      current: currentPreview,
      versions: detail.versions.map((version) => ({
        id: version.id,
        text: version.content,
        rating: version.rating === null ? null : Number(version.rating),
        recordedOn: formatDate(version.createdAt),
      })),
      provenance: {
        sourceLabel,
        sourceUrl: signal.sourceUrl,
        sourceId: signal.sourceId,
        occurredOn: formatDate(signal.occurredAt),
        ingestedOn: formatDate(signal.createdAt),
        rawArtifactKey: signal.rawArtifactKey,
        deletedAtSource: signal.availability === "deleted_at_source",
        importRun: detail.importRun
          ? {
              id: detail.importRun.run.id,
              sourceLabel: SOURCE_KIND_LABELS[detail.importRun.run.sourceKind],
              ranOn: formatDate(detail.importRun.run.startedAt),
              trigger: detail.importRun.run.trigger,
              created: detail.importRun.run.created,
              totalProcessed: detail.importRun.totalProcessed,
              artifactKeys: detail.importRun.run.rawArtifactKeys,
            }
          : null,
      },
      derivations: DERIVATION_DIMENSIONS.map((dimension) => {
        const row = detail.currentDerivations[dimension];
        return {
          dimension,
          label: DIMENSION_LABELS[dimension],
          value: row ? judgmentValueLabel(String(row.value)) : null,
          basis: row?.basis ?? null,
          confidence: row?.confidence ?? null,
          rationale: row?.rationale ?? null,
          judgedOn: row ? formatDate(row.createdAt) : null,
        };
      }),
      consent,
      excerpts: detail.excerpts.map((excerpt) => ({
        id: excerpt.id,
        text: excerpt.excerptText,
        topicHint: excerpt.topicHint,
        topics: excerpt.topics ?? [],
      })),
      duplicates: detail.duplicates.map(
        (duplicate): DuplicateCardData => ({
          id: duplicate.link.id,
          similarityLabel: `${Math.round(duplicate.link.similarity * 100)}% text similarity`,
          other: {
            signalId: duplicate.other.id,
            sourceLabel: SOURCE_KIND_LABELS[duplicate.other.sourceKind],
            occurredOn: formatDate(duplicate.other.occurredAt),
            text: duplicate.other.text,
            rating:
              duplicate.other.rating === null
                ? null
                : Number(duplicate.other.rating),
          },
        }),
      ),
      canResolveDuplicates: can(ctx.actor, "resolve_duplicates", {
        practiceId: ctx.practiceId,
      }),
    };
  });
}

const resolveDuplicateSchema = z.object({
  intent: z.literal("resolve-duplicate"),
  duplicateId: z.string().uuid(),
  resolution: z.enum(SUSPECTED_DUPLICATE_RESOLUTIONS),
});

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!UUID_RE.test(params.signalId)) {
    throw data(null, { status: 404 });
  }
  return withRequestDb(context, async (db) => {
    // 1. Permission check — in the action, always (the hidden affordance is
    //    not a security boundary). TODO(#59): real actor via the auth seam.
    const ctx = await requirePracticeContext(db);
    if (!can(ctx.actor, "resolve_duplicates", { practiceId: ctx.practiceId })) {
      throw data(null, { status: 403 });
    }

    // 2. Parse — validation failures are returned, never thrown.
    const parsed = await parseForm(resolveDuplicateSchema, request);
    if (!parsed.ok) {
      return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
    }

    // 3. Mutate + audit in one transaction (resolveSuspectedDuplicate owns
    //    both). `undefined` means the link was already resolved — a stale
    //    double-click, not an error.
    const resolved = await resolveSuspectedDuplicate(db, {
      practiceId: ctx.practiceId,
      duplicateId: parsed.data.duplicateId,
      resolution: parsed.data.resolution,
      actor: ctx.auditActor,
    });

    // 4 + 5. Flash, then redirect back to the detail page.
    const message = !resolved
      ? "This duplicate was already resolved"
      : parsed.data.resolution === "same"
        ? "Marked as the same event — both records kept"
        : "Marked as different signals";
    return redirect(`/signals/${params.signalId}`, {
      headers: await setFlash(context.cloudflare.env, {
        tone: resolved ? "positive" : "neutral",
        message,
      }),
    });
  });
}

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Overline>{label}</Overline>
      <span className="min-w-0 break-all text-right font-mono text-data text-ink-800">
        {children}
      </span>
    </div>
  );
}

export default function SignalDetail({ loaderData }: Route.ComponentProps) {
  const d = loaderData;
  const subtitle = [d.occurredOn, d.locationName, d.providerName]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Link
        to="/signals"
        className="mb-4 inline-block font-mono text-label font-medium uppercase tracking-label text-link"
      >
        ← All signals
      </Link>
      <PageHeader
        overline={d.overline}
        title={d.title}
        description={subtitle}
        action={<VisibilityBadge visibility={d.visibility} />}
      />

      <div className="grid items-start gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-5">
          {/* Original text — immutable, rendered verbatim. */}
          <Card title="Original text">
            <div className="flex flex-col gap-3">
              {d.original.rating !== null && (
                <RatingStars rating={d.original.rating} size={14} showValue />
              )}
              <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
                {d.original.text ?? "No text recorded."}
              </p>
              {d.edited && (
                <p className="m-0 border-t border-hairline pt-3 text-small text-gray-600">
                  Edited at the source since capture. The words above are as
                  first recorded; the latest version is below.
                </p>
              )}
            </div>
          </Card>

          {d.versions.length > 0 && (
            <Card title="Versions">
              <div className="flex flex-col gap-4">
                {d.versions.map((version, index) => (
                  <div
                    key={version.id}
                    className={
                      index > 0 ? "border-t border-hairline pt-4" : undefined
                    }
                  >
                    <Overline className="mb-2">
                      {index === 0
                        ? `Current · recorded ${version.recordedOn}`
                        : `Recorded ${version.recordedOn}`}
                    </Overline>
                    <p className="m-0 whitespace-pre-wrap font-mono text-quote text-ink-800">
                      {version.text ?? "Rating-only edit."}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {d.excerpts.length > 0 && (
            <Card title="Excerpts">
              <p className="mt-0 mb-4 text-small text-gray-600">
                Extracted for search and proof — derived from the original,
                never authored.
              </p>
              <div className="flex flex-col gap-4">
                {d.excerpts.map((excerpt, index) => (
                  <div
                    key={excerpt.id}
                    className={
                      index > 0 ? "border-t border-hairline pt-4" : undefined
                    }
                  >
                    <p className="m-0 mb-2 font-mono text-quote text-ink-800">
                      “{excerpt.text}”
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {excerpt.topicHint && (
                        <span className="inline-flex border border-dashed border-gray-300 px-2 py-1.25 font-mono text-label font-medium leading-none text-gray-600">
                          {excerpt.topicHint}
                        </span>
                      )}
                      {excerpt.topics.map((topic) => (
                        <span
                          key={topic}
                          className="inline-flex bg-gray-100 px-2 py-1.25 font-mono text-label font-medium leading-none text-gray-600"
                        >
                          {topic}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Derivations — every judgment shows its provenance. */}
          <Card title="Derivations" data-testid="derivations-panel">
            <div className="flex flex-col gap-3.5">
              {d.derivations.map((row) => (
                <div
                  key={row.dimension}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
                >
                  <Overline className="w-44">{row.label}</Overline>
                  {row.value === null ? (
                    <span className="font-mono text-data text-gray-500">
                      Not yet classified
                    </span>
                  ) : (
                    <>
                      <span className="font-mono text-data font-medium text-ink-900">
                        {row.value}
                      </span>
                      {row.basis !== null && row.confidence !== null && (
                        <BasisBadge
                          basis={row.basis}
                          confidence={row.confidence}
                        />
                      )}
                    </>
                  )}
                  {row.rationale && (
                    <p className="m-0 w-full text-small text-gray-500">
                      {row.rationale}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {d.duplicates.map((duplicate) => (
            <DuplicateResolveCard
              key={duplicate.id}
              duplicate={duplicate}
              current={d.current}
              canResolve={d.canResolveDuplicates}
            />
          ))}
        </div>

        <div className="flex flex-col gap-5">
          <ConsentPanel consent={d.consent} />

          {d.patientLabel && (
            <Card title="Patient" data-testid="patient-panel">
              <p className="m-0 font-mono text-data text-ink-800">
                {d.patientLabel}
              </p>
              <p className="mt-2.5 mb-0 text-small text-gray-500">
                {d.patientRedacted
                  ? "Identity requires the view-patient-identity permission."
                  : "Access to patient identity is recorded."}
              </p>
            </Card>
          )}

          <Card data-testid="provenance-panel" padding="0">
            {/* Collapsible, open by default: provenance is the point. */}
            <details open>
              <summary className="cursor-pointer list-none p-5 text-title font-semibold text-ink-900">
                Provenance
              </summary>
              <div className="flex flex-col gap-2 px-5 pb-5">
                <MetaRow label="Source">{d.provenance.sourceLabel}</MetaRow>
                {d.provenance.sourceUrl && (
                  <MetaRow label="Original">
                    <a
                      href={d.provenance.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link"
                    >
                      View at source
                    </a>
                  </MetaRow>
                )}
                {d.provenance.sourceId && (
                  <MetaRow label="Source id">{d.provenance.sourceId}</MetaRow>
                )}
                <MetaRow label="Occurred">{d.provenance.occurredOn}</MetaRow>
                <MetaRow label="Ingested">{d.provenance.ingestedOn}</MetaRow>
                {d.provenance.rawArtifactKey && (
                  <MetaRow label="Raw artifact">
                    {d.provenance.rawArtifactKey}
                  </MetaRow>
                )}
                {d.provenance.importRun && (
                  <>
                    {/* TODO(Epic #8): link to the import-run detail page
                        once it exists; until then the run is summarized
                        inline. */}
                    <MetaRow label="Import run">
                      {`${d.provenance.importRun.sourceLabel} · ${d.provenance.importRun.ranOn}`}
                    </MetaRow>
                    <MetaRow label="Run outcome">
                      {`${d.provenance.importRun.created} created of ${d.provenance.importRun.totalProcessed} processed`}
                    </MetaRow>
                  </>
                )}
                {d.provenance.deletedAtSource && (
                  <p className="mt-1.5 mb-0 border-t border-hairline pt-3 text-small text-gray-600">
                    Deleted at the source — preserved here as originally
                    captured.
                  </p>
                )}
              </div>
            </details>
          </Card>
        </div>
      </div>
    </>
  );
}
