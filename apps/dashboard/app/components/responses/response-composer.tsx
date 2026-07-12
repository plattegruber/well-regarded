// ResponseComposer (#79, with the #83 template picker): the drafting
// surface for one public review, mounted in the review detail's
// `ResponseThreadSlot` composer seam whenever the latest response is a
// draft (or none exists). It EXTENDS the #80/#217 workflow rather than
// forking it: every mutation posts to the same responses action route
// (`/reviews/:signalId/responses`), drafts persist as `responses` rows in
// `draft` status, and submit-for-approval is the same state-machine edge
// the workflow panel used — now with the compose-side safety gate in
// front of it.
//
// Two-tier live safety (#79 requirement 4):
// - Layer 1 (`deterministicSafetyChecks`) runs CLIENT-SIDE on every
//   keystroke — pure, synchronous, free. Findings highlight instantly.
// - The full `checkResponseSafety` (Haiku layer included) runs server-side
//   via the `safety-check` intent, debounced after edits pause, and
//   immediately after an AI draft lands (the draft action returns its own
//   verdict in the same round trip).
// - Staleness: server results carry `checkedHash`; a result computed
//   against text the user has since edited is discarded whole (see
//   ~/lib/safety-spans.ts) — the deterministic layer covers the gap until
//   the next debounce fires.
//
// Block semantics (#79 requirement 5): any block finding disables submit
// and renders the explanation panel. There is no override here — blocks
// are edited away, not waived. Warn-level findings require the explicit
// acknowledgment checkbox (the same acknowledgment the approve side
// demands, surfaced early). The server re-checks on submit regardless:
// the disabled button is not the enforcement.

import { deterministicSafetyChecks } from "@wellregarded/ai/safety";
import { GBP_REPLY_MAX_BYTES, utf8ByteLength } from "@wellregarded/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { SubmitButton } from "~/components/form/submit-button";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import {
  type ComposerSafetyFinding,
  type ComposerSafetyResult,
  isFreshResult,
} from "~/lib/safety-spans";
import { insertTemplateBody } from "~/lib/template-insert";
import { cn } from "~/lib/utils";

import { SafetyFindingsList } from "./safety-findings";
import { SafetyHighlightField } from "./safety-highlight-field";

/** Character count where the composer starts nudging toward brevity —
 * the drafting prompt's own target (RESPONSE_DRAFT_MAX_CHARS). */
const BREVITY_CHAR_TARGET = 700;

export interface ComposerTemplateView {
  id: string;
  name: string;
  tone: string;
  body: string;
}

export interface ComposerDraftView {
  id: string;
  body: string;
  rejectionComment: string | null;
}

/** What the action returns to each composer fetcher (see the route). */
interface DraftWithAiData {
  draft?: string;
  safety?: ComposerSafetyResult;
  aiUnavailable?: string;
}
interface SafetyCheckData {
  safety?: ComposerSafetyResult;
}
interface SaveDraftData {
  saved?: { responseId: string; body: string };
  fieldErrors?: Record<string, string[]>;
}
interface SubmitData {
  safety?: ComposerSafetyResult;
  /** A bounced submit still persisted the draft — adopt the row id. */
  saved?: { responseId: string; body: string };
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

export interface ResponseComposerProps {
  /** The responses action route: `/reviews/:signalId/responses`. */
  action: string;
  /** The latest draft row, when one exists — the composer restores it. */
  draft: ComposerDraftView | null;
  /** Active templates for the picker (#83). */
  templates: ComposerTemplateView[];
  /** The review's display name for `{reviewer_name}`; null = anonymous. */
  reviewerName: string | null;
  practiceName: string;
  /** Debounce for the full server-side safety check (ms). */
  debounceMs?: number;
  /** Debounce for autosave (ms). */
  autosaveMs?: number;
}

export function ResponseComposer({
  action,
  draft,
  templates,
  reviewerName,
  practiceName,
  debounceMs = 800,
  autosaveMs = 2500,
}: ResponseComposerProps) {
  const [body, setBody] = useState(draft?.body ?? "");
  const [responseId, setResponseId] = useState(draft?.id ?? null);
  const [aiNote, setAiNote] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingTemplate, setPendingTemplate] =
    useState<ComposerTemplateView | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const savedBodyRef = useRef(draft?.body ?? "");
  const findingsId = useId();

  const aiFetcher = useFetcher<DraftWithAiData>();
  const checkFetcher = useFetcher<SafetyCheckData>();
  const saveFetcher = useFetcher<SaveDraftData>();
  const submitFetcher = useFetcher<SubmitData>();

  // --- Layer 1, per keystroke (client-side, synchronous) -------------------
  const clientFindings = useMemo<ComposerSafetyFinding[]>(
    () =>
      deterministicSafetyChecks(body).map((finding) => ({
        span: finding.span,
        code: finding.code,
        reason: finding.reason,
        suggestion: finding.suggestion,
        level: finding.level,
      })),
    [body],
  );

  // --- The freshest full verdict, if any (staleness by checkedHash) --------
  const serverResult = [
    submitFetcher.data?.safety,
    checkFetcher.data?.safety,
    aiFetcher.data?.safety,
  ].find((candidate) => isFreshResult(candidate, body));

  const findings = serverResult ? serverResult.findings : clientFindings;
  const hasBlock = findings.some((finding) => finding.level === "block");
  const hasWarn = findings.some((finding) => finding.level === "warn");
  const degraded = findings.some(
    (finding) => finding.code === "ai_check_skipped",
  );

  // --- Debounced full check -------------------------------------------------
  const checkSubmit = checkFetcher.submit;
  useEffect(() => {
    if (body.trim() === "") return;
    const timer = setTimeout(() => {
      void checkSubmit(
        { intent: "safety-check", body },
        { method: "post", action },
      );
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [body, debounceMs, action, checkSubmit]);

  // --- Autosave (draft rows persist through the state machine, #79 req 7) --
  const saveSubmit = saveFetcher.submit;
  useEffect(() => {
    if (body.trim() === "" || body === savedBodyRef.current) return;
    const timer = setTimeout(() => {
      void saveSubmit(
        {
          intent: "save-draft",
          body,
          ...(responseId ? { responseId } : {}),
        },
        { method: "post", action },
      );
    }, autosaveMs);
    return () => clearTimeout(timer);
  }, [body, autosaveMs, action, responseId, saveSubmit]);

  // Adopt the created/updated row so autosave never duplicates (#79 tests).
  useEffect(() => {
    const saved = saveFetcher.data?.saved;
    if (!saved) return;
    savedBodyRef.current = saved.body;
    setResponseId(saved.responseId);
  }, [saveFetcher.data]);

  // A bounced submit persisted the draft too (the action saves before it
  // checks) — adopt that row as well, or the next submit would duplicate.
  useEffect(() => {
    const saved = submitFetcher.data?.saved;
    if (!saved) return;
    savedBodyRef.current = saved.body;
    setResponseId(saved.responseId);
  }, [submitFetcher.data]);

  // An AI draft populates the textarea as an EDITABLE draft — never
  // auto-submitted (#79 requirement 3). Its safety verdict rode along.
  useEffect(() => {
    const drafted = aiFetcher.data?.draft;
    if (drafted === undefined) return;
    setBody(drafted);
    setAiNote(true);
    setAcknowledged(false);
  }, [aiFetcher.data]);

  const edit = (next: string) => {
    setBody(next);
    setAiNote(false);
    setAcknowledged(false);
  };

  const applyTemplate = (template: ComposerTemplateView) => {
    const inserted = insertTemplateBody(template.body, {
      reviewerName,
      practiceName,
    });
    setBody(inserted.text);
    setAiNote(false);
    setAcknowledged(false);
    setPendingTemplate(null);
    // Place the caret where the reviewer's name would go (anonymous case).
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  };

  const requestInsert = () => {
    const template = templates.find((item) => item.id === selectedTemplateId);
    if (!template) return;
    if (body.trim() !== "") {
      // Overwrite needs an explicit yes (#83 requirement 4) — inline, calm.
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  };

  const bytes = utf8ByteLength(body);
  const chars = body.length;
  const overByteLimit = bytes > GBP_REPLY_MAX_BYTES;
  const aiPending = aiFetcher.state !== "idle";
  const submitPending = submitFetcher.state !== "idle";
  const canSubmit =
    !hasBlock &&
    !overByteLimit &&
    body.trim() !== "" &&
    (!hasWarn || acknowledged);

  return (
    <div
      className="flex flex-col gap-3 border-t border-hairline pt-4"
      data-testid="response-composer"
    >
      <p className="m-0 font-mono text-label font-medium uppercase tracking-label text-gray-600">
        Draft a reply
      </p>

      {draft?.rejectionComment && (
        <p
          className="m-0 border-l-2 border-status-caution py-1 pl-3 text-small text-gray-600"
          data-testid="rejection-comment"
        >
          Changes requested: {draft.rejectionComment}
        </p>
      )}

      {/* Toolbar: Draft with AI + the template picker (#83). */}
      <div className="flex flex-wrap items-end gap-3">
        <aiFetcher.Form method="post" action={action}>
          <input type="hidden" name="intent" value="draft-with-ai" />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={aiPending}
            data-testid="draft-with-ai"
          >
            {aiPending ? "Drafting…" : "Draft with AI"}
          </Button>
        </aiFetcher.Form>

        {templates.length > 0 && (
          <div className="flex items-end gap-2">
            <Select
              label="Template"
              value={selectedTemplateId}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
              data-testid="template-picker"
              options={[
                { value: "", label: "Choose a template" },
                ...templates.map((template) => ({
                  value: template.id,
                  label: `${template.name} · ${template.tone}`,
                })),
              ]}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={selectedTemplateId === ""}
              onClick={requestInsert}
              data-testid="insert-template"
            >
              Insert
            </Button>
          </div>
        )}
      </div>

      {pendingTemplate && (
        <div
          className="flex flex-wrap items-center gap-3 border border-hairline bg-surface-sunken p-3"
          data-testid="overwrite-confirm"
        >
          <p className="m-0 text-small text-ink-800">
            Replace the current draft with “{pendingTemplate.name}”?
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => applyTemplate(pendingTemplate)}
            data-testid="overwrite-confirm-yes"
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPendingTemplate(null)}
          >
            Keep my draft
          </Button>
        </div>
      )}

      {aiFetcher.data?.aiUnavailable && (
        <p
          className="m-0 text-small text-gray-600"
          data-testid="ai-unavailable"
        >
          {aiFetcher.data.aiUnavailable}
        </p>
      )}

      <SafetyHighlightField
        label="Public reply"
        value={body}
        onChange={edit}
        findings={findings}
        describedBy={findings.length > 0 ? findingsId : undefined}
        textareaRef={textareaRef}
        rows={5}
        placeholder="Write the reply patients and prospects will see."
      />

      {aiNote && (
        <p className="m-0 text-small text-gray-500" data-testid="ai-note">
          AI draft — review before sending.
        </p>
      )}

      {/* Tone hint (static guidance) + character/byte count (#79 req 6). */}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="m-0 text-small text-gray-500">
          Keep it brief. Don't confirm they were a patient.
        </p>
        <p
          className={cn(
            "m-0 font-mono text-label",
            overByteLimit
              ? "text-status-negative"
              : chars > BREVITY_CHAR_TARGET
                ? "text-status-caution"
                : "text-gray-500",
          )}
          data-testid="char-count"
        >
          {chars} characters
          {chars > BREVITY_CHAR_TARGET &&
            !overByteLimit &&
            " — shorter reads better"}
          {" · "}
          {bytes}/{GBP_REPLY_MAX_BYTES} bytes
        </p>
      </div>
      {overByteLimit && (
        <p className="m-0 text-small text-status-negative">
          Google caps replies at {GBP_REPLY_MAX_BYTES} bytes — trim the reply to
          submit it.
        </p>
      )}

      {degraded && (
        <p
          className="m-0 border-l-2 border-gray-300 py-1 pl-3 text-small text-gray-600"
          data-testid="degraded-notice"
        >
          Automated check unavailable — deterministic checks only. Subtle
          problems (confirming a care relationship, tone) were not checked.
        </p>
      )}

      {hasBlock && (
        <div data-testid="block-explanation">
          <p className="m-0 mb-2 text-small font-medium text-status-negative">
            This draft can't be submitted — the safety check found blocking
            issues:
          </p>
        </div>
      )}
      <SafetyFindingsList
        id={findingsId}
        findings={findings.filter(
          (finding) => finding.code !== "ai_check_skipped",
        )}
      />

      {submitFetcher.data?.error && (
        <p className="m-0 text-small text-status-negative">
          {submitFetcher.data.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <saveFetcher.Form method="post" action={action}>
          <input type="hidden" name="intent" value="save-draft" />
          <input type="hidden" name="body" value={body} />
          {responseId && (
            <input type="hidden" name="responseId" value={responseId} />
          )}
          <SubmitButton
            fetcher={saveFetcher}
            variant="secondary"
            size="sm"
            pendingLabel="Saving…"
            disabled={body.trim() === ""}
          >
            Save draft
          </SubmitButton>
        </saveFetcher.Form>

        <submitFetcher.Form
          method="post"
          action={action}
          className="flex flex-wrap items-center gap-3"
        >
          <input type="hidden" name="intent" value="submit-for-approval" />
          <input type="hidden" name="body" value={body} />
          {responseId && (
            <input type="hidden" name="responseId" value={responseId} />
          )}
          {hasWarn && !hasBlock && (
            <label className="flex items-start gap-2 text-small text-ink-800">
              <input
                type="checkbox"
                name="acknowledgeWarnings"
                value="yes"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5"
                data-testid="acknowledge-warnings"
              />
              I reviewed the warnings above and want to submit anyway.
            </label>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit || submitPending}
            data-testid="submit-for-approval"
          >
            {submitPending ? "Submitting…" : "Submit for approval"}
          </Button>
        </submitFetcher.Form>
      </div>
    </div>
  );
}
