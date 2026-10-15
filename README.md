# API Gateway — Non-Trade ERP

Single public entry point for backend-stpl, grn-service, notification-service and payment-service. Set the public port and downstream URLs in the gateway environment. Local deployed configurations use ports 8000 / 8001 / 8002 / 8003 / 8004 respectively; code defaults for older services may differ.

| Path | Destination |
|---|---|
| `/api/grn`, `/api/gate_entry`, `/api/inventory`, `/api/stock_request`, `/api/supplier`, `/api/service_entry`, `/api/invoice`, `/api/asset_management`, `/grnhealth` | GRN_SERVICE_URL |
| `/api/notifications` | NOTIFY_SERVICE_URL |
| `/api/payment`, `/paymenthealth` | PAYMENT_SERVICE_URL (default `http://localhost:8004`) |
| `/payment/socket.io` | payment-service Socket.IO, including polling and WebSocket upgrades |
| `/socket.io` | backend-stpl Socket.IO, including polling and WebSocket upgrades |
| `/gateway/health` | gateway; probes backend, GRN, notification and payment readiness |
| Other paths | BACKEND_URL |

Stateless service APIs accept Bearer JWTs. When a request instead carries a signed HttpOnly `sessionId` cookie, the gateway resolves it using backend-stpl's `/internal/session-jwt` endpoint and injects the JWT. Explicit Authorization headers take precedence. Redis session sharing is currently disabled.

JSON requests can carry the existing AES-GCM `{ d, iv }` envelope. The gateway decrypts and reserializes those bodies for services, then encrypts their JSON responses for the browser. Both Socket.IO transports bypass body parsing and encryption so Engine.IO handshakes and long polling remain valid. Multipart bodies stream through. Socket upgrade dispatch chooses the matching service by transport path.

## Run

```powershell
npm ci
# Configure .env (or export process environment variables).
npm run dev
# For normal startup:
npm start
```

`SESSION_SECRET` must match backend-stpl. `CRYPTO_SECRET` and `CRYPTO_SALT` must match the existing application's payload encryption. Configure `BACKEND_URL`, `GRN_SERVICE_URL`, `NOTIFY_SERVICE_URL` and `PAYMENT_SERVICE_URL` for the actual hosts. Existing environment templates are `.env.dev` / `.env.prod`; `../switch-env.ps1` can copy the selected template to `.env`.

Install and migrate payment-service before restarting the updated gateway and GRN service. See [payment-service setup](../payment-service/README.md). The gateway retains all three existing payment endpoint names while routing them to the new owner.
