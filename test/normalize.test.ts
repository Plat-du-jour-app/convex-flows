import { describe, expect, it } from "vitest";
import { normalizeZernioWebhook } from "../src/shared/normalize.js";
import type { InboundMessage } from "../src/shared/types.js";

/** A `message.received` delivery shaped like Zernio's documented payload. */
function delivery(message: Record<string, unknown>, metadata?: Record<string, unknown>) {
  return {
    id: "evt_1",
    event: "message.received",
    message: {
      id: "msg_1",
      conversationId: "conv_1",
      platform: "whatsapp",
      platformMessageId: "wamid.1",
      direction: "incoming",
      text: null,
      attachments: [],
      sender: { id: "33612345678", name: "Léa", phoneNumber: "+33612345678" },
      sentAt: "2026-10-17T10:00:00Z",
      isRead: false,
      ...message,
    },
    conversation: { id: "conv_1", participantId: "33612345678" },
    account: { id: "acc_fr", platform: "whatsapp", username: "pdj" },
    ...(metadata ? { metadata } : {}),
    timestamp: "2026-10-17T10:00:01Z",
  };
}

function asMessage(body: unknown, headers?: Headers): InboundMessage {
  const event = normalizeZernioWebhook(body, headers);
  if (event.kind !== "message") throw new Error(`expected a message, got ${event.kind}`);
  return event;
}

describe("normalizeZernioWebhook", () => {
  it("reads a documented text message", () => {
    const m = asMessage(delivery({ text: "Bonjour" }));
    expect(m).toMatchObject({
      eventId: "evt_1",
      platform: "whatsapp",
      direction: "incoming",
      accountId: "acc_fr",
      conversationId: "conv_1",
      messageId: "msg_1",
      platformMessageId: "wamid.1",
      text: "Bonjour",
      sender: { id: "33612345678", name: "Léa", phoneNumber: "+33612345678" },
      attachments: [],
    });
    expect(m.location).toBeUndefined();
    expect(m.reply).toBeUndefined();
  });

  it("exposes the id and title of a tapped reply button", () => {
    const m = asMessage(
      delivery({ text: "Oui" }, { interactiveType: "button_reply", interactiveId: "yes" }),
    );
    expect(m.text).toBe("Oui");
    expect(m.reply).toEqual({ kind: "button", id: "yes", title: "Oui" });
  });

  it("splits a list reply into title and description", () => {
    const m = asMessage(
      delivery(
        { text: "📸 Photo\nEnvoyer la photo du plat" },
        { interactiveType: "list_reply", interactiveId: "help_photo" },
      ),
    );
    expect(m.reply).toEqual({
      kind: "list",
      id: "help_photo",
      title: "📸 Photo",
      description: "Envoyer la photo du plat",
    });
  });

  it("reads coordinates from metadata.location even when the text is only a preview", () => {
    const m = asMessage(
      delivery(
        { text: "📍 Violette - Glacier" },
        { location: { latitude: 43.8372, longitude: 5.7836, name: "Violette - Glacier" } },
      ),
    );
    expect(m.text).toBe("📍 Violette - Glacier");
    expect(m.location).toEqual({ latitude: 43.8372, longitude: 5.7836, name: "Violette - Glacier" });
  });

  it("parses Zernio's legacy location text", () => {
    const m = asMessage(delivery({ text: "Location: Violette (43.8372, 5.7836)" }));
    expect(m.location).toEqual({ latitude: 43.8372, longitude: 5.7836, name: "Violette" });
  });

  it("parses legacy location text without a name", () => {
    const m = asMessage(delivery({ text: "Location:  (46.0569, 14.5058)" }));
    expect(m.location).toEqual({ latitude: 46.0569, longitude: 14.5058 });
  });

  it("keeps the older Late shapes: data wrapper, participantId, location on the message", () => {
    const m = asMessage({
      event: "message.received",
      data: {
        conversationId: "conv_9",
        accountId: "acc_si",
        platform: "whatsapp",
        sender: { participantId: "38640111222", participantName: "Jan" },
        message: { id: "m9", text: "", location: { lat: "46.05", lng: "14.50" } },
      },
    });
    expect(m).toMatchObject({
      conversationId: "conv_9",
      accountId: "acc_si",
      messageId: "m9",
      sender: { id: "38640111222", name: "Jan" },
      location: { latitude: 46.05, longitude: 14.5 },
    });
  });

  it("reads a location sent as an attachment", () => {
    const m = asMessage(
      delivery({ attachments: [{ type: "location", latitude: 45.1, longitude: 6.2, name: "Ici" }] }),
    );
    expect(m.location).toEqual({ latitude: 45.1, longitude: 6.2, name: "Ici" });
  });

  it("rejects out-of-range coordinates", () => {
    const m = asMessage(delivery({ text: "" }, { location: { latitude: 123, longitude: 5 } }));
    expect(m.location).toBeUndefined();
  });

  it("categorizes attachments like the PdJ bot did", () => {
    const m = asMessage(
      delivery({
        attachments: [
          { type: "image", url: "https://zernio.com/api/v1/whatsapp/media/1", mimeType: "image/jpeg" },
          { type: "audio", url: "https://zernio.com/api/v1/whatsapp/media/2", payload: { voice: true } },
          { type: "file", url: "https://zernio.com/api/v1/whatsapp/media/3", mimeType: "image/png" },
          { type: "file", url: "https://zernio.com/api/v1/whatsapp/media/4", mimeType: "application/pdf" },
          { type: "ptt", url: "u5" },
          { type: "sticker", url: "u6" },
          { type: "video", url: "u7" },
        ],
      }),
    );
    expect(m.attachments.map((a) => a.category)).toEqual([
      "image",
      "audio",
      "image",
      "document",
      "audio",
      "sticker",
      "video",
    ]);
    expect(m.attachments[1]).toMatchObject({ voice: true });
  });

  it("marks outgoing messages", () => {
    expect(asMessage(delivery({ direction: "outgoing", text: "x" })).direction).toBe("outgoing");
    expect(asMessage(delivery({ isFromMe: true, text: "x" })).direction).toBe("outgoing");
  });

  it("keeps template button payloads, quotes and referrals", () => {
    const m = asMessage(
      delivery(
        { text: "Confirmer" },
        {
          buttonPayload: "confirm_resa",
          quotedMessageId: "wamid.0",
          referral: { ctwa_clid: "clid", source_id: "ad1" },
        },
      ),
    );
    expect(m.reply).toEqual({ kind: "templateButton", id: "confirm_resa", title: "Confirmer" });
    expect(m.quotedMessageId).toBe("wamid.0");
    expect(m.referral).toEqual({ ctwa_clid: "clid", source_id: "ad1" });
  });

  it("returns unrelated events as other", () => {
    const e = normalizeZernioWebhook({ id: "evt_2", event: "account.connected", account: {} });
    expect(e).toMatchObject({ kind: "other", event: "account.connected", eventId: "evt_2", test: false });
  });

  it("flags test deliveries", () => {
    expect(normalizeZernioWebhook({ event: "webhook.test" }).test).toBe(true);
    expect(normalizeZernioWebhook({ ...delivery({ text: "x" }), test: true }).test).toBe(true);
  });

  it("falls back to the X-Zernio-Event-Id header", () => {
    const { id: _ignored, ...body } = delivery({ text: "x" });
    const m = asMessage(body, new Headers({ "X-Zernio-Event-Id": "evt_hdr" }));
    expect(m.eventId).toBe("evt_hdr");
  });
});
