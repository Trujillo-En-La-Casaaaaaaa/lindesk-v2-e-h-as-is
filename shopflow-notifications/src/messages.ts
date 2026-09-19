export type ProviderMessage = {
  type: string;
  orderId: string;
  to: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function invalidNotification(): Error {
  return Object.assign(new Error("Invalid notification"), { status: 400 });
}

export function buildOrderConfirmation(input: { orderId?: unknown; customerEmail?: unknown }): ProviderMessage {
  if (isBlank(input.orderId) || !String(input.customerEmail ?? "").includes("@")) {
    throw invalidNotification();
  }
  const orderId = String(input.orderId);
  return {
    type: "ORDER_CONFIRMATION",
    orderId,
    to: String(input.customerEmail),
    idempotencyKey: `order-confirmation:${orderId}`,
    payload: { orderId },
  };
}

export function buildOrderCancellation(input: {
  orderId?: unknown;
  customerEmail?: unknown;
  reason?: unknown;
}): ProviderMessage {
  if (isBlank(input.orderId) || !String(input.customerEmail ?? "").includes("@")) {
    throw invalidNotification();
  }
  const orderId = String(input.orderId);
  return {
    type: "ORDER_CANCELLATION",
    orderId,
    to: String(input.customerEmail),
    idempotencyKey: `order-cancellation:${orderId}`,
    payload: { orderId, reason: String(input.reason ?? "") },
  };
}
