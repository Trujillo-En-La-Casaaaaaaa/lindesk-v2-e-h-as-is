The provided ShopFlow repositories form an existing multi-repository microservices ecosystem.

Implement customer order cancellation while preserving the existing service boundaries, repository responsibilities, data ownership, and external-service integrations.

FUNCTIONAL REQUIREMENTS

A customer must be able to cancel an order that has not been shipped.

Cancellation must:

1. Require a non-empty cancellation reason.
2. Reject a reason longer than 200 characters.
3. Change the order status to CANCELLED.
4. Store cancelledAt.
5. Store cancellationReason.
6. Restore inventory exactly once.
7. Send a cancellation notification.
8. Reject cancellation of SHIPPED orders.
9. Safely handle repeated cancellation requests without restoring inventory twice.
10. Be exposed through the existing frontend and gateway.
11. Include automated tests.

ARCHITECTURAL CONSTRAINTS

Preserve the existing ownership rules:

- shopflow-orders owns order lifecycle and order data.
- shopflow-inventory owns inventory.
- shopflow-notifications owns notification orchestration.
- shopflow-web accesses backend behavior through shopflow-gateway.
- services must not directly modify another service's database.

Preserve all existing functionality.

Do not collapse services.
Do not create additional repositories.
Do not perform unrelated refactoring.
Do not add unrelated functionality.
