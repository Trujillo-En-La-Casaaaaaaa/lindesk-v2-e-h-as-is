/**
 * Public route table for the gateway.
 *
 * Pure mapping from the public API surface (method + path) to the upstream
 * URL that serves it. No business rules, no state: the gateway only translates
 * the public contract into single-hop upstream calls.
 */

export interface Upstreams {
  orders: string;
  inventory: string;
  notifications: string;
}

export type Destination = (method: string, path: string) => string | undefined;

export function createDestination({ orders, inventory, notifications }: Upstreams): Destination {
  return (method: string, path: string): string | undefined => {
    if (method === "GET" && path === "/api/products") return `${inventory}/products`;
    if (method === "GET" && /^\/api\/products\/[^/]+$/.test(path)) return `${inventory}${path.slice(4)}`;
    if (method === "POST" && path === "/api/orders") return `${orders}/orders`;
    if (method === "GET" && /^\/api\/orders\/[^/]+$/.test(path)) return `${orders}${path.slice(4)}`;
    if (method === "POST" && /^\/api\/orders\/[^/]+\/ship$/.test(path)) return `${orders}${path.slice(4)}`;
    if (method === "POST" && /^\/api\/orders\/[^/]+\/cancel$/.test(path)) return `${orders}${path.slice(4)}`;
    if (method === "GET" && path === "/api/notifications") return `${notifications}/notifications`;
    return undefined;
  };
}
