// ResponseStatusChip (#80/#82): the response lifecycle at a glance —
// color-coded per the four inbox states plus `failed`. "Published" is
// deliberately honest about moderation: Google accepting a reply does NOT
// make it live (the #117 spike), so a PENDING moderation state reads
// "published · in review at Google" rather than a plain green check.
import { Badge } from "~/components/ui/badge";

export type ResponseChipStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "published"
  | "failed";

const LABELS: Record<ResponseChipStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  published: "Published",
  failed: "Publish failed",
};

const TONES: Record<
  ResponseChipStatus,
  "neutral" | "caution" | "brand" | "positive" | "negative"
> = {
  draft: "neutral",
  pending_approval: "caution",
  approved: "brand",
  published: "positive",
  failed: "negative",
};

export function ResponseStatusChip({
  status,
  moderationState,
}: {
  status: ResponseChipStatus;
  /** GBP reply moderation state, for published rows. */
  moderationState?: "PENDING" | "APPROVED" | "REJECTED" | null;
}) {
  const suffix =
    status === "published" && moderationState === "PENDING"
      ? " · in review at Google"
      : "";
  return (
    <Badge
      tone={TONES[status]}
      data-testid="response-status-chip"
      data-status={status}
    >
      {LABELS[status]}
      {suffix}
    </Badge>
  );
}
