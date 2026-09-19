import { DatabaseSync } from "node:sqlite";
import type { InventoryRepository, Product } from "./inventory.js";

export class InventoryDatabase implements InventoryRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      price_cents INTEGER NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS stock_restorations (
      key TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    const seed = this.db.prepare(
      "INSERT OR IGNORE INTO products (id, sku, name, price_cents, stock) VALUES (?, ?, ?, ?, ?)"
    );
    seed.run("prod-a", "SKU-A", "Product A", 1500, 20);
    seed.run("prod-b", "SKU-B", "Product B", 2500, 10);
  }

  list(): Product[] {
    return this.db.prepare("SELECT id, sku, name, price_cents AS priceCents, stock FROM products ORDER BY id")
      .all() as Product[];
  }

  close(): void {
    this.db.close();
  }

  get(id: string): Product | undefined {
    return this.db.prepare("SELECT id, sku, name, price_cents AS priceCents, stock FROM products WHERE id = ?")
      .get(id) as Product | undefined;
  }

  decrement(id: string, quantity: number): Product | undefined {
    const result = this.db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?")
      .run(quantity, id, quantity);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  applyRestoration(
    key: string,
    productId: string,
    quantity: number,
    appliedAt: string,
  ): { product: Product; applied: boolean } | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT key FROM stock_restorations WHERE key = ?").get(key);
      const current = this.get(productId);
      if (!current) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      if (existing) {
        this.db.exec("COMMIT");
        return { product: current, applied: false };
      }
      this.db.prepare(
        "INSERT INTO stock_restorations (key, product_id, quantity, applied_at) VALUES (?, ?, ?, ?)"
      ).run(key, productId, quantity, appliedAt);
      this.db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(quantity, productId);
      const product = this.get(productId) as Product;
      this.db.exec("COMMIT");
      return { product, applied: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
