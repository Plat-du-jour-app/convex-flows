/**
 * Zernio webhook signatures: `X-Zernio-Signature` (legacy alias
 * `X-Late-Signature`) is the lowercase hex HMAC-SHA256 of the raw request body,
 * keyed by the secret configured on the webhook. Zernio only signs deliveries
 * when the webhook has a secret.
 *
 * Uses Web Crypto so it runs in both Convex runtimes (V8 and Node).
 */

export const SIGNATURE_HEADERS = ["x-zernio-signature", "x-late-signature"] as const;
export const EVENT_ID_HEADER = "x-zernio-event-id";

export function signatureFromHeaders(headers: Headers): string | null {
  for (const name of SIGNATURE_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

export async function computeZernioSignature(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyZernioSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = await computeZernioSignature(secret, rawBody);
  return constantTimeEqual(provided, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
