import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderTemplate,
  STARTER_RESPONSE_TEMPLATES,
  TEMPLATE_SAFETY_DUMMY_REVIEWER,
} from "@wellregarded/core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { AiRequestError } from "./errors.js";
import { FakeAiProvider } from "./fake.js";
import { SAFETY_PROMPT_NAME, type SafetyJudgment } from "./prompts/safety.js";
import type {
  AiProvider,
  AiResult,
  ClassifyOpts,
  ClassifyPrompt,
} from "./provider.js";
import {
  checkResponseSafety,
  deterministicSafetyChecks,
  quoteToSpan,
  SAFETY_PURPOSE,
} from "./safety.js";
import type {
  ReviewContext,
  SafetyFinding,
  SafetyLevel,
} from "./safety-types.js";

const review: ReviewContext = {
  text: "Terrible experience, would not recommend.",
  rating: "1.0",
  visibility: "public",
};

/** The matched draft text for one finding — span accuracy in one place. */
function spanText(draft: string, finding: SafetyFinding): string | null {
  return finding.span
    ? draft.slice(finding.span.start, finding.span.end)
    : null;
}

/** Deterministic findings for one rule only. */
function ruleFindings(draft: string, rule: string): SafetyFinding[] {
  return deterministicSafetyChecks(draft).filter((f) => f.rule === rule);
}

/** A provider whose classify always fails like a real outage. */
class DownProvider implements AiProvider {
  classify<T>(
    _prompt: ClassifyPrompt,
    _schema: z.ZodType<T>,
    _opts: ClassifyOpts,
  ): Promise<AiResult<T>> {
    return Promise.reject(
      new AiRequestError("api unreachable", { attempts: 3 }),
    );
  }
}

const emptyJudgment: SafetyJudgment = { findings: [] };

function fakeProvider(...judgments: SafetyJudgment[]): FakeAiProvider {
  return new FakeAiProvider({
    [SAFETY_PROMPT_NAME]: judgments.length > 0 ? judgments : [emptyJudgment],
  });
}

// ---------------------------------------------------------------------------
// Layer 1 — deterministic rules
// ---------------------------------------------------------------------------

describe("deterministicSafetyChecks: dates", () => {
  it("blocks month-name dates with exact spans", () => {
    const draft = "We're sorry your root canal on March 3rd was uncomfortable.";
    const dates = ruleFindings(draft, "deterministic:date");
    expect(dates).toHaveLength(1);
    expect(dates[0]?.level).toBe("block");
    expect(dates[0]?.code).toBe("appointment_detail");
    expect(spanText(draft, dates[0] as SafetyFinding)).toBe("March 3rd");
  });

  it("blocks numeric dates: 3/14, 03/14/2025, ISO", () => {
    for (const [draft, matched] of [
      ["You came in on 3/14 as scheduled.", "3/14"],
      ["The visit on 03/14/2025 went fine.", "03/14/2025"],
      ["Per our log entry 2025-03-14 you arrived late.", "2025-03-14"],
    ] as const) {
      const dates = ruleFindings(draft, "deterministic:date");
      expect(dates).toHaveLength(1);
      expect(dates[0]?.level).toBe("block");
      expect(spanText(draft, dates[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("blocks relative-day phrases: last Tuesday, yesterday's, Tuesday morning", () => {
    for (const [draft, matched] of [
      ["As we said last Tuesday, we're sorry.", "last Tuesday"],
      ["About yesterday's visit — we apologize.", "yesterday's"],
      ["Things were busy Tuesday morning here.", "Tuesday"],
    ] as const) {
      const dates = ruleFindings(draft, "deterministic:date");
      expect(dates.length).toBeGreaterThanOrEqual(1);
      expect(dates[0]?.level).toBe("block");
      expect(spanText(draft, dates[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("over-blocks a bare month name by design (cheap edit beats leaked date)", () => {
    const draft = "We're open until March.";
    const dates = ruleFindings(draft, "deterministic:date");
    expect(dates).toHaveLength(1);
    expect(spanText(draft, dates[0] as SafetyFinding)).toBe("March");
  });

  it('requires a number after "may" — the modal verb never blocks', () => {
    expect(
      ruleFindings("You may call us anytime.", "deterministic:date"),
    ).toEqual([]);
    const draft = "Your visit was May 3rd.";
    const dates = ruleFindings(draft, "deterministic:date");
    expect(dates).toHaveLength(1);
    expect(spanText(draft, dates[0] as SafetyFinding)).toBe("May 3rd");
  });

  it("does not block unqualified weekday ranges or 24/7", () => {
    expect(
      ruleFindings(
        "We're staffed Monday through Friday.",
        "deterministic:date",
      ),
    ).toEqual([]);
    expect(
      ruleFindings(
        "Our answering service is available 24/7.",
        "deterministic:date",
      ),
    ).toEqual([]);
  });
});

describe("deterministicSafetyChecks: times", () => {
  it("warns on clock times with exact spans", () => {
    for (const [draft, matched] of [
      ["We're open until 5pm most days.", "5pm"],
      ["The office closes at 4:30 pm sharp.", "4:30 pm"],
    ] as const) {
      const times = ruleFindings(draft, "deterministic:time");
      expect(times).toHaveLength(1);
      expect(times[0]?.level).toBe("warn");
      expect(times[0]?.code).toBe("appointment_detail");
      expect(spanText(draft, times[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("ignores bare numbers", () => {
    expect(
      ruleFindings("Thanks for the 5 stars!", "deterministic:time"),
    ).toEqual([]);
  });
});

describe("deterministicSafetyChecks: dollar amounts", () => {
  it("blocks $ amounts with exact spans", () => {
    for (const [draft, matched] of [
      ["Your bill was $450 because of the lab fee.", "$450"],
      ["The total came to $1,234.56 after adjustments.", "$1,234.56"],
    ] as const) {
      const dollars = ruleFindings(draft, "deterministic:dollar_amount");
      expect(dollars).toHaveLength(1);
      expect(dollars[0]?.level).toBe("block");
      expect(dollars[0]?.code).toBe("billing_detail");
      expect(spanText(draft, dollars[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("blocks spelled-out and digit amounts near 'dollars'", () => {
    for (const [draft, matched] of [
      [
        "You were charged four hundred fifty dollars for it.",
        "four hundred fifty dollars",
      ],
      ["That's 450 dollars, not 45.", "450 dollars"],
    ] as const) {
      const dollars = ruleFindings(draft, "deterministic:dollar_amount");
      expect(dollars).toHaveLength(1);
      expect(spanText(draft, dollars[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("does not block 'dollars' without an amount", () => {
    expect(
      ruleFindings(
        "We never discuss dollars and cents publicly.",
        "deterministic:dollar_amount",
      ),
    ).toEqual([]);
  });
});

describe("deterministicSafetyChecks: procedure vocabulary", () => {
  it('"your crown" blocks with an exact span', () => {
    const draft = "We're sorry your crown came loose.";
    const procedures = ruleFindings(draft, "deterministic:procedure");
    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.level).toBe("block");
    expect(procedures[0]?.code).toBe("treatment_detail");
    expect(spanText(draft, procedures[0] as SafetyFinding)).toBe("crown");
  });

  it('"we offer crowns" warns (generic mention)', () => {
    const draft = "We offer crowns, veneers, and implants.";
    const procedures = ruleFindings(draft, "deterministic:procedure");
    expect(procedures.map((f) => f.level)).toEqual(["warn", "warn", "warn"]);
    expect(procedures.map((f) => spanText(draft, f))).toEqual([
      "crowns",
      "veneers",
      "implants",
    ]);
  });

  it('"our whitening options" is fine — the practice\'s own offering', () => {
    expect(
      ruleFindings(
        "Call us and ask about our whitening options.",
        "deterministic:procedure",
      ),
    ).toEqual([]);
  });

  it("finds the possessive within the ~3-token window", () => {
    const draft = "We're sorry your recent wisdom teeth were painful.";
    const procedures = ruleFindings(draft, "deterministic:procedure");
    expect(procedures).toHaveLength(1);
    expect(procedures[0]?.level).toBe("block");
    expect(spanText(draft, procedures[0] as SafetyFinding)).toBe(
      "wisdom teeth",
    );
  });

  it("matches multi-word terms and plurals", () => {
    const draft = "Root canals and oral surgery are offered here.";
    const procedures = ruleFindings(draft, "deterministic:procedure");
    expect(procedures.map((f) => spanText(draft, f))).toEqual([
      "Root canals",
      "oral surgery",
    ]);
  });
});

describe("deterministicSafetyChecks: care-context nouns", () => {
  it('"your appointment" blocks as a care-relationship confirmation', () => {
    const draft = "We discussed this at your appointment.";
    const care = ruleFindings(draft, "deterministic:care_reference");
    expect(care).toHaveLength(1);
    expect(care[0]?.level).toBe("block");
    expect(care[0]?.code).toBe("confirms_care_relationship");
    expect(spanText(draft, care[0] as SafetyFinding)).toBe("appointment");
  });

  it("maps nouns to reason codes: bill → billing, records → phi, treatment → treatment", () => {
    const cases = [
      ["Please review your bill privately.", "billing_detail", "bill"],
      ["We updated your records accordingly.", "phi_identifier", "records"],
      [
        "We stand behind your treatment plan.",
        "treatment_detail",
        "treatment plan",
      ],
    ] as const;
    for (const [draft, code, matched] of cases) {
      const care = ruleFindings(draft, "deterministic:care_reference");
      expect(care).toHaveLength(1);
      expect(care[0]?.code).toBe(code);
      expect(care[0]?.level).toBe("block");
      expect(spanText(draft, care[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("generic mentions never fire — no 'your', no finding", () => {
    expect(
      deterministicSafetyChecks(
        "Call us to book an appointment; we make every visit count.",
      ),
    ).toEqual([]);
    expect(
      ruleFindings(
        "Your feedback helps us improve.",
        "deterministic:care_reference",
      ),
    ).toEqual([]);
  });
});

describe("deterministicSafetyChecks: insurance", () => {
  it("warns on generic insurance terms", () => {
    const draft = "Copay and deductible questions are best handled privately.";
    const insurance = ruleFindings(draft, "deterministic:insurance");
    expect(insurance.map((f) => f.level)).toEqual(["warn", "warn"]);
    expect(insurance.map((f) => spanText(draft, f))).toEqual([
      "Copay",
      "deductible",
    ]);
    expect(insurance[0]?.code).toBe("insurance_detail");
  });

  it('blocks insurance terms tied to "your"', () => {
    const draft = "The copay is set by your carrier, not by us.";
    const insurance = ruleFindings(draft, "deterministic:insurance");
    const carrier = insurance.find((f) => spanText(draft, f) === "carrier");
    const copay = insurance.find((f) => spanText(draft, f) === "copay");
    expect(carrier?.level).toBe("block");
    expect(copay?.level).toBe("warn");
  });

  it("warns on carrier names, blocks on 'your <carrier>'", () => {
    const generic = ruleFindings(
      "We accept Delta Dental plans.",
      "deterministic:insurance",
    );
    expect(generic).toHaveLength(1);
    expect(generic[0]?.level).toBe("warn");

    const draft = "We already sent that to your Delta Dental plan.";
    const tied = ruleFindings(draft, "deterministic:insurance");
    expect(tied).toHaveLength(1);
    expect(tied[0]?.level).toBe("block");
    expect(spanText(draft, tied[0] as SafetyFinding)).toBe("Delta Dental");
  });
});

describe("deterministicSafetyChecks: phone numbers", () => {
  it("warns on phone numbers with the published-number explanation", () => {
    for (const [draft, matched] of [
      ["Please call us at 555-0123 to talk.", "555-0123"],
      ["Reach us at (555) 123-4567 anytime.", "(555) 123-4567"],
      ["Our line is 555-123-4567.", "555-123-4567"],
    ] as const) {
      const phones = ruleFindings(draft, "deterministic:phone");
      expect(phones).toHaveLength(1);
      expect(phones[0]?.level).toBe("warn");
      expect(phones[0]?.code).toBe("phi_identifier");
      expect(phones[0]?.reason).toContain("published number");
      expect(spanText(draft, phones[0] as SafetyFinding)).toBe(matched);
    }
  });

  it("ignores prose without numbers", () => {
    expect(
      ruleFindings(
        "Call us anytime, we're happy to help.",
        "deterministic:phone",
      ),
    ).toEqual([]);
  });
});

describe("deterministicSafetyChecks: shape", () => {
  it("returns nothing for a clean draft and an empty draft", () => {
    expect(
      deterministicSafetyChecks(
        "Thank you so much for the kind words — we'll share this with the whole team!",
      ),
    ).toEqual([]);
    expect(deterministicSafetyChecks("")).toEqual([]);
  });

  it("returns findings in text order with spans on every finding", () => {
    const draft =
      "As we explained at your appointment last Tuesday, the copay is set by your carrier.";
    const findings = deterministicSafetyChecks(draft);
    expect(findings.length).toBeGreaterThanOrEqual(4);
    const starts = findings.map((f) => f.span?.start ?? -1);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const f of findings) {
      expect(f.span).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 + combination policy
// ---------------------------------------------------------------------------

describe("checkResponseSafety", () => {
  it("calls the pipeline lane with purpose 'safety' and the practice id", async () => {
    const provider = fakeProvider();
    await checkResponseSafety("Thank you for the review.", review, {
      provider,
      practiceId: "practice-1",
      requestId: "req-7",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt.name).toBe(SAFETY_PROMPT_NAME);
    expect(provider.calls[0]?.opts).toMatchObject({
      purpose: SAFETY_PURPOSE,
      practiceId: "practice-1",
      model: "pipeline",
      requestId: "req-7",
    });
  });

  it("returns ok with no findings for a clean draft", async () => {
    const result = await checkResponseSafety(
      "We appreciate you taking the time to leave a review.",
      review,
      { provider: fakeProvider(), practiceId: null },
    );
    expect(result).toEqual({ level: "ok", findings: [] });
  });

  it("merges LLM findings and maps quotes to spans", async () => {
    const draft =
      "We enjoyed having you as a patient for the last three years.";
    const provider = fakeProvider({
      findings: [
        {
          category: "confirms_care_relationship",
          quote: "having you as a patient",
          reason: "Confirms the reviewer was a patient.",
          suggestion:
            "Thank them for the feedback without referencing their care.",
        },
      ],
    });
    const result = await checkResponseSafety(draft, review, {
      provider,
      practiceId: null,
    });
    expect(result.level).toBe("block");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0] as SafetyFinding;
    expect(finding.rule).toBe("llm:care_relationship");
    expect(finding.code).toBe("confirms_care_relationship");
    expect(finding.level).toBe("block");
    expect(spanText(draft, finding)).toBe("having you as a patient");
    expect(finding.suggestion).toContain("without referencing");
  });

  it("maps quotes case-insensitively, and to span null when not found", async () => {
    const draft = "Our records show you missed two appointments.";
    const provider = fakeProvider({
      findings: [
        {
          category: "contradicts_reviewer_privately",
          quote: "our records show", // draft has "Our records show"
          reason: "Disputes the reviewer with private records.",
          suggestion: null,
        },
        {
          category: "defensive_tone",
          quote: "text the model made up entirely",
          reason: "Overall tone is combative.",
          suggestion: null,
        },
      ],
    });
    const result = await checkResponseSafety(draft, review, {
      provider,
      practiceId: null,
    });
    const [contradiction, tone] = result.findings as [
      SafetyFinding,
      SafetyFinding,
    ];
    expect(contradiction.span).toEqual({
      start: 0,
      end: "our records show".length,
    });
    expect(tone.span).toBeNull();
    expect(tone.suggestion).toBeUndefined();
  });

  it("clamps tone and public-dispute categories to warn — never block", async () => {
    const provider = fakeProvider({
      findings: [
        {
          category: "defensive_tone",
          quote: null,
          reason: "Blames the reviewer.",
          suggestion: "Stay calm; acknowledge and invite a call.",
        },
        {
          category: "invites_public_dispute",
          quote: null,
          reason: "Asks the reviewer to argue specifics in public.",
          suggestion: null,
        },
      ],
    });
    const result = await checkResponseSafety(
      "We're sorry, but you were quite rude to our front desk staff.",
      review,
      { provider, practiceId: null },
    );
    expect(result.level).toBe("warn");
    expect(result.findings.map((f) => f.level)).toEqual(["warn", "warn"]);
    expect(result.findings.map((f) => f.rule)).toEqual([
      "llm:tone",
      "llm:public_dispute",
    ]);
  });

  it("keeps deterministic blocks authoritative when the model sees nothing", async () => {
    const draft = "We're sorry your root canal on March 3rd was uncomfortable.";
    const result = await checkResponseSafety(draft, review, {
      provider: fakeProvider(emptyJudgment),
      practiceId: null,
    });
    expect(result.level).toBe("block");
    expect(result.findings.some((f) => f.rule === "deterministic:date")).toBe(
      true,
    );
    expect(
      result.findings.some((f) => f.rule === "deterministic:procedure"),
    ).toBe(true);
  });

  it("lets the model raise warn to block, but never lowers a level", async () => {
    // Deterministic alone: generic procedure mention → warn.
    const draft = "The crown we placed for you carries a five-year warranty.";
    expect(deterministicSafetyChecks(draft).map((f) => f.level)).toEqual([
      "warn",
    ]);

    const provider = fakeProvider({
      findings: [
        {
          category: "confirms_care_relationship",
          quote: "The crown we placed for you",
          reason: "Confirms this reviewer received treatment here.",
          suggestion: null,
        },
      ],
    });
    const result = await checkResponseSafety(draft, review, {
      provider,
      practiceId: null,
    });
    expect(result.level).toBe("block");
    // Both layers' findings survive the merge.
    expect(result.findings.map((f) => f.rule)).toEqual([
      "deterministic:procedure",
      "llm:care_relationship",
    ]);
  });
});

describe("checkResponseSafety: degraded mode (AI unavailable)", () => {
  it("returns deterministic findings plus an info notice, level unchanged", async () => {
    const draft = "We're sorry your root canal on March 3rd was uncomfortable.";
    const result = await checkResponseSafety(draft, review, {
      provider: new DownProvider(),
      practiceId: null,
    });
    expect(result.level).toBe("block");
    const notice = result.findings.at(-1) as SafetyFinding;
    expect(notice.rule).toBe("llm:skipped");
    expect(notice.code).toBe("ai_check_skipped");
    expect(notice.level).toBe("info");
    expect(notice.span).toBeNull();
    expect(
      result.findings.filter((f) => f.rule.startsWith("deterministic:")).length,
    ).toBeGreaterThan(0);
  });

  it("a clean draft stays ok — the skipped notice never raises the level", async () => {
    const result = await checkResponseSafety(
      "Thank you for the feedback. We take every comment seriously.",
      review,
      { provider: new DownProvider(), practiceId: null },
    );
    expect(result.level).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe("ai_check_skipped");
  });

  it("degrades honestly: an LLM-only block is missed and the notice says so", async () => {
    const result = await checkResponseSafety(
      "We enjoyed having you as a patient for the last three years.",
      review,
      { provider: new DownProvider(), practiceId: null },
    );
    expect(result.level).toBe("ok"); // deterministic layer can't see this one
    expect(result.findings[0]?.reason).toContain("NOT checked");
  });

  it("non-AI errors (test bugs, programming errors) propagate", async () => {
    const broken: AiProvider = {
      classify: () => {
        throw new TypeError("undefined is not a function");
      },
    };
    await expect(
      checkResponseSafety("Thanks!", review, {
        provider: broken,
        practiceId: null,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("quoteToSpan", () => {
  it("prefers the exact match, falls back to case-insensitive, then null", () => {
    expect(quoteToSpan("Abc abc", "abc")).toEqual({ start: 4, end: 7 });
    expect(quoteToSpan("Only Uppercase Here", "only uppercase")).toEqual({
      start: 0,
      end: 14,
    });
    expect(quoteToSpan("some draft", "absent")).toBeNull();
    expect(quoteToSpan("some draft", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The issue's labeled examples, end to end (also committed as eval fixtures)
// ---------------------------------------------------------------------------

interface SafetyFixture {
  id: string;
  prompt: string;
  input: { draft: string; review: ReviewContext };
  expected: { level: SafetyLevel; must_block?: boolean };
  notes: string;
}

const fixturesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../evals/fixtures/safety.jsonl",
);
const fixtures: SafetyFixture[] = readFileSync(fixturesPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as SafetyFixture);

/**
 * What a well-behaved Layer-2 model returns per fixture. Fixtures not
 * listed get an empty judgment — their expected level must come from the
 * deterministic layer alone.
 */
const llmJudgments: Record<string, SafetyJudgment> = {
  "records-show-missed-appointments": {
    findings: [
      {
        category: "contradicts_reviewer_privately",
        quote: "Our records show you missed two appointments",
        reason:
          "Disputes the reviewer using appointment history only the practice has.",
        suggestion:
          "Acknowledge the frustration and invite a private conversation.",
      },
    ],
  },
  "enjoyed-having-you-as-patient": {
    findings: [
      {
        category: "confirms_care_relationship",
        quote: "having you as a patient for the last three years",
        reason:
          "Publicly confirms the reviewer was a patient, and for how long.",
        suggestion:
          "Thank them warmly without referencing their patient history.",
      },
    ],
  },
  "crown-we-placed-warranty": {
    findings: [
      {
        category: "confirms_care_relationship",
        quote: "The crown we placed for you",
        reason: "Confirms this reviewer received treatment at the practice.",
        suggestion:
          "Speak about warranties generally, or take it to a private channel.",
      },
    ],
  },
  "thats-not-what-happened": {
    findings: [
      {
        category: "contradicts_reviewer_privately",
        quote:
          "you were seen on time and declined the treatment we recommended",
        reason:
          "Disputes the reviewer's account using visit details only the practice has.",
        suggestion: "Never litigate the facts publicly; invite a call instead.",
      },
      {
        category: "defensive_tone",
        quote: "That's simply not what happened",
        reason: "Argues with the reviewer instead of de-escalating.",
        suggestion: null,
      },
    ],
  },
  "you-were-rude-to-staff": {
    findings: [
      {
        category: "defensive_tone",
        quote: "you were quite rude to our front desk staff",
        reason: "Blames the reviewer — escalates rather than de-escalates.",
        suggestion:
          "Apologize for the experience and invite a private conversation.",
      },
    ],
  },
  "dental-family-duration": {
    findings: [
      {
        category: "confirms_care_relationship",
        quote: "being part of our dental family for the past five years",
        reason:
          "Publicly confirms the reviewer has been a patient, and for how long.",
        suggestion:
          "Thank them warmly without referencing their patient history.",
      },
    ],
  },
  "reply-here-line-by-line": {
    findings: [
      {
        category: "invites_public_dispute",
        quote: "Reply right here with exactly what you were charged",
        reason:
          "Invites a public back-and-forth about billing specifics instead of a private channel.",
        suggestion:
          "Ask them to call the office so the details stay out of public view.",
      },
    ],
  },
};

describe("labeled examples (evals/fixtures/safety.jsonl) through the full detector", () => {
  it("has the issue's 15+ examples", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
    for (const fixture of fixtures) {
      expect(fixture.prompt).toBe(SAFETY_PROMPT_NAME);
    }
  });

  it.each(
    fixtures.map((f) => [f.id, f] as const),
  )("%s", async (_id, fixture) => {
    const judgment = llmJudgments[fixture.id] ?? emptyJudgment;
    const result = await checkResponseSafety(
      fixture.input.draft,
      fixture.input.review,
      { provider: fakeProvider(judgment), practiceId: null },
    );
    expect(result.level).toBe(fixture.expected.level);
    if (fixture.expected.must_block) {
      expect(result.level).toBe("block");
    }
    // Span accuracy: every span points inside the draft.
    for (const finding of result.findings) {
      if (!finding.span) continue;
      expect(finding.span.start).toBeGreaterThanOrEqual(0);
      expect(finding.span.end).toBeGreaterThan(finding.span.start);
      expect(finding.span.end).toBeLessThanOrEqual(fixture.input.draft.length);
    }
  });

  it("every must_block fixture still blocks in degraded mode OR is an LLM-only case", async () => {
    // Documents which blocks survive an AI outage: the deterministic ones.
    for (const fixture of fixtures) {
      if (!fixture.expected.must_block) continue;
      const deterministicLevel = deterministicSafetyChecks(
        fixture.input.draft,
      ).some((f) => f.level === "block");
      const needsLlm = llmJudgments[fixture.id] !== undefined;
      expect(deterministicLevel || needsLlm).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Starter templates (issue #83): a template is a response waiting to
// happen, so every starter body must pass Layer 1 clean — with dummy
// placeholder values substituted, exactly as the save-time gate renders it.
// ---------------------------------------------------------------------------

describe("starter response templates pass the deterministic layer", () => {
  it.each(
    STARTER_RESPONSE_TEMPLATES.map((template) => [template.name, template]),
  )("%s", (_name, template) => {
    const rendered = renderTemplate(template.body, {
      reviewer_name: TEMPLATE_SAFETY_DUMMY_REVIEWER,
      practice_name: "Cedar Ridge Dental",
    });
    const findings = deterministicSafetyChecks(rendered);
    expect(findings.filter((f) => f.level === "block")).toEqual([]);
    expect(findings.filter((f) => f.level === "warn")).toEqual([]);
  });
});
