import type { InventoryPort, NotificationPort, Order } from "./orders.js";

async function call(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw Object.assign(new Error(String(body.error ?? "Downstream request failed")), { status: response.status });
  }
  return body;
}

export class InventoryHttpClient implements InventoryPort {
  constructor(private readonly baseUrl: string) {}
  async validate(productId: string, quantity: number) {
    return await call(`${this.baseUrl}/inventory/validate`, {
      method: "POST", body: JSON.stringify({ productId, quantity }),
    }) as { product: { priceCents: number } };
  }
  async decrement(productId: string, quantity: number): Promise<void> {
    await call(`${this.baseUrl}/inventory/decrement`, {
      method: "POST", body: JSON.stringify({ productId, quantity }),
    });
  }
  async restore(productId: string, quantity: number, idempotencyKey: string): Promise<void> {
    await call(`${this.baseUrl}/inventory/restore`, {
      method: "POST", body: JSON.stringify({ productId, quantity, idempotencyKey }),
    });
  }
}

export class NotificationHttpClient implements NotificationPort {
  constructor(private readonly baseUrl: string) {}
  async orderConfirmation(order: Order): Promise<void> {
    await call(`${this.baseUrl}/notifications/order-confirmation`, {
      method: "POST",
      body: JSON.stringify({ orderId: order.id, customerEmail: order.customerEmail }),
    });
  }
  async orderCancellation(order: Order, reason: string): Promise<void> {
    await call(`${this.baseUrl}/notifications/order-cancellation`, {
      method: "POST",
      body: JSON.stringify({ orderId: order.id, customerEmail: order.customerEmail, reason }),
    });
  }
}
