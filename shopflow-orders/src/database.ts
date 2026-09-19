import { DatabaseSync } from "node:sqlite";
import type { Order, OrderRepository } from "./orders.js";

const SCHEMA_VERSION = 2;

/** Columns added by the cancellation feature; their absence means the stored schema is legacy. */
const CANCELLATION_COLUMNS = [
  "cancelled_at",
  "cancellation_reason",
  "inventory_restore_state",
  "cancellation_notified_at",
];

const ORDER_COLUMNS = `id, customer_email AS customerEmail, product_id AS productId, quantity,
  total_cents AS totalCents, status, created_at AS createdAt, cancelled_at AS cancelledAt,
  cancellation_reason AS cancellationReason, inventory_restore_state AS inventoryRestoreState,
  cancellation_notified_at AS cancellationNotifiedAt`;

function createOrdersTable(table: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (
    id TEXT PRIMARY KEY,
    customer_email TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED', 'CANCELLED')),
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancellation_reason TEXT,
    inventory_restore_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
      CHECK (inventory_restore_state IN ('NOT_REQUIRED', 'PENDING', 'DONE')),
    cancellation_notified_at TEXT
  )`;
}

type OrderRow = {
  id: string;
  customerEmail: string;
  productId: string;
  quantity: number;
  totalCents: number;
  status: Order["status"];
  createdAt: string;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  inventoryRestoreState?: string | null;
  cancellationNotifiedAt?: string | null;
};

function toOrder(row: OrderRow | undefined): Order | undefined {
  if (!row) return undefined;
  return {
    ...row,
    cancelledAt: row.cancelledAt ?? null,
    cancellationReason: row.cancellationReason ?? null,
    inventoryRestoreState: (row.inventoryRestoreState ?? "NOT_REQUIRED") as Order["inventoryRestoreState"],
    cancellationNotifiedAt: row.cancellationNotifiedAt ?? null,
  };
}

export class OrderDatabase implements OrderRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  create(order: Order): Order {
    this.db.prepare(`INSERT INTO orders
      (id, customer_email, product_id, quantity, total_cents, status, created_at,
       cancelled_at, cancellation_reason, inventory_restore_state, cancellation_notified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        order.id, order.customerEmail, order.productId, order.quantity,
        order.totalCents, order.status, order.createdAt,
        order.cancelledAt ?? null, order.cancellationReason ?? null,
        order.inventoryRestoreState ?? "NOT_REQUIRED", order.cancellationNotifiedAt ?? null
      );
    return order;
  }

  get(id: string): Order | undefined {
    return toOrder(this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id) as OrderRow | undefined);
  }

  markShipped(id: string): Order | undefined {
    const result = this.db.prepare("UPDATE orders SET status = 'SHIPPED' WHERE id = ? AND status = 'CONFIRMED'").run(id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  markCancelled(id: string, changes: { cancelledAt: string; cancellationReason: string }): Order | undefined {
    const result = this.db.prepare(`UPDATE orders SET status = 'CANCELLED', cancelled_at = :cancelledAt,
      cancellation_reason = :reason, inventory_restore_state = 'PENDING'
      WHERE id = :id AND status = 'CONFIRMED'`).run({
        cancelledAt: changes.cancelledAt, reason: changes.cancellationReason, id,
      });
    return result.changes === 1 ? this.get(id) : undefined;
  }

  setInventoryRestoreState(id: string, state: "DONE"): void {
    this.db.prepare("UPDATE orders SET inventory_restore_state = ? WHERE id = ?").run(state, id);
  }

  setCancellationNotifiedAt(id: string, at: string): void {
    this.db.prepare("UPDATE orders SET cancellation_notified_at = ? WHERE id = ?").run(at, id);
  }

  listPendingCancellations(): Order[] {
    const rows = this.db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders
      WHERE status = 'CANCELLED' AND (inventory_restore_state = 'PENDING' OR cancellation_notified_at IS NULL)
      ORDER BY created_at, id`).all() as OrderRow[];
    return rows.map((row) => toOrder(row) as Order);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM orders WHERE id = ?").run(id);
  }

  /**
   * Idempotent, guarded startup migration. A legacy table (status CHECK without 'CANCELLED', missing
   * cancellation columns) is rebuilt inside one transaction so rows already in the persistent volume
   * survive. An empty or already-migrated database is untouched.
   */
  private migrate(): void {
    const existing = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
    ).get() as { sql?: string | null } | undefined;

    if (!existing) {
      this.db.exec(createOrdersTable("orders", true));
      this.setSchemaVersion();
      return;
    }

    const columns = this.columnNames("orders");
    const sql = String(existing.sql ?? "");
    const missingColumns = CANCELLATION_COLUMNS.some((column) => !columns.includes(column));
    if (!missingColumns && sql.includes("'CANCELLED'")) {
      this.setSchemaVersion();
      return;
    }

    const source = (column: string, fallback: string): string => (columns.includes(column) ? column : fallback);
    const carried = [
      source("cancelled_at", "NULL"),
      source("cancellation_reason", "NULL"),
      columns.includes("inventory_restore_state")
        ? "COALESCE(inventory_restore_state, 'NOT_REQUIRED')"
        : "'NOT_REQUIRED'",
      source("cancellation_notified_at", "NULL"),
    ].join(", ");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DROP TABLE IF EXISTS orders_new");
      this.db.exec(createOrdersTable("orders_new"));
      this.db.exec(`INSERT INTO orders_new
        (id, customer_email, product_id, quantity, total_cents, status, created_at,
         cancelled_at, cancellation_reason, inventory_restore_state, cancellation_notified_at)
        SELECT id, customer_email, product_id, quantity, total_cents, status, created_at, ${carried}
        FROM orders`);
      this.db.exec("DROP TABLE orders");
      this.db.exec("ALTER TABLE orders_new RENAME TO orders");
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private setSchemaVersion(): void {
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private columnNames(table: string): string[] {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((row) => row.name);
  }
}
