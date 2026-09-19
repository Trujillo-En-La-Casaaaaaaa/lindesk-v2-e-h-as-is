# ShopFlow — E-H (AS-IS → resultado)

Este repositorio muestra la **evolución** como historial de Git (dos commits):

1. Tag [`as-is`](https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-h-as-is/tree/as-is) — fixture congelado, **antes** de LinDesk.
2. Rama `main` (este árbol) — resultado de LinDesk, corrida `20260918-194744`.

**Diff:** https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-h-as-is/compare/as-is...main

El encargo congelado está en [`TASK.md`](./TASK.md). Este paquete es solo código fuente.

---

# ShopFlow — evolución · complejidad alta (E-H)

Paquete de entrevista (artefacto congelado). Contiene el árbol de ShopFlow del escenario **E-H**. **No es LinDesk**; es el software de dominio que se evalúa.

## Qué es ShopFlow

ShopFlow es una aplicación pequeña de **comercio electrónico / gestión de pedidos**. Es el dominio compartido de los nueve escenarios (no es LinDesk). El comportamiento de negocio previsto es:

1. Catálogo de productos.
2. Inventario (stock).
3. Creación de pedidos.
4. Validar inventario **antes** de aceptar un pedido.
5. Decrementar inventario **después** de un pedido exitoso.
6. Consulta de detalle / estado del pedido.
7. Acción administrativa para marcar un pedido como `SHIPPED`.
8. Notificación de confirmación del pedido.

Según el escenario, se pide además **cancelación de pedido por el cliente** (creación y evolución) o se prohíbe expresamente (migración).

Reglas de cancelación cuando sí aplica:

- el pedido no debe estar `SHIPPED`;
- motivo no vacío y de como máximo 200 caracteres;
- pasar a `CANCELLED`;
- guardar `cancelledAt` y `cancellationReason`;
- restaurar inventario **exactamente una vez**;
- enviar o registrar una notificación de cancelación;
- rechazar cancelar un pedido ya enviado;
- reintentos repetidos no deben restaurar stock dos veces.


## Este escenario (E-H)

| | |
|---|---|
| Código | `E-H` |
| Ciclo de vida | Evolución (se parte de un ecosistema ya existente) |
| Complejidad arquitectónica | Alta — preservar microservicios y dueños de datos |
| Identificador de corrida | `20260918-194744` (solo trazabilidad) |

Baseline **antes** de LinDesk (AS-IS): https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-e-h-as-is

Inspeccione primero el AS-IS y después este resultado.


### Arquitectura pedida

El baseline ya es de seis repositorios. Pedidos, inventario y notificaciones siguen siendo dueños de sus datos. El web entra por el gateway. Los servicios no escriben en la base de otro. No colapsar servicios ni crear repositorios nuevos.

### Encargo (resumen)

Implementar **cancelación de pedido** a través del frontend y el gateway, respetando dueños de datos, con restauración de stock una sola vez y notificación. Preservar lo existente. Sin refactor no relacionado.

El texto **exacto** del encargo está en [`TASK.md`](./TASK.md). Úselo como contrato.

### Carpetas de este árbol

- `shopflow-web/`
- `shopflow-gateway/`
- `shopflow-orders/`
- `shopflow-inventory/`
- `shopflow-notifications/`
- `shopflow-infra/`

## Cómo usarlo en la entrevista

1. Lea primero `TASK.md` (el encargo congelado; está en inglés porque así se le dio al sistema).
2. Recorra los directorios de producto listados arriba. Este paquete es **solo código fuente** (sin `node_modules`, builds ni informes de análisis).
3. Juzgue el código frente al encargo: requisitos funcionales **y** restricciones arquitectónicas. Un sistema que “parece funcionar” pero ignora los límites del escenario no cumple el contrato.
4. No trate este README como veredicto de calidad: es contexto. La puntuación es del experto sobre el código.
5. Etapa B (`AGENTS.md`, grafo C4) **no** está en este repositorio. LinDesk en ejecución se muestra por RDP, aparte de este árbol de GitHub.

