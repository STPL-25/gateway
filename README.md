# API Gateway — Non-Trade ERP

Single public entry point (**port 8080**) in front of the two independent services:

```
                         ┌──────────────────────────────┐
 Browser (5173)          │  gateway :8080               │
 VITE_API_URL ─────────► │                              │
                         │  /api/grn                    │      ┌────────────────────┐
   cookie: sessionId     │  /api/gate_entry     ────────┼────► │ grn-service :8084  │
                         │  /api/inventory              │      │ (stateless Bearer) │
                         │   └─ session → Bearer bridge │      └────────────────────┘
                         │                              │
                         │  everything else             │      ┌────────────────────┐
                         │  (/api/*, /api-docs,  ───────┼────► │ backend :8081      │
                         │   /socket.io websockets)     │      │ (session monolith) │
                         └──────────────────────────────┘      └────────────────────┘
```

Both services still run independently on their own ports; the gateway only
routes — it never parses request bodies, so JSON, multipart uploads, and
encrypted `{ d, iv }` payloads stream straight through.

## Session → Bearer bridge

The browser never holds the JWT — it only has the HttpOnly `sessionId`
cookie, while `grn-service` is stateless and expects
`Authorization: Bearer <jwt>`. For the three grn-service path prefixes the
gateway:

1. unsigns the `sessionId` cookie with the shared `SESSION_SECRET`,
2. loads `sess:<sid>` from the shared Redis,
3. injects `Authorization: Bearer <session.jwt>` into the proxied request.

An explicit `Authorization` header on the incoming request (e.g. the dev
bypass token from Postman) is passed through untouched.

## Endpoints

| Path | Destination |
|---|---|
| `/api/grn`, `/api/gate_entry`, `/api/inventory` | grn-service (`GRN_SERVICE_URL`) |
| `/gateway/health` | gateway itself — aggregates downstream `/health` checks |
| everything else, incl. `/socket.io` websockets | backend (`BACKEND_URL`) |

## Run

```bash
npm install
npm run dev      # nodemon
npm start        # node index.js
```

Or from the repo root: `npm run dev` starts backend + grn-service + gateway
together (see root `package.json`).

## Configuration

Copy `.env.example` → `.env`. `SESSION_SECRET` **must** match the backend's,
and Redis must be the same instance the backend stores sessions in.
