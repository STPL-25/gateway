import express from "express";
import { createServer } from "node:http";
import { createProxyMiddleware, fixRequestBody, responseInterceptor } from "http-proxy-middleware";
import cookieParser from "cookie-parser";
// Redis integration commented out — will be reintegrated later.
// import { createClient } from "redis";
import { configDotenv } from "dotenv";
import { decryptRequestBody, encryptJson } from "./Middleware/payloadCrypto.js";
configDotenv({ path: `.env.${process.env.NODE_ENV || "development"}` });

const PORT = parseInt(process.env.PORT || "8080");
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8081";
const GRN_SERVICE_URL = process.env.GRN_SERVICE_URL ;
const NOTIFY_SERVICE_URL = process.env.NOTIFY_SERVICE_URL || "http://localhost:8086";
const SESSION_SECRET = process.env.SESSION_SECRET;
const FORWARDED_PROTO =
  (process.env.FORWARDED_PROTO || (process.env.NODE_ENV === "production" ? "https" : "")).toLowerCase();
const SERVICE_NAME = "gateway";

if (!SESSION_SECRET) {
  console.error(`[${SERVICE_NAME}] SESSION_SECRET is required (must match the backend's) — exiting`);
  process.exit(1);
}

// Paths owned by grn-service; everything else goes to the backend monolith
const GRN_PATHS = ["/api/grn", "/api/gate_entry", "/api/inventory", "/api/stock_request", "/api/supplier", "/api/service_entry", "/api/invoice", "/api/payment", "/api/asset_management", '/grnhealth'];
const isGrnPath = (path) => GRN_PATHS.some((p) => path === p || path.startsWith(p + "/"));

// Paths owned by notification-service — only the browser-facing bell
// dropdown (GET/POST/PATCH/DELETE /api/notifications*). Its email-sending
// routes (/api/notify/email/*) are service-to-service only and are called
// directly by backend-stpl/grn-service, bypassing the gateway entirely.
const NOTIFY_PATHS = ["/api/notifications"];
const isNotifyPath = (path) => NOTIFY_PATHS.some((p) => path === p || path.startsWith(p + "/"));

// Stateless services (grn-service, notification-service) both need the
// cookie->bearer bridge below.
const isStatelessServicePath = (path) => isGrnPath(path) || isNotifyPath(path);
const pathnameOf = (path = "") => path.split("?")[0];
const isSocketIoPath = (path = "") => {
  const pathname = pathnameOf(path);
  return pathname === "/socket.io" || pathname.startsWith("/socket.io/");
};

// ----------------------------
// REDIS — read-only access to the backend's session store (sess:* keys)
// Redis integration commented out — will be reintegrated later.
// ----------------------------
// const redisClient = createClient({
//   socket: {
//     host: process.env.REDIS_HOST || "localhost",
//     port: parseInt(process.env.REDIS_PORT || "6379"),
//     reconnectStrategy: (retries) => {
//       if (retries > 10) return new Error("Redis connection failed after 10 retries");
//       return Math.min(retries * 50, 500);
//     },
//   },
//   // password: process.env.REDIS_PASSWORD,
// });
// redisClient.on("error", (err) => console.error(`[${SERVICE_NAME}] Redis error:`, err.message));
// await redisClient.connect();
// console.log(`[${SERVICE_NAME}] Redis connected`);
const redisClient = null;

// ----------------------------
// APP
//
// JSON bodies are parsed so the payload-crypto layer can decrypt them; the
// parser is a no-op for other content types (multipart/form-data streams
// straight through untouched for the proxies/multer downstream).
// ----------------------------
const app = express();
const server = createServer(app);
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ----------------------------
// SOCKET.IO PROXY — mounted first, ahead of the body parser and the
// payload-crypto layer.
//
// Engine.IO must not go through onProxyReq/onProxyRes: responseInterceptor
// buffers the whole response, which breaks long-polling (a held-open stream),
// and it re-encrypts application/json bodies into the { d, iv } envelope,
// which turns Engine.IO's own error/handshake payloads into garbage the
// socket.io client cannot parse.
// ----------------------------
const socketProxy = createProxyMiddleware({
  target: BACKEND_URL,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  pathFilter: isSocketIoPath,
});
app.use(socketProxy);

app.use(express.json({ limit: "50mb" }));

app.use((req, _res, next) => {
  const rawProto = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(rawProto) ? rawProto[0] : rawProto;
  req.clientProto = FORWARDED_PROTO || forwardedProto?.split(",")[0]?.trim().toLowerCase() || req.protocol;
  next();
});

// Unsigns the express-session cookie (name "sessionId") with the shared SESSION_SECRET
app.use(cookieParser(SESSION_SECRET));

// Routes that never carry encrypted payloads (Basic Auth login/signup, health, docs,
// and the whole supplier portal — an external-facing client that talks plain JSON,
// including its own staff-triggered /invite endpoint) —
// mirrors the skip-list in frontend/src/main.tsx's request interceptor.
// /api/public_kyc is the anonymous self-service KYC intake (/supplier_kyc) —
// no session/Web-Crypto key exists for a first-time visitor, same reasoning
// as /api/nonstaff.
const CRYPTO_EXEMPT_PATHS = ["/api/secure", "/api/supplier", "/api/nonstaff", "/api/nonstaff_approval", "/api/public_kyc", "/api-docs", "/gateway/health", "/health"];
const isCryptoExempt = (path) =>
  isSocketIoPath(path) || CRYPTO_EXEMPT_PATHS.some((p) => path === p || path.startsWith(p + "/"));

app.use((req, res, next) => (isCryptoExempt(req.path) ? next() : decryptRequestBody(req, res, next)));

// ----------------------------
// GATEWAY HEALTH — aggregates downstream services
// ----------------------------
async function probe(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? "up" : `error (${res.status})`;
  } catch {
    return "down";
  }
}

app.get("/gateway/health", async (_req, res) => {
  const [backend, grn, notify] = await Promise.all([
    probe(`${BACKEND_URL}/health`),
    probe(`${GRN_SERVICE_URL}/health`),
    probe(`${NOTIFY_SERVICE_URL}/health`),
  ]);
  // Redis integration commented out — will be reintegrated later.
  // const redis = redisClient.isReady ? "up" : "down";
  const allUp = backend === "up" && grn === "up" && notify === "up";
  res.status(allUp ? 200 : 503).json({
    service: SERVICE_NAME,
    status: "up",
    timestamp: new Date().toISOString(),
    downstream: {
      backend: { url: BACKEND_URL, status: backend },
      "grn-service": { url: GRN_SERVICE_URL, status: grn },
      "notification-service": { url: NOTIFY_SERVICE_URL, status: notify },
    },
  });
});

// ----------------------------
// SESSION → BEARER BRIDGE (stateless downstream services: grn-service,
// notification-service)
//
// The browser only holds the HttpOnly "sessionId" cookie; the JWT lives
// server-side in the backend's session. Stateless services expect
// `Authorization: Bearer <jwt>`, so the gateway asks the backend to resolve
// the cookie to its JWT (Redis-shared-store approach is commented out for
// now) and injects the header.
// ----------------------------
async function sessionToBearer(req, _res, next) {
  // An explicit Authorization header (e.g. dev bypass token, service-to-service
  // call) always wins — only bridge when the caller relies on the cookie.
  if (req.headers.authorization) return next();

  const sid = req.signedCookies?.sessionId;
  if (!sid) return next(); // no session — let grn-service answer 401

  try {
    const resp = await fetch(`${BACKEND_URL}/internal/session-jwt`, {
      headers: { cookie: req.headers.cookie },
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const { jwt } = await resp.json();
      if (jwt) req.headers.authorization = `Bearer ${jwt}`;
    }
  } catch (err) {
    console.error(`[${SERVICE_NAME}] session lookup failed:`, err.message);
  }
  next();
}

app.use((req, res, next) => (isStatelessServicePath(req.path) ? sessionToBearer(req, res, next) : next()));

// ----------------------------
// PAYLOAD CRYPTO ↔ PROXY WIRING
//
// onProxyReq: req.body was decrypted (and re-parsed by express.json) above;
// fixRequestBody re-serializes it onto the proxied request. Only called when
// there's an actual parsed body — otherwise GET/DELETE requests would gain a
// spurious "{}" body.
// onProxyRes: buffers the downstream JSON response and re-encrypts it into
// the { d, iv } envelope the frontend expects, via selfHandleResponse.
// ----------------------------
function onProxyReq(proxyReq, req) {
  if (req.clientProto) {
    proxyReq.setHeader("x-forwarded-proto", req.clientProto);
  }

  // req.body is only set by express.json() when the request actually carried
  // a JSON body — including a legitimate empty object "{}" (e.g. no-param
  // POST endpoints like getSignUpEmployee). Re-check on key count wrongly
  // skipped those, leaving the original (already-drained-by-body-parser)
  // request stream to be piped with a stale Content-Length, which hangs the
  // proxied request forever waiting for bytes that never arrive.
  if (req.body !== undefined) {
    fixRequestBody(proxyReq, req);
  }
}

const onProxyRes = responseInterceptor(async (responseBuffer, proxyRes, req) => {
  const contentType = proxyRes.headers["content-type"] || "";
  const requestPath = req.path || req.originalUrl || req.url || "";
  if (!contentType.includes("application/json") || isCryptoExempt(requestPath)) {
    return responseBuffer;
  }
  try {
    const data = JSON.parse(responseBuffer.toString("utf8"));
    return Buffer.from(JSON.stringify(encryptJson(data)));
  } catch {
    return responseBuffer;
  }
});

// ----------------------------
// PROXIES
// ----------------------------
const grnProxy = createProxyMiddleware({
  target: GRN_SERVICE_URL,
  changeOrigin: true,
  xfwd: true,
  pathFilter: GRN_PATHS,
  selfHandleResponse: true,
  on: { proxyReq: onProxyReq, proxyRes: onProxyRes },
});

const notifyProxy = createProxyMiddleware({
  target: NOTIFY_SERVICE_URL,
  changeOrigin: true,
  xfwd: true,
  pathFilter: NOTIFY_PATHS,
  selfHandleResponse: true,
  on: { proxyReq: onProxyReq, proxyRes: onProxyRes },
});

// Catch-all → backend monolith. Socket.IO is handled by socketProxy above.
const backendProxy = createProxyMiddleware({
  target: BACKEND_URL,
  changeOrigin: true,
  xfwd: true,
  pathFilter: (path) => !isSocketIoPath(path),
  selfHandleResponse: true,
  on: { proxyReq: onProxyReq, proxyRes: onProxyRes },
});

console.log(backendProxy);
app.use(grnProxy);
app.use(notifyProxy);
app.use(backendProxy);

// Socket.IO websocket upgrades bypass Express routing — wire them explicitly
server.on("upgrade", socketProxy.upgrade);

// ----------------------------
// START + GRACEFUL SHUTDOWN
// ----------------------------
server.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  console.log(`[${SERVICE_NAME}]   ${GRN_PATHS.join(", ")} → ${GRN_SERVICE_URL}`);
  console.log(`[${SERVICE_NAME}]   ${NOTIFY_PATHS.join(", ")} → ${NOTIFY_SERVICE_URL}`);
  console.log(`[${SERVICE_NAME}]   everything else (+ websockets) → ${BACKEND_URL}`);
  console.log(`[${SERVICE_NAME}]   health → http://localhost:${PORT}/gateway/health`);
});

async function shutdown(signal) {
  console.log(`[${SERVICE_NAME}] ${signal} received — shutting down`);
  server.close(async () => {
    try {
      // Redis integration commented out — will be reintegrated later.
      // await redisClient.quit();
    } finally {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
