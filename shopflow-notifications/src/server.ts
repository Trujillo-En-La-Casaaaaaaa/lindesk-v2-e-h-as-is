import { createServer as createHttpServer, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { fail, json, jsonBody } from "./http.js";
import { buildOrderCancellation, buildOrderConfirmation } from "./messages.js";

export type ServerOptions = {
  providerUrl?: string;
};

export function createServer(options: ServerOptions = {}): Server {
  const providerUrl = options.providerUrl ?? process.env.PROVIDER_URL ?? "http://notification-provider:3004";

  async function provider(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${providerUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error("Notification provider failed"), { status: 502 });
    return body;
  }

  async function forwardMessage(message: unknown, res: ServerResponse): Promise<void> {
    const result = await provider("/messages", { method: "POST", body: JSON.stringify(message) });
    json(res, 201, result);
  }

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://notifications");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/notifications/order-confirmation") {
        const body = await jsonBody(req);
        return await forwardMessage(buildOrderConfirmation(body), res);
      }
      if (req.method === "POST" && url.pathname === "/notifications/order-cancellation") {
        const body = await jsonBody(req);
        return await forwardMessage(buildOrderCancellation(body), res);
      }
      if (req.method === "GET" && url.pathname === "/notifications") {
        return json(res, 200, await provider("/messages"));
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      fail(res, error);
    }
  });
}

export function start(options: ServerOptions & { port?: number } = {}): Server {
  const port = options.port ?? Number(process.env.PORT ?? 3003);
  const server = createServer(options);
  server.listen(port, "0.0.0.0", () => console.log(`notifications listening on ${port}`));
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();
