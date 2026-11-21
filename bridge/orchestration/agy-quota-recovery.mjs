// Managed jobs require explicit reconciliation; pre-existing legacy jobs
// retain their own quota retry contract independently of the feature flag.
export function isLegacyQuotaRetry(record) {
  return record?.state === "waiting_quota" &&
    record.submissionMode !== "managed" &&
    typeof record.resumeAt === "string" &&
    Number.isFinite(Date.parse(record.resumeAt));
}
