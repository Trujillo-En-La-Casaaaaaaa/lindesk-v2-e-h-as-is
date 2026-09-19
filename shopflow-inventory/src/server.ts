import { createServer } from "node:http";
import { InventoryDatabase } from "./database.js";
import { InventoryService } from "./inventory.js";
import { fail, json, jsonBody } from "./http.js";

const service = new InventoryService(new InventoryDatabase(process.env.DATABASE_PATH ?? "./data/inventory.db"));
const port = Number(process.env.PORT ?? 3002);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://inventory");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/products") return json(res, 200, service.list());
    const product = url.pathname.match(/^\/products\/([^/]+)$/);
    if (req.method === "GET" && product) return json(res, 200, service.get(decodeURIComponent(product[1])));
    if (req.method === "POST" && url.pathname === "/inventory/validate") {
      const body = await jsonBody(req);
      return json(res, 200, service.validate(String(body.productId ?? ""), Number(body.quantity)));
    }
    if (req.method === "POST" && url.pathname === "/inventory/decrement") {
      const body = await jsonBody(req);
      return json(res, 200, service.decrement(String(body.productId ?? ""), Number(body.quantity)));
    }
    if (req.method === "POST" && url.pathname === "/inventory/restore") {
      const body = await jsonBody(req);
      return json(res, 200, service.restore(
        String(body.productId ?? ""),
        Number(body.quantity),
        String(body.idempotencyKey ?? ""),
      ));
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    fail(res, error);
  }
}).listen(port, "0.0.0.0", () => console.log(`inventory listening on ${port}`));
