/**
 * API Payload Encryption/Decryption — Gateway
 *
 * Centralizes payload crypto for every request that passes through the
 * gateway: incoming { d, iv } bodies are decrypted here and forwarded to
 * the backend/grn-service as plain JSON; outgoing JSON responses from
 * those services are encrypted back into { d, iv } before reaching the
 * browser. Downstream services never see ciphertext and never need their
 * own crypto layer.
 *
 * Uses AES-256-GCM. The key is derived once at module load via synchronous
 * PBKDF2 — zero per-request key derivation overhead.
 *
 * Must stay in sync with frontend/src/Services/apiCrypto.ts
 */

import crypto from 'crypto';
import { configDotenv } from 'dotenv';
configDotenv();

const API_PAYLOAD_KEY = crypto.pbkdf2Sync(
  process.env.CRYPTO_SECRET,
  process.env.CRYPTO_SALT,
  1000,
  32,
  'sha256'
);

/**
 * Encrypt a JSON-serialisable value.
 * Returns { d: base64(ciphertext+authTag), iv: base64(12-byte-iv) }
 *
 * Concatenates authTag at the END of ciphertext — matches Web Crypto AES-GCM layout
 * so the frontend can decrypt with crypto.subtle.decrypt directly.
 */
export function encryptJson(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', API_PAYLOAD_KEY, iv);
  const text = JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  return {
    d: Buffer.concat([ciphertext, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypt a { d, iv } payload produced by the frontend (or encryptJson).
 * d = base64(ciphertext + 16-byte authTag)
 */
export function decryptJson(payload) {
  const iv = Buffer.from(payload.iv, 'base64');
  const combined = Buffer.from(payload.d, 'base64');

  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', API_PAYLOAD_KEY, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function isEncryptedShape(body) {
  return (
    body &&
    typeof body === 'object' &&
    typeof body.d === 'string' &&
    typeof body.iv === 'string' &&
    Object.keys(body).length === 2
  );
}

/**
 * Express middleware: decrypts req.body in place when it has the { d, iv }
 * shape. Must run after a JSON body parser (e.g. express.json()) and before
 * the proxy so http-proxy-middleware's fixRequestBody can re-serialize the
 * plain body onto the proxied request.
 *
 * Multipart/form-data and unencrypted requests (body parser leaves req.body
 * as {} or undefined, or shaped differently) pass through untouched.
 */
export function decryptRequestBody(req, res, next) {
  if (isEncryptedShape(req.body)) {
    try {
      req.body = decryptJson(req.body);
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid encrypted payload.' });
    }
  }
  next();
}
