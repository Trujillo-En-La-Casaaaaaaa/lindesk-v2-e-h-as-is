import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { InventoryHttpClient, NotificationHttpClient } from "./clients.js";
import { OrderDatabase } from "./database.js";
import { fail, json, jsonBody } from "./http.js";
import { OrderService } from "./orders.js";

const service = new OrderService(
  new OrderDatabase(process.env.DATABASE_PATH ?? "./data/orders.db"),
  new InventoryHttpClient(process.env.INVENTORY_URL ?? "http://inventory:3002"),
  new NotificationHttpClient(process.env.NOTIFICATIONS_URL ?? "http://notifications:3003"),
  randomUUID,
  () => new Date().toISOString(),
);
const port = Number(process.env.PORT ?? 3001);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://orders");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/orders") {
      const body = await jsonBody(req);
      const order = await service.create({
        productId: String(body.productId ?? ""),
        quantity: Number(body.quantity),
        customerEmail: String(body.customerEmail ?? ""),
      });
      return json(res, 201, order);
    }
    const detail = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (req.method === "GET" && detail) return json(res, 200, service.get(decodeURIComponent(detail[1])));
    const ship = url.pathname.match(/^\/orders\/([^/]+)\/ship$/);
    if (req.method === "POST" && ship) return json(res, 200, service.ship(decodeURIComponent(ship[1])));
    json(res, 404, { error: "Not found" });
  } catch (error) {
    fail(res, error);
  }
}).listen(port, "0.0.0.0", () => console.log(`orders listening on ${port}`));
