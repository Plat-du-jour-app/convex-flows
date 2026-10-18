import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeZernioSignature,
  signatureFromHeaders,
  verifyZernioSignature,
} from "../src/shared/signature.js";

const secret = "s3cr3t";
const body = JSON.stringify({ id: "evt_1", event: "message.received", message: { text: "é 🍽️" } });
const expected = createHmac("sha256", secret).update(body).digest("hex");

describe("Zernio signature", () => {
  it("matches Node's HMAC-SHA256 hex digest", async () => {
    expect(await computeZernioSignature(secret, body)).toBe(expected);
  });

  it("accepts the right signature, with or without sha256= prefix or uppercase", async () => {
    expect(await verifyZernioSignature(secret, body, expected)).toBe(true);
    expect(await verifyZernioSignature(secret, body, `sha256=${expected}`)).toBe(true);
    expect(await verifyZernioSignature(secret, body, expected.toUpperCase())).toBe(true);
  });

  it("rejects a wrong secret, a tampered body and a missing signature", async () => {
    expect(await verifyZernioSignature("other", body, expected)).toBe(false);
    expect(await verifyZernioSignature(secret, `${body} `, expected)).toBe(false);
    expect(await verifyZernioSignature(secret, body, null)).toBe(false);
  });

  it("reads X-Zernio-Signature first, then the legacy X-Late-Signature", () => {
    expect(signatureFromHeaders(new Headers({ "X-Late-Signature": "legacy" }))).toBe("legacy");
    expect(
      signatureFromHeaders(new Headers({ "X-Late-Signature": "legacy", "X-Zernio-Signature": "new" })),
    ).toBe("new");
    expect(signatureFromHeaders(new Headers())).toBeNull();
  });
});
