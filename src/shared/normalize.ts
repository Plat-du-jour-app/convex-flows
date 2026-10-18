import { EVENT_ID_HEADER } from "./signature.js";
import type {
  AttachmentCategory,
  InboundAttachment,
  InboundLocation,
  InboundMessage,
  InboundReply,
  InboundSender,
  MessageStatusEvent,
  ZernioWebhookEvent,
} from "./types.js";

type Rec = Record<string, unknown>;

const AUDIO_TYPES = new Set(["audio", "voice", "ptt", "voice_note", "voicenote"]);
const DOCUMENT_TYPES = new Set(["file", "document"]);
const OUTGOING_DIRECTIONS = new Set(["outgoing", "out", "outbound"]);
const STATUS_EVENTS: Record<string, MessageStatusEvent["status"]> = {
  "message.delivered": "delivered",
  "message.read": "read",
  "message.played": "played",
  "message.failed": "failed",
};

/** Zernio's text rendering of a shared location: `Location: <name> (<lat>, <lng>)`. */
const LOCATION_TEXT = /^Location:\s*(.*?)\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)$/;

/**
 * Reduces any Zernio inbox webhook delivery to a stable, platform-neutral shape.
 *
 * Follows the documented payloads (`message`, `conversation`, `account`,
 * `metadata` at the top level) and keeps the fallbacks for the older Late
 * shapes (`data` wrapper, `participantId`, `isFromMe`, location on the message
 * or as an attachment), so a host can switch to it without losing inputs.
 */
export function normalizeZernioWebhook(body: unknown, headers?: Headers): ZernioWebhookEvent {
  const root = rec(body) ?? {};
  const event = str(root.event) ?? str(root.type) ?? "";
  const base = {
    event,
    eventId: str(root.id) ?? headers?.get(EVENT_ID_HEADER) ?? undefined,
    test: root.test === true || event === "webhook.test",
    raw: body,
  };

  if (event === "message.received" || event === "message.sent") return toMessage(root, base);

  const account = rec(root.account);
  const conversation = rec(root.conversation);
  const accountId = str(account?.id) ?? str(account?.accountId) ?? "";
  const conversationId = str(conversation?.id) ?? "";

  const status = STATUS_EVENTS[event];
  if (status) {
    const message = rec(root.message) ?? {};
    const error = rec(root.error);
    return {
      ...base,
      kind: "status",
      status,
      platform: str(message.platform) ?? str(account?.platform) ?? "",
      accountId,
      conversationId: conversationId || (str(message.conversationId) ?? ""),
      messageId: str(message.id) ?? "",
      platformMessageId: str(message.platformMessageId),
      ...(error
        ? {
            error: {
              code: typeof error.code === "number" ? error.code : undefined,
              title: str(error.title),
              message: str(error.message),
              explanation: typeof error.explanation === "string" ? error.explanation : null,
            },
          }
        : {}),
    };
  }

  if (event === "reaction.received") {
    const reaction = rec(root.reaction) ?? {};
    return {
      ...base,
      kind: "reaction",
      platform: str(account?.platform) ?? str(conversation?.platform) ?? "",
      accountId,
      conversationId,
      emoji: typeof reaction.emoji === "string" ? reaction.emoji : "",
      action: reaction.action === "removed" ? "removed" : "added",
      messageId: str(reaction.messageId),
      platformMessageId: str(reaction.platformMessageId) ?? "",
      sender: toSender(rec(reaction.sender) ?? {}),
    };
  }

  if (event === "comment.received") {
    const comment = rec(root.comment) ?? {};
    const author = rec(comment.author) ?? {};
    const platformPostId = str(comment.platformPostId) ?? str(rec(root.post)?.platformPostId) ?? "";
    return {
      ...base,
      kind: "comment",
      platform: str(comment.platform) ?? str(account?.platform) ?? "",
      accountId,
      commentId: str(comment.id) ?? "",
      postId: str(comment.postId) ?? platformPostId,
      platformPostId,
      text: str(comment.text) ?? "",
      author: {
        id: str(author.id) ?? "",
        name: str(author.name),
        username: str(author.username),
        ...(typeof author.isOwnAccount === "boolean" ? { isOwnAccount: author.isOwnAccount } : {}),
      },
      isReply: comment.isReply === true,
      parentCommentId: str(comment.parentCommentId),
    };
  }

  if (event === "conversation.started") {
    return {
      ...base,
      kind: "conversationStarted",
      platform: str(conversation?.platform) ?? str(account?.platform) ?? "",
      accountId,
      conversationId,
    };
  }

  if (event === "referral.received") {
    return {
      ...base,
      kind: "referral",
      platform: str(account?.platform) ?? str(conversation?.platform) ?? "",
      accountId,
      conversationId,
      referral: rec(root.referral) ?? {},
    };
  }

  return { ...base, kind: "other" };
}

function toMessage(
  root: Rec,
  base: { event: string; eventId?: string; test: boolean; raw: unknown },
): InboundMessage {
  const msg = rec(root.data) && !rec(root.message) ? rec(root.data)! : root;
  const nested = rec(msg.message);
  const msgData = nested ?? msg;
  const account = rec(msg.account);
  const conversation = rec(msg.conversation);
  const metadata = rec(root.metadata) ?? rec(msg.metadata) ?? {};
  const sender = rec(msg.sender) ?? rec(nested?.sender) ?? {};

  const text = str(nested?.text) ?? str(msg.text) ?? "";
  const rawAttachments = arr(nested?.attachments) ?? arr(msg.attachments) ?? [];
  const attachments = rawAttachments.map(rec).filter(isDefined).map(toAttachment);

  const direction =
    nested?.isFromMe === true ||
    msg.isFromMe === true ||
    OUTGOING_DIRECTIONS.has(str(nested?.direction) ?? str(msg.direction) ?? "") ||
    (base.event === "message.sent" && !nested?.direction)
      ? "outgoing"
      : "incoming";

  return {
    ...base,
    kind: "message",
    platform:
      str(nested?.platform) ??
      str(account?.platform) ??
      str(msg.platform) ??
      str(conversation?.platform) ??
      "",
    direction,
    accountId: str(account?.id) ?? str(msg.accountId) ?? str(conversation?.accountId) ?? "",
    conversationId:
      str(msg.conversationId) ?? str(conversation?.id) ?? str(nested?.conversationId) ?? "",
    messageId: str(nested?.id) ?? str(msg.messageId) ?? "",
    platformMessageId: str(nested?.platformMessageId),
    text,
    sender: toSender(sender),
    attachments,
    location: findLocation(metadata, msgData, rawAttachments, text),
    reply: toReply(metadata, text),
    quotedMessageId: str(metadata.quotedMessageId),
    referral: rec(metadata.referral),
  };
}

function toSender(sender: Rec): InboundSender {
  return {
    id: str(sender.participantId) ?? str(sender.id) ?? "",
    name: str(sender.participantName) ?? str(sender.name),
    username: str(sender.username),
    phoneNumber: str(sender.phoneNumber),
    businessScopedUserId: str(sender.businessScopedUserId),
  };
}

function toAttachment(a: Rec): InboundAttachment {
  const type = (str(a.type) ?? "").toLowerCase();
  const mimeType = str(a.mimeType) ?? str(a.mimetype) ?? str(a.mime_type);
  const payload = rec(a.payload);
  return {
    type,
    category: categorize(type, mimeType ?? ""),
    url: str(a.url) ?? str(a.id) ?? "",
    mimeType,
    ...(typeof payload?.voice === "boolean" ? { voice: payload.voice } : {}),
  };
}

function categorize(type: string, mime: string): AttachmentCategory {
  if (type === "image" || mime.startsWith("image/")) return "image";
  if (AUDIO_TYPES.has(type) || mime.startsWith("audio/")) return "audio";
  if (type === "video" || mime.startsWith("video/")) return "video";
  if (type === "sticker") return "sticker";
  if (DOCUMENT_TYPES.has(type)) return "document";
  return "other";
}

function findLocation(
  metadata: Rec,
  msgData: Rec,
  rawAttachments: unknown[],
  text: string,
): InboundLocation | undefined {
  const fromObject =
    toLocation(rec(metadata.location)) ??
    toLocation(rec(msgData.location)) ??
    toLocation(rawAttachments.map(rec).find((a) => a?.type === "location")) ??
    toLocation(msgData);
  if (fromObject) return fromObject;

  const match = text.trim().match(LOCATION_TEXT);
  if (!match) return undefined;
  return toLocation({ latitude: match[2], longitude: match[3], name: match[1] });
}

function toLocation(o: Rec | undefined): InboundLocation | undefined {
  if (!o) return undefined;
  const latitude = num(o.latitude ?? o.lat);
  const longitude = num(o.longitude ?? o.lng ?? o.lon);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  const name = str(o.name)?.replace(/[\r\n]+/g, " ").trim();
  const address = str(o.address)?.trim();
  return {
    latitude,
    longitude,
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
  };
}

/** Folds the per-platform tap metadata into one `reply`. */
function toReply(metadata: Rec, text: string): InboundReply | undefined {
  const [firstLine, ...rest] = text.split("\n");
  const title = firstLine?.trim() || undefined;

  const interactiveType = str(metadata.interactiveType);
  if (interactiveType === "button_reply") {
    return { kind: "button", id: str(metadata.interactiveId), ...(title ? { title } : {}) };
  }
  if (interactiveType === "list_reply") {
    const description = rest.join("\n").trim();
    return {
      kind: "list",
      id: str(metadata.interactiveId),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
  }
  if (interactiveType === "nfm_reply") {
    return {
      kind: "flow",
      ...(rec(metadata.flowResponseData) ? { flowResponse: rec(metadata.flowResponseData) } : {}),
      ...(str(metadata.nfmReplyName) ? { nfmReplyName: str(metadata.nfmReplyName) } : {}),
    };
  }
  if (str(metadata.buttonPayload)) {
    return { kind: "templateButton", id: str(metadata.buttonPayload), ...(title ? { title } : {}) };
  }
  if (str(metadata.postbackPayload)) {
    const postbackTitle = str(metadata.postbackTitle) ?? title;
    return { kind: "postback", id: str(metadata.postbackPayload), ...(postbackTitle ? { title: postbackTitle } : {}) };
  }
  if (str(metadata.quickReplyPayload)) {
    return { kind: "quickReply", id: str(metadata.quickReplyPayload), ...(title ? { title } : {}) };
  }
  if (str(metadata.callbackData)) {
    return { kind: "callback", id: str(metadata.callbackData), ...(title ? { title } : {}) };
  }
  return undefined;
}

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** Non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}
