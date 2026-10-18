/**
 * Message shapes exchanged with Zernio's unified inbox API.
 *
 * Outbound messages are platform-neutral intents (`OutboundMessage`);
 * `buildSendBodies` renders each one natively where the platform supports it
 * and degrades it to text elsewhere. Inbound webhooks are reduced to
 * `ZernioWebhookEvent` by `normalizeZernioWebhook`.
 */

/** Every platform Zernio's inbox can carry a conversation on. */
export type Platform =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "telegram"
  | "sms"
  | "rcs"
  | "twitter"
  | "bluesky"
  | "reddit"
  | "slack"
  | "tiktok"
  | "imessage";

/** Where a message goes: the conversation, the connected account, its platform. */
export type SendTarget = {
  conversationId: string;
  accountId: string | undefined;
  platform: Platform;
};

// ─── Outbound ───

export type ReplyButton = { id: string; title: string };

export type ListRow = { id: string; title: string; description?: string };

export type ListSection = { title?: string; rows: ListRow[] };

export type MediaKind = "image" | "video" | "audio" | "file";

/** Media header of a button message (WhatsApp only; ignored elsewhere). */
export type HeaderMedia = { kind: "image" | "video" | "file"; url: string };

export type CardButton =
  | { type: "postback"; id: string; title: string }
  | { type: "url"; title: string; url: string };

export type CarouselCard = {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: CardButton[];
};

export type ContactCard = {
  name: { formatted_name: string; first_name?: string; last_name?: string };
  phones?: Array<{ phone?: string; type?: string }>;
  emails?: Array<{ email?: string; type?: string }>;
};

export type OutboundMessage =
  | { type: "text"; text: string; linkPreview?: boolean }
  /** Up to 3 reply buttons. */
  | { type: "buttons"; text: string; buttons: ReplyButton[]; header?: HeaderMedia }
  /**
   * A choice among rows. WhatsApp list (≤10 rows), Messenger/Instagram quick
   * replies (≤13), Telegram inline keyboard, numbered text elsewhere.
   */
  | {
      type: "list";
      text: string;
      buttonLabel: string;
      sections: ListSection[];
      header?: string;
      footer?: string;
    }
  /** A single button that opens a URL. */
  | {
      type: "ctaUrl";
      text: string;
      buttonTitle: string;
      url: string;
      header?: string;
      footer?: string;
    }
  /** Native "Send location" button (WhatsApp); text elsewhere. */
  | { type: "locationRequest"; text: string }
  /** A location pin (WhatsApp, iMessage); a Maps link elsewhere. */
  | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | {
      type: "media";
      kind: MediaKind;
      url: string;
      caption?: string;
      /** WhatsApp document display name (kind "file"). */
      fileName?: string;
      /** WhatsApp / iMessage voice note (kind "audio"). */
      voiceNote?: boolean;
    }
  /** Cards with image and buttons (Messenger/Instagram generic template); text elsewhere. */
  | { type: "carousel"; text?: string; cards: CarouselCard[] }
  /** Approved WhatsApp template: the only shape WhatsApp accepts outside the 24h window. */
  | {
      type: "template";
      name: string;
      language: string;
      components?: Array<Record<string, unknown>>;
    }
  | { type: "contacts"; contacts: ContactCard[] };

export type MetaMessageTag =
  | "CONFIRMED_EVENT_UPDATE"
  | "POST_PURCHASE_UPDATE"
  | "ACCOUNT_UPDATE"
  | "HUMAN_AGENT";

export type SendOptions = {
  /** Quote-reply to this platform message id (WhatsApp wamid, Telegram id; Slack threads). */
  replyTo?: string;
  /**
   * WhatsApp Direct Send: deliver a text or interactive message as a UTILITY
   * message outside the 24h window, without a pre-approved template.
   * Ignored on other platforms.
   */
  utility?: boolean;
  /**
   * Messenger / Instagram: message tag for sending outside the 24h window
   * (Instagram accepts HUMAN_AGENT only). Ignored on other platforms.
   */
  messageTag?: MetaMessageTag;
};

export type SendResult =
  | { ok: true; messageId: string | null; messageIds: string[] }
  | { ok: false; status: number; error: string };

// ─── Starting a conversation ───

/** Media that replaces a template's approved header asset for one send. */
export type TemplateHeaderMedia = {
  type: "image" | "video" | "document";
  /** Public URL (or `id`: a Meta media id). */
  link?: string;
  id?: string;
  /** Document display name (document headers only). */
  filename?: string;
};

/** Approved WhatsApp template that opens (or reopens) a conversation. */
export type TemplateSend = {
  name: string;
  /** Language code of the approved variant, e.g. "fr" or "en_US". */
  language: string;
  /**
   * Variable values, one flat list in template order: text-header variables,
   * then body variables, then one per dynamic URL button (see
   * `WhatsAppTemplate.params`). Media headers take no value here.
   */
  params?: string[];
  /** Overrides the approved header asset for this send. */
  headerMedia?: TemplateHeaderMedia;
  /** Required by templates whose header is a LOCATION. */
  headerLocation?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Values for copy-code, flow or URL buttons, by position in the template. */
  buttonParams?: Array<{ index: number; subType: "url" | "copy_code" | "flow"; value: string }>;
};

/**
 * A message to someone the account has no conversation with yet (or whose
 * WhatsApp 24h window is closed). On WhatsApp it must be an approved
 * `template`, or `text` with `utility` (Direct Send).
 */
export type StartConversationArgs = {
  accountId: string;
  platform: Platform;
  /**
   * WhatsApp / SMS: phone number in international format ("+33 6 12 34 56 78"
   * is sent as "33612345678"). X: numeric user id. Slack: member id.
   * iMessage: "+" phone or email. Give either `to` or `username`.
   */
  to?: string;
  /** X or Bluesky handle, Reddit username. */
  username?: string;
  text?: string;
  template?: TemplateSend;
  /** WhatsApp Direct Send: `text` as a UTILITY message, without a template. */
  utility?: boolean;
};

export type StartConversationResult =
  | { ok: true; conversationId: string; messageId: string | null }
  /** `code` is Zernio's error code when it gives one (TEMPLATE_REQUIRED, recipient_opted_out…). */
  | { ok: false; status: number; error: string; code?: string };

/** One value a template takes, in the order `TemplateSend.params` expects. */
export type WhatsAppTemplateParam = {
  part: "header" | "body" | "button";
  /** Placeholder name: "1", "2"… or a named one ("first_name"); the button's text for buttons. */
  name: string;
};

/** A WhatsApp template as Zernio lists it, flattened for pickers and previews. */
export type WhatsAppTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  /** TEXT, IMAGE, VIDEO, DOCUMENT or LOCATION when the template has a header. */
  headerFormat?: string;
  headerText?: string;
  body: string;
  footer?: string;
  buttons: Array<{ type: string; text: string; url?: string }>;
  params: WhatsAppTemplateParam[];
};

// ─── Inbound ───

export type AttachmentCategory = "image" | "audio" | "video" | "document" | "sticker" | "other";

export type InboundAttachment = {
  /** Raw attachment type as sent by Zernio. */
  type: string;
  category: AttachmentCategory;
  /** Media URL. On WhatsApp it points at Zernio and needs the API key. */
  url: string;
  mimeType?: string;
  /** WhatsApp audio: true for a voice note recorded in the client. */
  voice?: boolean;
};

export type InboundLocation = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

/**
 * A tap on something the bot sent, whatever the platform:
 * - `button` / `list` / `flow`: WhatsApp interactive replies
 * - `templateButton`: WhatsApp template quick-reply button
 * - `quickReply` / `postback`: Messenger and Instagram
 * - `callback`: Telegram inline keyboard
 */
export type InboundReply = {
  kind: "button" | "list" | "flow" | "templateButton" | "quickReply" | "postback" | "callback";
  /** The id / payload set when the message was sent. */
  id?: string;
  /** The label the user tapped, as echoed back. */
  title?: string;
  /** WhatsApp list rows: description echoed on the second line of the text. */
  description?: string;
  /** WhatsApp Flow / address submissions. */
  flowResponse?: Record<string, unknown>;
  nfmReplyName?: string;
};

export type InboundSender = {
  /** Platform identifier; on WhatsApp, the phone number without "+" when known. */
  id: string;
  name?: string;
  username?: string;
  /** WhatsApp E.164 phone number (nullable since the BSUID rollout). */
  phoneNumber?: string;
  /** WhatsApp business-scoped user id. */
  businessScopedUserId?: string;
};

type EventBase = {
  event: string;
  eventId?: string;
  /** True for samples sent by POST /v1/webhooks/test. */
  test: boolean;
  raw: unknown;
};

/** `message.received` (direction incoming) and `message.sent` (outgoing). */
export type InboundMessage = EventBase & {
  kind: "message";
  platform: string;
  direction: "incoming" | "outgoing";
  accountId: string;
  conversationId: string;
  /** Zernio internal message id (used for reactions). */
  messageId: string;
  /** Platform message id (WhatsApp wamid, used for quote replies). */
  platformMessageId?: string;
  text: string;
  sender: InboundSender;
  attachments: InboundAttachment[];
  location?: InboundLocation;
  reply?: InboundReply;
  /** Platform id of the message this one quote-replies to. */
  quotedMessageId?: string;
  /** Click-to-WhatsApp / ig.me / m.me referral data, forwarded verbatim. */
  referral?: Record<string, unknown>;
};

/** `message.delivered`, `message.read`, `message.played`, `message.failed`. */
export type MessageStatusEvent = EventBase & {
  kind: "status";
  status: "delivered" | "read" | "played" | "failed";
  platform: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  platformMessageId?: string;
  error?: { code?: number; title?: string; message?: string; explanation?: string | null };
};

/** `reaction.received`. */
export type ReactionEvent = EventBase & {
  kind: "reaction";
  platform: string;
  accountId: string;
  conversationId: string;
  /** Empty when a WhatsApp reaction is removed (Meta does not say which). */
  emoji: string;
  action: "added" | "removed";
  messageId?: string;
  platformMessageId: string;
  sender: InboundSender;
};

/** `comment.received` (Instagram, Facebook, Bluesky, Reddit, TikTok, X, YouTube, LinkedIn, Threads). */
export type CommentEvent = EventBase & {
  kind: "comment";
  platform: string;
  accountId: string;
  commentId: string;
  /** Zernio post id, or the platform post id for posts not published via Zernio. */
  postId: string;
  platformPostId: string;
  text: string;
  author: { id: string; name?: string; username?: string; isOwnAccount?: boolean };
  isReply: boolean;
  parentCommentId?: string;
};

/** `conversation.started`. */
export type ConversationStartedEvent = EventBase & {
  kind: "conversationStarted";
  platform: string;
  accountId: string;
  conversationId: string;
};

/** `referral.received` (ig.me / m.me link or ad click opening an existing thread). */
export type ReferralEvent = EventBase & {
  kind: "referral";
  platform: string;
  accountId: string;
  conversationId: string;
  referral: Record<string, unknown>;
};

export type OtherEvent = EventBase & { kind: "other" };

export type ZernioWebhookEvent =
  | InboundMessage
  | MessageStatusEvent
  | ReactionEvent
  | CommentEvent
  | ConversationStartedEvent
  | ReferralEvent
  | OtherEvent;
