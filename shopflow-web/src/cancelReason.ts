export const MAX_CANCELLATION_REASON = 200;

/**
 * Convenience guard for the cancellation reason.
 *
 * This only mirrors the backend rule so the UI can react before a request is
 * sent. The backend stays authoritative: a `400`, `409` or `502` response must
 * still be surfaced to the user.
 */
export function validateCancellationReason(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "A cancellation reason is required";
  if (trimmed.length > MAX_CANCELLATION_REASON) {
    return "Cancellation reason must be 200 characters or fewer";
  }
  return undefined;
}
