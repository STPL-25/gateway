import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Service-to-service relay for Cashfree Verification calls.
// Cashfree only accepts requests from the whitelisted public IP (the gateway's),
// so backend-stpl POSTs { path, body } here and the gateway makes the real call,
// adding the public-key signature (x-cf-signature) when a key is configured.
// Not browser-facing: guarded by a shared token, client id/secret come from the caller.
export const CASHFREE_RELAY_PATH = "/internal/cashfree";

let cachedKey;
function loadPublicKey() {
  if (cachedKey !== undefined) return cachedKey;
  let pem = process.env.CASHFREE_PUBLIC_KEY?.replace(/\\n/g, "\n");
  const p = process.env.CASHFREE_PUBLIC_KEY_PATH;
  console.log(p)
  if (!pem && p) pem = fs.readFileSync(path.resolve(p), "utf8");
  cachedKey = pem || null;
  return cachedKey;
}

function buildSignature(clientId) {
  const key = loadPublicKey();
  if (!key) return null;
  const data = Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`);
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, data).toString("base64");
}

export async function cashfreeRelay(req, res) {
  const token = process.env.CASHFREE_RELAY_TOKEN;
  const given = Buffer.from(String(req.headers["x-internal-token"] || ""));
  const want = Buffer.from(token || "");
  if (!token || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    console.error("[gateway] cashfree relay rejected: bad/missing x-internal-token (check CASHFREE_RELAY_TOKEN on both services)");
    return res.status(401).json({ message: "Unauthorized" });
  }
  const baseUrl = process.env.CASH_FREE_URL;
  const { path: apiPath, body } = req.body || {};
  const clientId = req.headers["x-client-id"];
  const clientSecret = req.headers["x-client-secret"];
  if (!baseUrl || typeof apiPath !== "string" || !apiPath.startsWith("/") || apiPath.includes("..") || !clientId || !clientSecret) {
    return res.status(400).json({ message: "Invalid Cashfree relay request" });
  }

  const headers = { "Content-Type": "application/json", "x-client-id": clientId, "x-client-secret": clientSecret };
  if (req.headers["x-api-version"]) headers["x-api-version"] = req.headers["x-api-version"];
  let signature = null;
  try {
    signature = buildSignature(clientId);
  } catch (e) {
    console.error(`[gateway] cashfree signature failed (key=${process.env.CASHFREE_PUBLIC_KEY_PATH}): ${e.message}`);
  }
  if (signature) headers["x-cf-signature"] = signature;

  console.log(`[gateway] cashfree relay -> ${apiPath} signed=${Boolean(signature)} key=${process.env.CASHFREE_PUBLIC_KEY_PATH || "(none)"}`);
  try {
    const r = await fetch(`${baseUrl}${apiPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text || "Cashfree relay failed" }; }
    if (!r.ok) console.error(`[gateway] cashfree relay <- ${r.status} ${JSON.stringify(data)}`);
    res.status(r.status).json(data);
  } catch (e) {
    console.error(`[gateway] cashfree relay failed: ${e.message}`);
    res.status(502).json({ message: e.message || "Cashfree relay failed" });
  }
}
