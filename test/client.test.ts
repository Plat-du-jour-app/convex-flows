import { describe, expect, it } from "vitest";
import { ZernioClient } from "../src/shared/client.js";
import type { SendTarget } from "../src/shared/types.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, json: { success: true } };
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const silent = () => {};
const wa: SendTarget = { conversationId: "conv 1", accountId: "acc", platform: "whatsapp" };
const sentBody = (c: Call) => JSON.parse(String(c.init.body));

describe("ZernioClient", () => {
  it("posts to the conversation and returns the message id", async () => {
    const f = fakeFetch([{ json: { success: true, data: { messageId: "wamid.9" } } }]);
    const client = new ZernioClient({ apiKey: "k", baseUrl: "https://app.getlate.dev/api/", fetch: f.impl });
    const result = await client.send(wa, { type: "text", text: "Salut" });
    expect(result).toEqual({ ok: true, messageId: "wamid.9", messageIds: ["wamid.9"] });
    expect(f.calls[0].url).toBe("https://app.getlate.dev/api/v1/inbox/conversations/conv%201/messages");
    expect(f.calls[0].init.headers).toMatchObject({ Authorization: "Bearer k" });
    expect(sentBody(f.calls[0])).toEqual({ accountId: "acc", message: "Salut" });
  });

  it("sends multi-part messages in order (TikTok image + caption)", async () => {
    const f = fakeFetch([
      { json: { success: true, data: { messageId: "t1" } } },
      { json: { success: true, data: { messageId: "t2" } } },
    ]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl });
    const result = await client.send(
      { conversationId: "c", accountId: "acc", platform: "tiktok" },
      { type: "media", kind: "image", url: "https://cdn/p.png", caption: "Le plat" },
    );
    expect(result).toEqual({ ok: true, messageId: "t1", messageIds: ["t1", "t2"] });
    expect(sentBody(f.calls[1])).toEqual({ accountId: "acc", message: "Le plat" });
  });

  it("reports a rejected send", async () => {
    const f = fakeFetch([{ status: 400, json: { success: false, error: "window closed" } }]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl, onError: silent });
    expect(await client.send(wa, { type: "text", text: "x" })).toMatchObject({ ok: false, status: 400 });
  });

  it("falls back to plain text when a rich send is rejected", async () => {
    const f = fakeFetch([
      { status: 400, json: { success: false } },
      { json: { success: true, data: { messageId: "m2" } } },
    ]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl, onError: silent });
    const result = await client.sendWithFallback(wa, {
      type: "ctaUrl",
      text: "Ouvre",
      buttonTitle: "Go",
      url: "https://x",
    });
    expect(result).toEqual({ ok: true, messageId: "m2", messageIds: ["m2"] });
    expect(sentBody(f.calls[1])).toEqual({ accountId: "acc", message: "Ouvre\n\nhttps://x" });
  });

  it("does not retry a failed plain text", async () => {
    const f = fakeFetch([{ status: 500, json: { success: false } }]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl, onError: silent });
    await client.sendWithFallback(wa, { type: "text", text: "x" });
    expect(f.calls).toHaveLength(1);
  });

  it("reads the id of a reaction and skips platforms without reactions", async () => {
    const f = fakeFetch([{ json: { success: true, messageId: "r1" } }]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl, onError: silent });
    expect(await client.react(wa, "m1", "👀")).toEqual({ ok: true, messageId: "r1", messageIds: ["r1"] });
    expect(f.calls[0].url).toBe("https://zernio.com/api/v1/inbox/conversations/conv%201/messages/m1/reactions");
    const skipped = await client.react({ ...wa, platform: "bluesky" }, "m1", "👀");
    expect(skipped.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("only sends typing where supported, and never throws", async () => {
    const f = fakeFetch([]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl, onError: silent });
    await client.typing({ ...wa, platform: "reddit" });
    expect(f.calls).toHaveLength(0);
    await client.typing(wa);
    expect(f.calls).toHaveLength(1);

    const failing = new ZernioClient({
      apiKey: "k",
      fetch: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      onError: silent,
    });
    await expect(failing.typing(wa)).resolves.toBeUndefined();
  });

  it("replies to a comment publicly and privately", async () => {
    const f = fakeFetch([
      { json: { success: true, data: { commentId: "c9" } } },
      { json: { status: "sent", messageId: "dm1" } },
    ]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl });
    expect(await client.replyToComment({ accountId: "acc", postId: "p1", commentId: "c1", text: "Merci !" })).toEqual({
      ok: true,
      messageId: "c9",
      messageIds: ["c9"],
    });
    expect(f.calls[0].url).toBe("https://zernio.com/api/v1/inbox/comments/p1");
    expect(sentBody(f.calls[0])).toEqual({ accountId: "acc", message: "Merci !", commentId: "c1" });

    const dm = await client.privateReplyToComment({
      accountId: "acc",
      postId: "p1",
      commentId: "c1",
      text: "Voici la carte",
      buttons: [{ type: "url", title: "Carte", url: "https://pdj/carte" }],
    });
    expect(dm).toEqual({ ok: true, messageId: "dm1", messageIds: ["dm1"] });
    expect(f.calls[1].url).toBe("https://zernio.com/api/v1/inbox/comments/p1/c1/private-reply");
    expect(sentBody(f.calls[1]).buttons).toEqual([{ type: "url", title: "Carte", url: "https://pdj/carte" }]);
  });

  it("only sends the API key to Zernio media hosts", async () => {
    const f = fakeFetch([{ json: {} }, { json: {} }]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl });
    await client.fetchMedia("https://zernio.com/api/v1/whatsapp/media/1");
    await client.fetchMedia("https://cdn.example.com/a.jpg");
    expect(f.calls[0].init.headers).toEqual({ Authorization: "Bearer k" });
    expect(f.calls[1].init.headers).toEqual({});
    expect(client.isZernioUrl("https://app.getlate.dev/x")).toBe(true);
    expect(client.isZernioUrl("https://evilzernio.com/x")).toBe(false);
  });
});

describe("listInboxAccounts", () => {
  it("keeps inbox platforms and labels them", async () => {
    const f = fakeFetch([
      {
        json: {
          accounts: [
            { _id: "a1", platform: "instagram", username: "olea", isActive: true },
            { _id: "a2", platform: "googlebusiness", displayName: "Fiche" },
            { _id: "a3", platform: "whatsapp", displayName: "platdujour.app", isActive: true },
            { _id: "a4", platform: "facebook", displayName: " Buffet de la gare ", isActive: false },
          ],
        },
      },
    ]);
    const client = new ZernioClient({ apiKey: "k", fetch: f.impl });
    expect(await client.listInboxAccounts()).toEqual([
      { id: "a4", platform: "facebook", label: "Buffet de la gare", active: false },
      { id: "a1", platform: "instagram", label: "@olea", username: "olea", active: true },
      { id: "a3", platform: "whatsapp", label: "platdujour.app", active: true },
    ]);
    expect(f.calls[0].url).toBe("https://zernio.com/api/v1/accounts");
  });
});
