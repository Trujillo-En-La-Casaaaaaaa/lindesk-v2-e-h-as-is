export type Product = {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
};

export interface InventoryRepository {
  list(): Product[];
  get(id: string): Product | undefined;
  decrement(id: string, quantity: number): Product | undefined;
  applyRestoration(
    key: string,
    productId: string,
    quantity: number,
    appliedAt: string,
  ): { product: Product; applied: boolean } | undefined;
}

export class InventoryService {
  constructor(private readonly repository: InventoryRepository) {}

  list(): Product[] {
    return this.repository.list();
  }

  get(id: string): Product {
    const product = this.repository.get(id);
    if (!product) throw Object.assign(new Error("Product not found"), { status: 404 });
    return product;
  }

  validate(productId: string, quantity: number): { available: true; product: Product } {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw Object.assign(new Error("Quantity must be a positive integer"), { status: 400 });
    }
    const product = this.get(productId);
    if (product.stock < quantity) {
      throw Object.assign(new Error("Insufficient stock"), { status: 409 });
    }
    return { available: true, product };
  }

  decrement(productId: string, quantity: number): Product {
    this.validate(productId, quantity);
    const product = this.repository.decrement(productId, quantity);
    if (!product) throw Object.assign(new Error("Insufficient stock"), { status: 409 });
    return product;
  }

  restore(productId: string, quantity: number, idempotencyKey: string): Product {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      throw Object.assign(new Error("An idempotency key is required"), { status: 400 });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw Object.assign(new Error("Quantity must be a positive integer"), { status: 400 });
    }
    const result = this.repository.applyRestoration(
      idempotencyKey,
      productId,
      quantity,
      new Date().toISOString(),
    );
    if (!result) throw Object.assign(new Error("Product not found"), { status: 404 });
    return result.product;
  }
}
