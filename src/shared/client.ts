import { buildSendBodies, buildStartConversationBody, toPlainText } from "./build.js";
import { capabilitiesOf } from "./capabilities.js";
import { summarizeWhatsAppTemplate } from "./templates.js";
import type {
  OutboundMessage,
  ReplyButton,
  SendOptions,
  SendResult,
  SendTarget,
  StartConversationArgs,
  StartConversationResult,
  WhatsAppTemplate,
} from "./types.js";

export const DEFAULT_ZERNIO_BASE_URL = "https://zernio.com/api";

/** Platforms whose conversations land in Zernio's inbox. */
export const INBOX_PLATFORMS: readonly string[] = [
  "whatsapp",
  "instagram",
  "facebook",
  "telegram",
  "twitter",
  "bluesky",
  "reddit",
  "tiktok",
  "slack",
  "sms",
  "rcs",
  "imessage",
];

export type InboxAccount = {
  id: string;
  platform: string;
  /** Display name, or @username, or id. */
  label: string;
  username?: string;
  picture?: string;
  active: boolean;
};

/** Hosts whose media URLs require the Zernio API key. */
const ZERNIO_HOSTS = ["zernio.com", "getlate.dev"];

export type ZernioClientOptions = {
  apiKey: string;
  /** API root without the `/v1` suffix. Defaults to https://zernio.com/api. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Called with a short description whenever Zernio rejects a call. */
  onError?: (label: string, detail: string) => void;
};

/**
 * Thin client over Zernio's inbox endpoints (DMs on every platform, comment
 * replies). Pure fetch, no Convex dependency, so it runs in actions on either
 * runtime and in plain scripts.
 */
export class ZernioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (label: string, detail: string) => void;

  constructor(opts: ZernioClientOptions) {
    if (!opts.apiKey) throw new Error("ZernioClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_ZERNIO_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.onError = opts.onError ?? ((label, detail) => console.log(`Zernio ${label} error:`, detail));
  }

  /**
   * Sends one message, rendered for the target's platform. When the platform
   * needs two sends (see `buildSendBodies`), they go out in order and the
   * first id is returned as `messageId`.
   */
  async send(target: SendTarget, msg: OutboundMessage, opts?: SendOptions): Promise<SendResult> {
    const { bodies } = buildSendBodies(target.platform, target.accountId, msg, opts);
    const path = `/v1/inbox/conversations/${enc(target.conversationId)}/messages`;
    const ids: string[] = [];
    for (const body of bodies) {
      const result = await this.post(path, body, `${target.platform} ${msg.type}`);
      if (!result.ok) return result;
      if (result.messageId) ids.push(result.messageId);
    }
    return { ok: true, messageId: ids[0] ?? null, messageIds: ids };
  }

  /**
   * Sends a rich message and, if Zernio rejects it, falls back to its plain-text
   * form so the user still receives something usable.
   */
  async sendWithFallback(
    target: SendTarget,
    msg: OutboundMessage,
    opts?: SendOptions,
  ): Promise<SendResult> {
    const result = await this.send(target, msg, opts);
    if (result.ok || msg.type === "text") return result;
    const text = toPlainText(msg);
    if (text === null) return result;
    return this.send(target, { type: "text", text }, { replyTo: opts?.replyTo });
  }

  /**
   * Opens a conversation with someone the account has not talked to yet, or
   * reopens one whose WhatsApp 24h window is closed (Zernio reuses the
   * existing conversation with that participant). On WhatsApp, send an
   * approved `template` (see `listWhatsAppTemplates`) or Direct Send text.
   */
  async startConversation(args: StartConversationArgs): Promise<StartConversationResult> {
    const body = buildStartConversationBody(args);
    const result = await this.postJson("/v1/inbox/conversations", body, `${args.platform} start conversation`);
    if (!result.ok) return result;
    const data = (result.json as { data?: { conversationId?: string; messageId?: string } }).data;
    if (!data?.conversationId) {
      const error = `no conversationId in ${JSON.stringify(result.json)}`;
      this.onError(`${args.platform} start conversation`, error);
      return { ok: false, status: 200, error };
    }
    return { ok: true, conversationId: data.conversationId, messageId: data.messageId ?? null };
  }

  /**
   * WhatsApp templates of an account, flattened (see `summarizeWhatsAppTemplate`).
   * Approved ones by default: the only ones a send accepts.
   */
  async listWhatsAppTemplates(
    accountId: string,
    opts: { status?: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED" | "ANY"; name?: string; language?: string } = {},
  ): Promise<WhatsAppTemplate[]> {
    const query = new URLSearchParams({ accountId });
    const status = opts.status ?? "APPROVED";
    if (status !== "ANY") query.set("status", status);
    if (opts.name) query.set("name", opts.name);
    if (opts.language) query.set("language", opts.language);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(`/v1/whatsapp/templates?${query}`), { headers: this.headers() });
    } catch (e) {
      this.onError("templates", e instanceof Error ? e.message : String(e));
      return [];
    }
    if (!response.ok) {
      this.onError("templates", `HTTP ${response.status}`);
      return [];
    }
    const json = (await response.json()) as { templates?: Array<Parameters<typeof summarizeWhatsAppTemplate>[0]> };
    return (json.templates ?? []).map(summarizeWhatsAppTemplate);
  }

  /** Adds an emoji reaction (Zernio internal message id). No-op where unsupported. */
  async react(target: SendTarget, messageId: string, emoji: string): Promise<SendResult> {
    if (!capabilitiesOf(target.platform).reactions) {
      return { ok: false, status: 0, error: `reactions not supported on ${target.platform}` };
    }
    return this.post(
      `/v1/inbox/conversations/${enc(target.conversationId)}/messages/${enc(messageId)}/reactions`,
      { accountId: target.accountId, emoji },
      "reaction",
    );
  }

  /**
   * Shows "typing…" where the platform supports it (WhatsApp keeps it ~25s).
   * Best-effort: never throws, silently skipped elsewhere.
   */
  async typing(target: SendTarget): Promise<void> {
    if (!capabilitiesOf(target.platform).typing) return;
    try {
      await this.fetchImpl(this.url(`/v1/inbox/conversations/${enc(target.conversationId)}/typing`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ accountId: target.accountId }),
      });
    } catch (e) {
      this.onError("typing", e instanceof Error ? e.message : String(e));
    }
  }

  /** Public reply to a comment (or a new top-level comment when `commentId` is omitted). */
  async replyToComment(args: {
    accountId: string;
    postId: string;
    commentId?: string;
    text: string;
    attachmentUrl?: string;
  }): Promise<SendResult> {
    return this.post(
      `/v1/inbox/comments/${enc(args.postId)}`,
      {
        accountId: args.accountId,
        message: args.text,
        ...(args.commentId ? { commentId: args.commentId } : {}),
        ...(args.attachmentUrl ? { attachmentUrl: args.attachmentUrl } : {}),
      },
      "comment reply",
    );
  }

  /**
   * Private DM answering a comment (Instagram / Facebook comment-to-DM; one per
   * comment). Up to 13 quick replies or 3 buttons.
   */
  async privateReplyToComment(args: {
    accountId: string;
    postId: string;
    commentId: string;
    text: string;
    quickReplies?: ReplyButton[];
    buttons?: Array<{ type: "url"; title: string; url: string } | { type: "postback"; title: string; id: string }>;
  }): Promise<SendResult> {
    return this.post(
      `/v1/inbox/comments/${enc(args.postId)}/${enc(args.commentId)}/private-reply`,
      {
        accountId: args.accountId,
        message: args.text,
        ...(args.quickReplies?.length
          ? { quickReplies: args.quickReplies.map((q) => ({ title: q.title, payload: q.id })) }
          : {}),
        ...(args.buttons?.length
          ? {
              buttons: args.buttons.map((b) =>
                b.type === "url"
                  ? { type: "url", title: b.title, url: b.url }
                  : { type: "postback", title: b.title, payload: b.id },
              ),
            }
          : {}),
      },
      "private reply",
    );
  }

  /**
   * Connected accounts that can hold inbox conversations (WhatsApp numbers,
   * Instagram and Facebook accounts, Telegram bots…), sorted by platform.
   */
  async listInboxAccounts(): Promise<InboxAccount[]> {
    const response = await this.fetchImpl(this.url("/v1/accounts"), { headers: this.headers() });
    if (!response.ok) {
      this.onError("accounts", `HTTP ${response.status}`);
      return [];
    }
    const json = (await response.json()) as {
      accounts?: Array<{
        _id: string;
        platform: string;
        username?: string;
        displayName?: string;
        profilePicture?: string | null;
        isActive?: boolean;
      }>;
    };
    return (json.accounts ?? [])
      .filter((a) => INBOX_PLATFORMS.includes(a.platform))
      .map((a) => ({
        id: a._id,
        platform: a.platform,
        label: a.displayName?.trim() || (a.username ? `@${a.username}` : a._id),
        ...(a.username ? { username: a.username } : {}),
        ...(a.profilePicture ? { picture: a.profilePicture } : {}),
        active: a.isActive !== false,
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.label.localeCompare(b.label));
  }

  /** True when the URL is served by Zernio and needs the API key. */
  isZernioUrl(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return ZERNIO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  /**
   * Downloads an inbound attachment. WhatsApp media URLs point at Zernio and
   * need the API key (never sent to other hosts); Meta drops the media after a
   * retention window, so hosts should copy the bytes when the webhook arrives.
   */
  async fetchMedia(url: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.isZernioUrl(url)) headers.Authorization = `Bearer ${this.apiKey}`;
    return this.fetchImpl(url, { headers });
  }

  private async post(path: string, body: unknown, label: string): Promise<SendResult> {
    const result = await this.postJson(path, body, label);
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    // Shapes differ per endpoint: `{ success, data: { messageId } }` for sends,
    // `{ success, data: { commentId } }` for comment replies, `{ success,
    // messageId }` for reactions, `{ status, messageId }` for private replies.
    const json = result.json as {
      messageId?: string;
      data?: { messageId?: string; commentId?: string };
    };
    const id = json.data?.messageId ?? json.data?.commentId ?? json.messageId ?? null;
    return { ok: true, messageId: id, messageIds: id ? [id] : [] };
  }

  /** POSTs JSON; a success is a 2xx JSON body without `success: false`. */
  private async postJson(
    path: string,
    body: unknown,
    label: string,
  ): Promise<{ ok: true; json: object } | { ok: false; status: number; error: string; code?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.onError(label, error);
      return { ok: false, status: 0, error };
    }

    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Non-JSON body: handled below with the status code.
    }
    const result = (json ?? {}) as { success?: boolean; code?: unknown };
    if (response.ok && json !== null && result.success !== false) {
      return { ok: true, json: result };
    }
    const error = json ? JSON.stringify(json) : `HTTP ${response.status}`;
    this.onError(label, error);
    return {
      ok: false,
      status: response.status,
      error,
      ...(typeof result.code === "string" ? { code: result.code } : {}),
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
