# ADR NNNN: Title

- **Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Deciders:** who was involved in the decision

## Context

What is the issue that we're seeing that is motivating this decision or change? Describe the forces at play — technical, product, compliance, cost — in neutral language. A reader should be able to see why this needed deciding at all.

## Decision

What is the change that we're proposing and/or doing? State it in full sentences, in the active voice: "We will …".

## Consequences

What becomes easier or more difficult to do because of this change? List positive, negative, and neutral consequences honestly — a decision with no downsides listed is a decision that wasn't examined.

---

Conventions for this directory:

- Number ADRs with zero-padded four digits (`0001`, `0002`, …), never reuse a number.
- Default to **one decision per file**. Two tightly-coupled decisions made together may share a file (as ADR 0001 does), but treat that as the exception.
- ADRs are immutable once Accepted: to change course, write a new ADR that supersedes the old one and update the old one's Status.
