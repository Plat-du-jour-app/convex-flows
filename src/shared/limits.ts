/**
 * Platform limits enforced before sending, so a long label is truncated
 * instead of the whole message being rejected.
 */
export const WHATSAPP_LIMITS = {
  replyButtons: 3,
  buttonTitle: 20,
  buttonId: 256,
  listButton: 20,
  listRowsTotal: 10,
  listSections: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listRowId: 200,
  listSectionTitle: 24,
  headerText: 60,
  footerText: 60,
  interactiveBody: 1024,
  ctaDisplayText: 20,
} as const;

export const META_LIMITS = {
  quickReplies: 13,
  quickReplyTitle: 20,
  buttons: 3,
  buttonTitle: 20,
  payload: 1000,
  cards: 10,
  cardTitle: 80,
  cardSubtitle: 80,
} as const;

export const TELEGRAM_LIMITS = {
  /** callback_data is limited to 64 bytes. */
  callbackDataBytes: 64,
} as const;

/**
 * Truncates to `max` characters counted in code points, so an emoji is never
 * cut in half (String#slice counts UTF-16 units and can leave a lone surrogate).
 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let out = "";
  let size = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (size + n > maxBytes) break;
    out += ch;
    size += n;
  }
  return out;
}
