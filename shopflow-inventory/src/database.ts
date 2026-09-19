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

  get(id: string): Product | undefined {
    return this.db.prepare("SELECT id, sku, name, price_cents AS priceCents, stock FROM products WHERE id = ?")
      .get(id) as Product | undefined;
  }

  decrement(id: string, quantity: number): Product | undefined {
    const result = this.db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?")
      .run(quantity, id, quantity);
    return result.changes === 1 ? this.get(id) : undefined;
  }
}
