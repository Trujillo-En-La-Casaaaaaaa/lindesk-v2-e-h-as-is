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
}
