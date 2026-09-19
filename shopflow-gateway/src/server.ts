import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createDestination } from "./routes.js";

const orders = process.env.ORDERS_URL ?? "http://orders:3001";
const inventory = process.env.INVENTORY_URL ?? "http://inventory:3002";
const notifications = process.env.NOTIFICATIONS_URL ?? "http://notifications:3003";
const port = Number(process.env.PORT ?? 3000);

const destination = createDestination({ orders, inventory, notifications });

async function body(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function headers(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

createServer(async (req, res) => {
  headers(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const path = new URL(req.url ?? "/", "http://gateway").pathname;
  if (req.method === "GET" && path === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  const target = destination(req.method ?? "GET", path);
  if (!target) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  try {
    const response = await fetch(target, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: await body(req),
    });
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Service unavailable" }));
  }
}).listen(port, "0.0.0.0", () => console.log(`gateway listening on ${port}`));
