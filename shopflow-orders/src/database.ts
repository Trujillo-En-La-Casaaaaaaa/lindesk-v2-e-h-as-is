import { DatabaseSync } from "node:sqlite";
import type { Order, OrderRepository } from "./orders.js";

export class OrderDatabase implements OrderRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, customer_email TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL, total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED')), created_at TEXT NOT NULL
    )`);
  }

  create(order: Order): Order {
    this.db.prepare(`INSERT INTO orders
      (id, customer_email, product_id, quantity, total_cents, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        order.id, order.customerEmail, order.productId, order.quantity,
        order.totalCents, order.status, order.createdAt
      );
    return order;
  }

  get(id: string): Order | undefined {
    return this.db.prepare(`SELECT id, customer_email AS customerEmail, product_id AS productId,
      quantity, total_cents AS totalCents, status, created_at AS createdAt FROM orders WHERE id = ?`)
      .get(id) as Order | undefined;
  }

  markShipped(id: string): Order | undefined {
    const result = this.db.prepare("UPDATE orders SET status = 'SHIPPED' WHERE id = ? AND status = 'CONFIRMED'").run(id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM orders WHERE id = ?").run(id);
  }
}
