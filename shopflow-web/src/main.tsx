import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Product = { id: string; sku: string; name: string; priceCents: number; stock: number };
type Order = { id: string; status: "CONFIRMED" | "SHIPPED"; productId: string; quantity: number; totalCents: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [order, setOrder] = useState<Order>();
  const [error, setError] = useState("");
  const refresh = () => api<Product[]>("/api/products").then(setProducts).catch(e => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const created = await api<Order>("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          productId: form.get("productId"),
          quantity: Number(form.get("quantity")),
          customerEmail: form.get("customerEmail"),
        }),
      });
      setOrder(created);
      refresh();
    } catch (e) { setError((e as Error).message); }
  }

  async function ship() {
    if (!order) return;
    try { setOrder(await api<Order>(`/api/orders/${order.id}/ship`, { method: "POST" })); }
    catch (e) { setError((e as Error).message); }
  }

  return <main>
    <h1>ShopFlow</h1>
    <section><h2>Catalog</h2>
      <div className="products">{products.map(p => <article key={p.id}>
        <h3>{p.name}</h3><p>{p.sku}</p><p>${(p.priceCents / 100).toFixed(2)}</p><strong>{p.stock} in stock</strong>
      </article>)}</div>
    </section>
    <section><h2>Create order</h2>
      <form onSubmit={create}>
        <select name="productId">{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <input name="quantity" type="number" min="1" defaultValue="1" required />
        <input name="customerEmail" type="email" placeholder="buyer@example.com" required />
        <button>Place order</button>
      </form>
    </section>
    {error && <p className="error">{error}</p>}
    {order && <section><h2>Order {order.id}</h2><p>Status: <strong>{order.status}</strong></p>
      <p>Total: ${(order.totalCents / 100).toFixed(2)}</p>
      {order.status === "CONFIRMED" && <button onClick={ship}>Mark SHIPPED</button>}
    </section>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
