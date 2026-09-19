export type OrderStatus = "CONFIRMED" | "SHIPPED" | "CANCELLED";
export type InventoryRestoreState = "NOT_REQUIRED" | "PENDING" | "DONE";

export type Order = {
  id: string;
  customerEmail: string;
  productId: string;
  quantity: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  inventoryRestoreState: InventoryRestoreState;
  cancellationNotifiedAt?: string | null;
};

export interface OrderRepository {
  create(order: Order): Order;
  get(id: string): Order | undefined;
  markShipped(id: string): Order | undefined;
  remove(id: string): void;
  markCancelled(id: string, changes: { cancelledAt: string; cancellationReason: string }): Order | undefined;
  setInventoryRestoreState(id: string, state: "DONE"): void;
  setCancellationNotifiedAt(id: string, at: string): void;
  listPendingCancellations(): Order[];
}

export interface InventoryPort {
  validate(productId: string, quantity: number): Promise<{ product: { priceCents: number } }>;
  decrement(productId: string, quantity: number): Promise<void>;
  restore(productId: string, quantity: number, idempotencyKey: string): Promise<void>;
}

export interface NotificationPort {
  orderConfirmation(order: Order): Promise<void>;
  orderCancellation(order: Order, reason: string): Promise<void>;
}

export const MAX_CANCELLATION_REASON_LENGTH = 200;

/** Exactly-once inventory restoration is keyed off the order id, so every retry converges. */
export function inventoryRestoreKey(orderId: string): string {
  return `order-cancel:${orderId}`;
}

export class OrderService {
  constructor(
    private readonly repository: OrderRepository,
    private readonly inventory: InventoryPort,
    private readonly notifications: NotificationPort,
    private readonly newId: () => string,
    private readonly now: () => string,
  ) {}

  get(id: string): Order {
    const order = this.repository.get(id);
    if (!order) throw Object.assign(new Error("Order not found"), { status: 404 });
    return order;
  }

  async create(input: { productId: string; quantity: number; customerEmail: string }): Promise<Order> {
    if (!input.productId || !input.customerEmail.includes("@") ||
        !Number.isInteger(input.quantity) || input.quantity < 1) {
      throw Object.assign(new Error("Invalid order"), { status: 400 });
    }
    const validation = await this.inventory.validate(input.productId, input.quantity);
    const order = this.repository.create({
      id: this.newId(),
      customerEmail: input.customerEmail,
      productId: input.productId,
      quantity: input.quantity,
      totalCents: validation.product.priceCents * input.quantity,
      status: "CONFIRMED",
      createdAt: this.now(),
      cancelledAt: null,
      cancellationReason: null,
      inventoryRestoreState: "NOT_REQUIRED",
      cancellationNotifiedAt: null,
    });
    try {
      await this.inventory.decrement(input.productId, input.quantity);
    } catch (error) {
      this.repository.remove(order.id);
      throw error;
    }
    await this.notifications.orderConfirmation(order);
    return order;
  }

  ship(id: string): Order {
    const existing = this.get(id);
    if (existing.status !== "CONFIRMED") {
      throw Object.assign(new Error("Order cannot be shipped"), { status: 409 });
    }
    const shipped = this.repository.markShipped(id);
    if (!shipped) throw Object.assign(new Error("Order cannot be shipped"), { status: 409 });
    return shipped;
  }

  /**
   * Cancels a confirmed order. The status transition is the single claim point: a concurrent request
   * loses the conditional update and continues on the idempotent completion path instead of failing.
   * Compensation (inventory restore, then notification) is driven by durable markers on the order, so a
   * crash or a downstream failure leaves the cancellation committed and completes on retry/reconcile.
   */
  async cancel(id: string, reason: string): Promise<Order> {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length === 0) {
      throw Object.assign(new Error("A cancellation reason is required"), { status: 400 });
    }
    if (trimmed.length > MAX_CANCELLATION_REASON_LENGTH) {
      throw Object.assign(new Error("Cancellation reason must be 200 characters or fewer"), { status: 400 });
    }

    const existing = this.get(id);
    if (existing.status === "SHIPPED") {
      throw Object.assign(new Error("Order cannot be cancelled after shipping"), { status: 409 });
    }
    if (existing.status === "CONFIRMED") {
      // `undefined` is not an error: it means another request already claimed the transition.
      this.repository.markCancelled(id, { cancelledAt: this.now(), cancellationReason: trimmed });
    }

    const claimed = this.repository.get(id);
    if (!claimed) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (claimed.status !== "CANCELLED") {
      // Only reachable when a concurrent request shipped the order between the read and the claim.
      throw Object.assign(new Error("Order cannot be cancelled after shipping"), { status: 409 });
    }
    return await this.completeCancellation(claimed, trimmed);
  }

  /** Drives the outstanding compensation for one durably cancelled order. */
  private async completeCancellation(order: Order, fallbackReason: string): Promise<Order> {
    let current = order;
    try {
      if (current.inventoryRestoreState === "PENDING") {
        await this.inventory.restore(current.productId, current.quantity, inventoryRestoreKey(current.id));
        this.repository.setInventoryRestoreState(current.id, "DONE");
      }
      current = this.repository.get(current.id) ?? current;
      if (!current.cancellationNotifiedAt) {
        const reason = current.cancellationReason ?? fallbackReason;
        await this.notifications.orderCancellation(current, reason);
        this.repository.setCancellationNotifiedAt(current.id, this.now());
      }
    } catch (error) {
      const latest = this.repository.get(current.id) ?? current;
      throw Object.assign(new Error("Cancellation is durable but completion is pending"), {
        status: 502,
        details: { order: latest },
        cause: error,
      });
    }
    return this.repository.get(current.id) ?? current;
  }

  /**
   * Recovery path for a crash between the cancellation commit and its compensation. Returns the number
   * of orders whose compensation is complete after this pass; orders with a still-failing downstream stay
   * pending for the next pass.
   */
  async reconcileCancellations(): Promise<number> {
    const pending = this.repository.listPendingCancellations();
    let reconciled = 0;
    for (const order of pending) {
      try {
        const completed = await this.completeCancellation(order, order.cancellationReason ?? "");
        if (completed.inventoryRestoreState !== "PENDING" && completed.cancellationNotifiedAt) reconciled += 1;
      } catch (error) {
        console.error(`orders: cancellation ${order.id} still pending (${(error as Error).message})`);
      }
    }
    return reconciled;
  }
}
