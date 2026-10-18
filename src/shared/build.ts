import { capabilitiesOf, type PlatformCapabilities } from "./capabilities.js";
import {
  META_LIMITS as M,
  TELEGRAM_LIMITS as T,
  WHATSAPP_LIMITS as W,
  truncate,
  truncateBytes,
} from "./limits.js";
import type {
  CarouselCard,
  ListSection,
  OutboundMessage,
  ReplyButton,
  SendOptions,
} from "./types.js";

type Body = Record<string, unknown>;

/**
 * The request bodies for one outbound intent. Most messages are a single
 * body; a few platforms need two sends (e.g. TikTok refuses text and image
 * together, Meta carousels cannot carry a text line). `degraded` is true when
 * part of the intent could not be rendered natively and was turned into text.
 */
export type BuiltSend = { bodies: Body[]; degraded: boolean };

type Rendered = { parts: Body[]; degraded: boolean };

/** Kinds Meta accepts as WhatsApp Direct Send utility messages. */
const UTILITY_COMPATIBLE = new Set<OutboundMessage["type"]>(["text", "buttons", "list", "ctaUrl"]);

const LINK_PREVIEW_PLATFORMS = new Set(["whatsapp", "imessage"]);
const META_PLATFORMS = new Set(["facebook", "instagram"]);

/**
 * Builds the JSON bodies for `POST /v1/inbox/conversations/{id}/messages` for
 * the given platform. Labels are truncated to the platform's limits, and
 * anything the platform cannot render is degraded to readable text rather
 * than letting the send fail.
 */
export function buildSendBodies(
  platform: string,
  accountId: string | undefined,
  msg: OutboundMessage,
  opts: SendOptions = {},
): BuiltSend {
  const caps = capabilitiesOf(platform);
  const { parts, degraded } = render(platform, caps, msg);

  const extra: Body = {};
  if (opts.utility && platform === "whatsapp") {
    if (!UTILITY_COMPATIBLE.has(msg.type)) {
      throw new Error(`Direct Send (utility) does not support "${msg.type}" messages`);
    }
    extra.category = "utility";
  }
  if (opts.messageTag && META_PLATFORMS.has(platform)) {
    extra.messagingType = "MESSAGE_TAG";
    extra.messageTag = opts.messageTag;
  }

  const bodies = parts.map((part, i) => ({
    accountId,
    ...part,
    ...extra,
    ...(i === 0 && opts.replyTo ? { replyTo: opts.replyTo } : {}),
  }));
  return { bodies, degraded };
}

function render(platform: string, caps: PlatformCapabilities, msg: OutboundMessage): Rendered {
  const asText = (): Rendered => ({
    parts: [{ message: toPlainText(msg) ?? "" }],
    degraded: msg.type !== "text",
  });
  const isMeta = META_PLATFORMS.has(platform);

  switch (msg.type) {
    case "text":
      return one({
        message: msg.text,
        ...(msg.linkPreview !== undefined && LINK_PREVIEW_PLATFORMS.has(platform)
          ? { linkPreview: msg.linkPreview }
          : {}),
      });

    case "buttons": {
      if (caps.replyButtons === 0) return asText();
      const buttons = msg.buttons.slice(0, caps.replyButtons);
      if (platform === "whatsapp") {
        return one({
          message: msg.text,
          buttons: buttons.map(postbackButton(W.buttonTitle, W.buttonId)),
          ...(msg.header ? { attachmentUrl: msg.header.url, attachmentType: msg.header.kind } : {}),
        });
      }
      // Elsewhere a media header goes out as its own message, just before.
      const header = msg.header ? [{ message: "", attachmentUrl: msg.header.url, attachmentType: msg.header.kind }] : [];
      if (platform === "telegram") {
        return { parts: [...header, { message: msg.text, replyMarkup: inlineKeyboard(buttons) }], degraded: false };
      }
      if (isMeta) {
        return { parts: [...header, metaChoices(caps, msg.text, buttons)], degraded: false };
      }
      return asText();
    }

    case "list": {
      const rows = msg.sections.flatMap((s) => s.rows);
      if (platform === "whatsapp") {
        return one({
          interactive: {
            type: "list",
            ...textHeader(msg.header),
            body: { text: truncate(msg.text, W.interactiveBody) },
            ...footer(msg.footer),
            action: {
              button: truncate(msg.buttonLabel, W.listButton),
              sections: capSections(msg.sections),
            },
          },
        });
      }
      if (caps.listOptions === 0 || rows.length > caps.listOptions) return asText();
      const lost = rows.some((r) => r.description) || !!msg.header || !!msg.footer;
      const options = rows.map((r) => ({ id: r.id, title: r.title }));
      if (platform === "telegram") {
        return { parts: [{ message: msg.text, replyMarkup: inlineKeyboard(options) }], degraded: lost };
      }
      if (isMeta) {
        return {
          parts: [{ message: msg.text, quickReplies: options.map(quickReply) }],
          degraded: lost,
        };
      }
      return asText();
    }

    case "ctaUrl": {
      if (platform === "whatsapp") {
        return one({
          interactive: {
            type: "cta_url",
            ...textHeader(msg.header),
            body: { text: truncate(msg.text, W.interactiveBody) },
            ...footer(msg.footer),
            action: {
              name: "cta_url",
              parameters: { display_text: truncate(msg.buttonTitle, W.ctaDisplayText), url: msg.url },
            },
          },
        });
      }
      if (platform === "telegram") {
        return one({
          message: msg.text,
          replyMarkup: { type: "inline_keyboard", keyboard: [[{ text: msg.buttonTitle, url: msg.url }]] },
        });
      }
      if (isMeta && fitsButtonText(caps, msg.text)) {
        return one({
          message: msg.text,
          buttons: [{ type: "url", title: truncate(msg.buttonTitle, M.buttonTitle), url: msg.url }],
        });
      }
      return asText();
    }

    case "locationRequest":
      if (!caps.locationRequest) return asText();
      return one({
        interactive: {
          type: "location_request_message",
          body: { text: truncate(msg.text, W.interactiveBody) },
          action: { name: "send_location" },
        },
      });

    case "location":
      if (!caps.locationPin) return asText();
      return one({
        location: {
          latitude: msg.latitude,
          longitude: msg.longitude,
          ...(msg.name ? { name: msg.name } : {}),
          ...(msg.address ? { address: msg.address } : {}),
        },
      });

    case "media": {
      if (!caps.attachments) return asText();
      if (!caps.captionWithMedia) {
        // TikTok: one JPG/PNG image per message, never with text.
        if (msg.kind !== "image") return asText();
        const image = { attachmentUrl: msg.url, attachmentType: "image" };
        return { parts: msg.caption ? [image, { message: msg.caption }] : [image], degraded: false };
      }
      return one({
        message: msg.caption ?? "",
        attachmentUrl: msg.url,
        attachmentType: msg.kind,
        ...(msg.fileName && platform === "whatsapp" ? { attachmentName: msg.fileName } : {}),
        ...(msg.voiceNote && (platform === "whatsapp" || platform === "imessage") ? { voiceNote: true } : {}),
      });
    }

    case "carousel": {
      if (!caps.carousel) return asText();
      const template = {
        template: { type: "generic", elements: msg.cards.slice(0, M.cards).map(metaCard) },
      };
      return { parts: msg.text ? [{ message: msg.text }, template] : [template], degraded: false };
    }

    case "template":
      if (!caps.templates) {
        throw new Error(`Message templates are WhatsApp-only (platform: ${platform || "unknown"})`);
      }
      return one({
        template: {
          elements: [
            {
              name: msg.name,
              language: msg.language,
              ...(msg.components ? { components: msg.components } : {}),
            },
          ],
        },
      });

    case "contacts":
      if (!caps.contacts) return asText();
      return one({ contacts: msg.contacts });
  }
}

function one(part: Body): Rendered {
  return { parts: [part], degraded: false };
}

function postbackButton(titleMax: number, payloadMax: number) {
  return (b: ReplyButton) => ({
    type: "postback",
    title: truncate(b.title, titleMax),
    payload: truncate(b.id, payloadMax),
  });
}

function quickReply(b: ReplyButton) {
  return { title: truncate(b.title, M.quickReplyTitle), payload: truncate(b.id, M.payload) };
}

/** Meta: a button template when the text fits, quick replies otherwise. */
function metaChoices(caps: PlatformCapabilities, text: string, buttons: ReplyButton[]): Body {
  return fitsButtonText(caps, text)
    ? { message: text, buttons: buttons.map(postbackButton(M.buttonTitle, M.payload)) }
    : { message: text, quickReplies: buttons.map(quickReply) };
}

function fitsButtonText(caps: PlatformCapabilities, text: string): boolean {
  return caps.buttonTextMax === undefined || Array.from(text).length <= caps.buttonTextMax;
}

function inlineKeyboard(buttons: ReplyButton[]) {
  return {
    type: "inline_keyboard",
    keyboard: buttons.map((b) => [
      { text: b.title, callbackData: truncateBytes(b.id, T.callbackDataBytes) },
    ]),
  };
}

function metaCard(card: CarouselCard) {
  return {
    title: truncate(card.title, M.cardTitle),
    ...(card.subtitle ? { subtitle: truncate(card.subtitle, M.cardSubtitle) } : {}),
    ...(card.imageUrl ? { imageUrl: card.imageUrl } : {}),
    ...(card.buttons?.length
      ? {
          buttons: card.buttons.slice(0, M.buttons).map((b) =>
            b.type === "url"
              ? { type: "url", title: truncate(b.title, M.buttonTitle), url: b.url }
              : { type: "postback", title: truncate(b.title, M.buttonTitle), payload: truncate(b.id, M.payload) },
          ),
        }
      : {}),
  };
}

function textHeader(text: string | undefined): Body {
  return text ? { header: { type: "text", text: truncate(text, W.headerText) } } : {};
}

function footer(text: string | undefined): Body {
  return text ? { footer: { text: truncate(text, W.footerText) } } : {};
}

/** Keeps at most 10 rows in total (WhatsApp's cap across all sections). */
function capSections(sections: ListSection[]) {
  let budget: number = W.listRowsTotal;
  const capped = [];
  for (const section of sections.slice(0, W.listSections)) {
    if (budget <= 0) break;
    const rows = section.rows.slice(0, budget).map((r) => ({
      id: truncate(r.id, W.listRowId),
      title: truncate(r.title, W.listRowTitle),
      ...(r.description ? { description: truncate(r.description, W.listRowDescription) } : {}),
    }));
    budget -= rows.length;
    if (rows.length === 0) continue;
    capped.push({
      ...(section.title ? { title: truncate(section.title, W.listSectionTitle) } : {}),
      rows,
    });
  }
  return capped;
}

/**
 * Plain-text form of a message, used on text-only platforms and when a rich
 * send is rejected. Returns null for templates (no meaningful text form).
 */
export function toPlainText(msg: OutboundMessage): string | null {
  switch (msg.type) {
    case "text":
    case "locationRequest":
      return msg.text;
    case "buttons":
      return numbered(msg.text, msg.buttons.map((b) => b.title));
    case "list":
      return numbered(
        msg.text,
        msg.sections.flatMap((s) => s.rows).map((r) => `${r.title}${r.description ? ` — ${r.description}` : ""}`),
      );
    case "ctaUrl":
      return `${msg.text}\n\n${msg.url}`;
    case "location": {
      const label = [msg.name, msg.address].filter(Boolean).join(", ");
      const link = `https://www.google.com/maps?q=${msg.latitude},${msg.longitude}`;
      return label ? `📍 ${label}\n${link}` : link;
    }
    case "media":
      return msg.caption ? `${msg.caption}\n\n${msg.url}` : msg.url;
    case "carousel": {
      const cards = msg.cards.map((card, i) => {
        const lines = [`${i + 1}. ${card.title}`];
        if (card.subtitle) lines.push(`   ${card.subtitle}`);
        for (const b of card.buttons ?? []) lines.push(b.type === "url" ? `   ${b.title}: ${b.url}` : `   ${b.title}`);
        return lines.join("\n");
      });
      return [msg.text, cards.join("\n\n")].filter(Boolean).join("\n\n");
    }
    case "contacts":
      return msg.contacts
        .map((c) =>
          [
            `👤 ${c.name.formatted_name}`,
            ...(c.phones ?? []).map((p) => `📞 ${p.phone ?? ""}`),
            ...(c.emails ?? []).map((e) => `✉️ ${e.email ?? ""}`),
          ].join("\n"),
        )
        .join("\n\n");
    case "template":
      return null;
  }
}

function numbered(text: string, options: string[]): string {
  if (options.length === 0) return text;
  return `${text}\n\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
}
