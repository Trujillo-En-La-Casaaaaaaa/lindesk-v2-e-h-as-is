import { createServer } from "node:http";
import { fail, json, jsonBody } from "./http.js";

const providerUrl = process.env.PROVIDER_URL ?? "http://notification-provider:3004";
const port = Number(process.env.PORT ?? 3003);

async function provider(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${providerUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error("Notification provider failed"), { status: 502 });
  return body;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://notifications");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/notifications/order-confirmation") {
      const body = await jsonBody(req);
      if (!body.orderId || !String(body.customerEmail ?? "").includes("@")) {
        return json(res, 400, { error: "Invalid notification" });
      }
      const message = await provider("/messages", {
        method: "POST",
        body: JSON.stringify({
          type: "ORDER_CONFIRMATION",
          orderId: String(body.orderId),
          to: String(body.customerEmail),
          payload: { orderId: String(body.orderId) },
        }),
      });
      return json(res, 201, message);
    }
    if (req.method === "GET" && url.pathname === "/notifications") {
      return json(res, 200, await provider("/messages"));
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    fail(res, error);
  }
}).listen(port, "0.0.0.0", () => console.log(`notifications listening on ${port}`));
