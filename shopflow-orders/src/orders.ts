export type OrderStatus = "CONFIRMED" | "SHIPPED";
export type Order = {
  id: string;
  customerEmail: string;
  productId: string;
  quantity: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
};

export interface OrderRepository {
  create(order: Order): Order;
  get(id: string): Order | undefined;
  markShipped(id: string): Order | undefined;
  remove(id: string): void;
}

export interface InventoryPort {
  validate(productId: string, quantity: number): Promise<{ product: { priceCents: number } }>;
  decrement(productId: string, quantity: number): Promise<void>;
}

export interface NotificationPort {
  orderConfirmation(order: Order): Promise<void>;
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
}
