import { describe, expect, it } from "vitest";
import { normalizeZernioWebhook } from "../src/shared/normalize.js";

const account = (platform: string) => ({ id: "acc_1", accountId: "acc_1", platform, username: "brand" });
const conversation = { id: "conv_1", status: "active" };

function dm(platform: string, text: string, metadata?: Record<string, unknown>) {
  return {
    id: "evt_1",
    event: "message.received",
    message: {
      id: "m1",
      conversationId: "conv_1",
      platform,
      platformMessageId: "pm1",
      direction: "incoming",
      text,
      attachments: [],
      sender: { id: "u1", name: "Jane", username: "jane" },
    },
    conversation,
    account: account(platform),
    ...(metadata ? { metadata } : {}),
  };
}

describe("taps on every platform become one `reply`", () => {
  it("Messenger postback", () => {
    const e = normalizeZernioWebhook(
      dm("facebook", "Réserver", { postbackPayload: "book_1", postbackTitle: "Réserver" }),
    );
    expect(e).toMatchObject({ kind: "message", platform: "facebook", reply: { kind: "postback", id: "book_1", title: "Réserver" } });
  });

  it("Instagram quick reply", () => {
    const e = normalizeZernioWebhook(dm("instagram", "Carte", { quickReplyPayload: "carte" }));
    expect(e).toMatchObject({ reply: { kind: "quickReply", id: "carte", title: "Carte" } });
  });

  it("Telegram inline keyboard", () => {
    const e = normalizeZernioWebhook(dm("telegram", "", { callbackData: "photo" }));
    expect(e).toMatchObject({ platform: "telegram", reply: { kind: "callback", id: "photo" } });
  });

  it("WhatsApp Flow submission", () => {
    const e = normalizeZernioWebhook(
      dm("whatsapp", "", { interactiveType: "nfm_reply", flowResponseData: { date: "2026-10-18" }, nfmReplyName: "flow" }),
    );
    expect(e).toMatchObject({ reply: { kind: "flow", flowResponse: { date: "2026-10-18" }, nfmReplyName: "flow" } });
  });

  it("plain DMs on text-only platforms have no reply", () => {
    for (const p of ["bluesky", "reddit", "sms", "imessage", "tiktok", "slack"]) {
      const e = normalizeZernioWebhook(dm(p, "hello"));
      expect(e).toMatchObject({ kind: "message", platform: p, text: "hello" });
      expect(e.kind === "message" && e.reply).toBeFalsy();
    }
  });
});

describe("other inbox events", () => {
  it("message.sent is an outgoing message", () => {
    const e = normalizeZernioWebhook({ ...dm("instagram", "Merci !"), event: "message.sent", message: { ...dm("instagram", "Merci !").message, direction: "outgoing" } });
    expect(e).toMatchObject({ kind: "message", event: "message.sent", direction: "outgoing" });
  });

  it("delivery statuses", () => {
    const e = normalizeZernioWebhook({
      id: "evt_s",
      event: "message.failed",
      message: { id: "m9", conversationId: "conv_1", platform: "whatsapp", platformMessageId: "wamid.9", direction: "outgoing", text: "x", attachments: [] },
      statusAt: "2026-10-17T10:00:00Z",
      error: { code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed", explanation: "Window closed" },
      conversation,
      account: account("whatsapp"),
    });
    expect(e).toEqual({
      event: "message.failed",
      eventId: "evt_s",
      test: false,
      raw: expect.anything(),
      kind: "status",
      status: "failed",
      platform: "whatsapp",
      accountId: "acc_1",
      conversationId: "conv_1",
      messageId: "m9",
      platformMessageId: "wamid.9",
      error: { code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed", explanation: "Window closed" },
    });
    expect(normalizeZernioWebhook({ event: "message.read", message: { id: "m1" }, conversation, account: account("facebook") })).toMatchObject({
      kind: "status",
      status: "read",
      platform: "facebook",
    });
  });

  it("reactions", () => {
    const e = normalizeZernioWebhook({
      id: "evt_r",
      event: "reaction.received",
      reaction: {
        emoji: "❤️",
        action: "added",
        messageId: "m1",
        platformMessageId: "pm1",
        sender: { id: "u1", name: "Jane" },
        reactedAt: "2026-10-17T10:00:00Z",
      },
      conversation,
      account: account("instagram"),
    });
    expect(e).toMatchObject({
      kind: "reaction",
      platform: "instagram",
      conversationId: "conv_1",
      emoji: "❤️",
      action: "added",
      messageId: "m1",
      platformMessageId: "pm1",
      sender: { id: "u1", name: "Jane" },
    });
  });

  it("comments, including posts not published through Zernio", () => {
    const e = normalizeZernioWebhook({
      id: "evt_c",
      event: "comment.received",
      comment: {
        id: "c1",
        postId: null,
        platformPostId: "ig_post_1",
        platform: "instagram",
        text: "MENU",
        author: { id: "u2", username: "foodie", isOwnAccount: false },
        createdAt: "2026-10-17T10:00:00Z",
        isReply: false,
        parentCommentId: null,
      },
      post: { id: null, platformPostId: "ig_post_1", content: null, imageUrl: null, permalink: null },
      account: { id: "acc_1", platform: "instagram", username: "brand" },
    });
    expect(e).toMatchObject({
      kind: "comment",
      platform: "instagram",
      accountId: "acc_1",
      commentId: "c1",
      postId: "ig_post_1",
      platformPostId: "ig_post_1",
      text: "MENU",
      author: { id: "u2", username: "foodie", isOwnAccount: false },
      isReply: false,
    });
  });

  it("conversation.started and referral.received", () => {
    expect(
      normalizeZernioWebhook({ event: "conversation.started", conversation: { id: "conv_2", platform: "telegram" }, account: account("telegram") }),
    ).toMatchObject({ kind: "conversationStarted", platform: "telegram", conversationId: "conv_2" });
    expect(
      normalizeZernioWebhook({ event: "referral.received", referral: { ref: "promo", source: "SHORTLINK" }, conversation, account: account("instagram") }),
    ).toMatchObject({ kind: "referral", referral: { ref: "promo", source: "SHORTLINK" } });
  });

  it("anything else is `other`", () => {
    expect(normalizeZernioWebhook({ event: "post.published" })).toMatchObject({ kind: "other", event: "post.published" });
  });
});
