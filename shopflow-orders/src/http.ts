import type { IncomingMessage, ServerResponse } from "node:http";

export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function fail(res: ServerResponse, error: unknown): void {
  const value = error as { status?: number; message?: string };
  json(res, value.status ?? 500, { error: value.message ?? "Internal error" });
}
