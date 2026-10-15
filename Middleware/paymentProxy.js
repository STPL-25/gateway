import { createProxyMiddleware } from "http-proxy-middleware";

export const PAYMENT_PATHS = ["/api/payment", "/paymenthealth"];
export const PAYMENT_SOCKET_PATH = "/payment/socket.io";
export const isPaymentPath = (path = "") => {
  const pathname = path.split("?")[0];
  return PAYMENT_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
};
export const isPaymentSocketPath = (path = "") => {
  const pathname = path.split("?")[0];
  return pathname === PAYMENT_SOCKET_PATH || pathname.startsWith(`${PAYMENT_SOCKET_PATH}/`);
};

export function createPaymentSocketProxy(target) {
  return createProxyMiddleware({
    target, changeOrigin: true, xfwd: true,
    pathFilter: isPaymentSocketPath,
    // Upgrade dispatch is explicit in index.js; avoid automatic duplicate listeners.
    ws: false,
    on: { error: (_error, _req, res) => {
      if (typeof res.writeHead === "function" && !res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Payment service unavailable" }));
      } else res.destroy();
    } },
  });
}
