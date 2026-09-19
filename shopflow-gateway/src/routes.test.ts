import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDestination } from "./routes.js";

// Distinct hostnames so a route wired to the wrong upstream cannot pass.
const orders = "http://orders.test:3001";
const inventory = "http://inventory.test:3002";
const notifications = "http://notifications.test:3003";

const destination = createDestination({ orders, inventory, notifications });

describe("destination", () => {
  it("maps POST /api/orders/{id}/cancel to orders /orders/{id}/cancel", () => {
    assert.equal(destination("POST", "/api/orders/abc/cancel"), `${orders}/orders/abc/cancel`);
  });

  it("maps POST /api/orders/{id}/ship to orders /orders/{id}/ship (unchanged)", () => {
    assert.equal(destination("POST", "/api/orders/abc/ship"), `${orders}/orders/abc/ship`);
  });

  it("maps GET /api/orders/{id} to orders /orders/{id} (unchanged)", () => {
    assert.equal(destination("GET", "/api/orders/abc"), `${orders}/orders/abc`);
  });

  it("maps POST /api/orders to orders /orders (unchanged)", () => {
    assert.equal(destination("POST", "/api/orders"), `${orders}/orders`);
  });

  it("maps GET /api/products to inventory /products (unchanged)", () => {
    assert.equal(destination("GET", "/api/products"), `${inventory}/products`);
  });

  it("maps GET /api/products/{id} to inventory /products/{id} (unchanged)", () => {
    assert.equal(destination("GET", "/api/products/prod-a"), `${inventory}/products/prod-a`);
  });

  it("maps GET /api/notifications to notifications /notifications (unchanged)", () => {
    assert.equal(destination("GET", "/api/notifications"), `${notifications}/notifications`);
  });

  it("does not map GET /api/orders/{id}/cancel (cancel is POST only)", () => {
    assert.equal(destination("GET", "/api/orders/abc/cancel"), undefined);
  });

  it("does not map GET /api/orders/{id}/ship (ship is POST only)", () => {
    assert.equal(destination("GET", "/api/orders/abc/ship"), undefined);
  });

  it("does not map POST /api/orders/{id} (order detail is GET only)", () => {
    assert.equal(destination("POST", "/api/orders/abc"), undefined);
  });

  it("maps cancel ids with any non-slash id, but not nested paths", () => {
    assert.equal(destination("POST", "/api/orders/9f1/cancel"), `${orders}/orders/9f1/cancel`);
    assert.equal(destination("POST", "/api/orders/abc/cancel/extra"), undefined);
    assert.equal(destination("POST", "/api/orders//cancel"), undefined);
  });

  it("returns undefined for unknown paths", () => {
    assert.equal(destination("POST", "/api/nope"), undefined);
    assert.equal(destination("GET", "/api/nope"), undefined);
    assert.equal(destination("GET", "/api/products/prod-a/extra"), undefined);
  });
});
