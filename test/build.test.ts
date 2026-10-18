import { describe, expect, it } from "vitest";
import { buildSendBodies, toPlainText } from "../src/shared/build.js";
import { truncate, truncateBytes } from "../src/shared/limits.js";
import type { OutboundMessage } from "../src/shared/types.js";

const body = (platform: string, msg: OutboundMessage, opts = {}) =>
  buildSendBodies(platform, "acc", msg, opts);

const three: OutboundMessage = {
  type: "buttons",
  text: "Choisis",
  buttons: [
    { id: "a", title: "Un titre beaucoup trop long pour WhatsApp" },
    { id: "b", title: "Deux" },
    { id: "c", title: "Trois" },
    { id: "d", title: "Quatre" },
  ],
};

const list: OutboundMessage = {
  type: "list",
  text: "Aide",
  buttonLabel: "Voir le menu",
  sections: [
    {
      title: "Restaurant",
      rows: [
        { id: "photo", title: "📸 Photo", description: "Envoyer la photo du plat" },
        { id: "carte", title: "Carte" },
      ],
    },
  ],
};

describe("text", () => {
  it("is the same everywhere", () => {
    for (const p of ["whatsapp", "instagram", "telegram", "bluesky", "sms"]) {
      expect(body(p, { type: "text", text: "Bonjour" })).toEqual({
        bodies: [{ accountId: "acc", message: "Bonjour" }],
        degraded: false,
      });
    }
  });

  it("forwards linkPreview only where it exists", () => {
    expect(body("whatsapp", { type: "text", text: "x", linkPreview: false }).bodies[0]).toMatchObject({
      linkPreview: false,
    });
    expect(body("facebook", { type: "text", text: "x", linkPreview: false }).bodies[0]).not.toHaveProperty(
      "linkPreview",
    );
  });
});

describe("buttons", () => {
  it("WhatsApp: 3 postback buttons, titles capped at 20", () => {
    expect(body("whatsapp", three).bodies[0].buttons).toEqual([
      { type: "postback", title: "Un titre beaucoup tr", payload: "a" },
      { type: "postback", title: "Deux", payload: "b" },
      { type: "postback", title: "Trois", payload: "c" },
    ]);
  });

  it("WhatsApp: media header in the same message", () => {
    const out = body("whatsapp", {
      type: "buttons",
      text: "Plat du jour",
      buttons: [{ id: "ok", title: "OK" }],
      header: { kind: "image", url: "https://cdn/x.jpg" },
    });
    expect(out.bodies).toHaveLength(1);
    expect(out.bodies[0]).toMatchObject({ attachmentUrl: "https://cdn/x.jpg", attachmentType: "image" });
  });

  it("Messenger: button template when the text fits 640 chars", () => {
    expect(body("facebook", three).bodies[0]).toMatchObject({
      message: "Choisis",
      buttons: [
        { type: "postback", title: "Un titre beaucoup tr", payload: "a" },
        { type: "postback", title: "Deux", payload: "b" },
        { type: "postback", title: "Trois", payload: "c" },
      ],
    });
  });

  it("Instagram: quick replies when the text is too long for a button template", () => {
    const out = body("instagram", { ...three, text: "x".repeat(700) } as OutboundMessage);
    expect(out.bodies[0]).not.toHaveProperty("buttons");
    expect(out.bodies[0].quickReplies).toHaveLength(3);
  });

  it("Messenger: media header goes out first as its own message", () => {
    const out = body("facebook", {
      type: "buttons",
      text: "Plat",
      buttons: [{ id: "ok", title: "OK" }],
      header: { kind: "image", url: "https://cdn/x.jpg" },
    });
    expect(out.bodies).toHaveLength(2);
    expect(out.bodies[0]).toMatchObject({ attachmentUrl: "https://cdn/x.jpg", message: "" });
    expect(out.bodies[1]).toHaveProperty("buttons");
  });

  it("Telegram: inline keyboard with callback data", () => {
    expect(body("telegram", three).bodies[0].replyMarkup).toEqual({
      type: "inline_keyboard",
      keyboard: [
        [{ text: "Un titre beaucoup trop long pour WhatsApp", callbackData: "a" }],
        [{ text: "Deux", callbackData: "b" }],
        [{ text: "Trois", callbackData: "c" }],
        [{ text: "Quatre", callbackData: "d" }],
      ],
    });
  });

  it("text-only platforms: numbered options", () => {
    const out = body("bluesky", three);
    expect(out).toEqual({
      bodies: [
        {
          accountId: "acc",
          message: "Choisis\n\n1. Un titre beaucoup trop long pour WhatsApp\n2. Deux\n3. Trois\n4. Quatre",
        },
      ],
      degraded: true,
    });
  });
});

describe("list", () => {
  it("WhatsApp: native list capped at 10 rows across sections", () => {
    const rows = (n: number, p: string) =>
      Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, title: `${p} ${i}` }));
    const out = body("whatsapp", {
      type: "list",
      text: "Menu",
      buttonLabel: "Voir les options du menu",
      sections: [
        { title: "Première section très longue", rows: rows(7, "a") },
        { rows: rows(7, "b") },
        { title: "vide", rows: rows(2, "c") },
      ],
      footer: "pied",
    });
    const interactive = out.bodies[0].interactive as {
      action: { button: string; sections: Array<{ title?: string; rows: unknown[] }> };
      footer: { text: string };
    };
    expect(interactive.action.button).toBe("Voir les options du ");
    expect(interactive.action.sections).toHaveLength(2);
    expect(interactive.action.sections[0].title).toBe("Première section très lo");
    expect(interactive.action.sections[1].rows).toHaveLength(3);
    expect(interactive.footer).toEqual({ text: "pied" });
  });

  it("Instagram: quick replies, descriptions dropped (degraded)", () => {
    const out = body("instagram", list);
    expect(out.bodies[0]).toEqual({
      accountId: "acc",
      message: "Aide",
      quickReplies: [
        { title: "📸 Photo", payload: "photo" },
        { title: "Carte", payload: "carte" },
      ],
    });
    expect(out.degraded).toBe(true);
  });

  it("Messenger: more than 13 options falls back to numbered text", () => {
    const many = {
      type: "list" as const,
      text: "Choix",
      buttonLabel: "Voir",
      sections: [{ rows: Array.from({ length: 14 }, (_, i) => ({ id: `${i}`, title: `Option ${i}` })) }],
    };
    const out = body("facebook", many);
    expect(out.bodies[0]).not.toHaveProperty("quickReplies");
    expect(String(out.bodies[0].message)).toContain("14. Option 13");
  });

  it("Telegram: one inline button per row", () => {
    const out = body("telegram", list);
    expect(out.bodies[0].replyMarkup).toEqual({
      type: "inline_keyboard",
      keyboard: [[{ text: "📸 Photo", callbackData: "photo" }], [{ text: "Carte", callbackData: "carte" }]],
    });
  });

  it("SMS: numbered rows with descriptions", () => {
    expect(body("sms", list).bodies[0].message).toBe("Aide\n\n1. 📸 Photo — Envoyer la photo du plat\n2. Carte");
  });
});

describe("ctaUrl", () => {
  const cta: OutboundMessage = {
    type: "ctaUrl",
    text: "Ouvre ton espace",
    buttonTitle: "Ouvrir le back-office maintenant",
    url: "https://bo.example/x",
  };

  it("WhatsApp: interactive cta_url", () => {
    expect(body("whatsapp", cta).bodies[0]).toEqual({
      accountId: "acc",
      interactive: {
        type: "cta_url",
        body: { text: "Ouvre ton espace" },
        action: {
          name: "cta_url",
          parameters: { display_text: "Ouvrir le back-offic", url: "https://bo.example/x" },
        },
      },
    });
  });

  it("Messenger: URL button", () => {
    expect(body("facebook", cta).bodies[0].buttons).toEqual([
      { type: "url", title: "Ouvrir le back-offic", url: "https://bo.example/x" },
    ]);
  });

  it("Telegram: inline URL button", () => {
    expect(body("telegram", cta).bodies[0].replyMarkup).toEqual({
      type: "inline_keyboard",
      keyboard: [[{ text: "Ouvrir le back-office maintenant", url: "https://bo.example/x" }]],
    });
  });

  it("X: text with the link", () => {
    expect(body("twitter", cta).bodies[0].message).toBe("Ouvre ton espace\n\nhttps://bo.example/x");
  });
});

describe("location", () => {
  it("WhatsApp: native location request", () => {
    expect(body("whatsapp", { type: "locationRequest", text: "Où es-tu ?" }).bodies[0]).toEqual({
      accountId: "acc",
      interactive: {
        type: "location_request_message",
        body: { text: "Où es-tu ?" },
        action: { name: "send_location" },
      },
    });
  });

  it("elsewhere: the request is plain text", () => {
    expect(body("instagram", { type: "locationRequest", text: "Où es-tu ?" })).toEqual({
      bodies: [{ accountId: "acc", message: "Où es-tu ?" }],
      degraded: true,
    });
  });

  it("pin on WhatsApp and iMessage, Maps link elsewhere", () => {
    const pin: OutboundMessage = { type: "location", latitude: 43.83, longitude: 5.78, name: "Chez Léon" };
    expect(body("imessage", pin).bodies[0]).toEqual({
      accountId: "acc",
      location: { latitude: 43.83, longitude: 5.78, name: "Chez Léon" },
    });
    expect(body("telegram", pin).bodies[0].message).toBe(
      "📍 Chez Léon\nhttps://www.google.com/maps?q=43.83,5.78",
    );
  });
});

describe("media", () => {
  const image: OutboundMessage = { type: "media", kind: "image", url: "https://cdn/p.png", caption: "Le plat" };

  it("sends media with caption where supported", () => {
    expect(body("whatsapp", image).bodies[0]).toEqual({
      accountId: "acc",
      message: "Le plat",
      attachmentUrl: "https://cdn/p.png",
      attachmentType: "image",
    });
  });

  it("TikTok: image and caption as two messages", () => {
    expect(body("tiktok", image).bodies).toEqual([
      { accountId: "acc", attachmentUrl: "https://cdn/p.png", attachmentType: "image" },
      { accountId: "acc", message: "Le plat" },
    ]);
  });

  it("Bluesky: link in text", () => {
    expect(body("bluesky", image).bodies[0].message).toBe("Le plat\n\nhttps://cdn/p.png");
  });

  it("keeps WhatsApp-only fields off other platforms", () => {
    const doc: OutboundMessage = { type: "media", kind: "file", url: "https://cdn/m.pdf", fileName: "Menu.pdf" };
    expect(body("whatsapp", doc).bodies[0]).toHaveProperty("attachmentName", "Menu.pdf");
    expect(body("facebook", doc).bodies[0]).not.toHaveProperty("attachmentName");
  });
});

describe("carousel", () => {
  const carousel: OutboundMessage = {
    type: "carousel",
    text: "Plats du jour près de toi",
    cards: [
      {
        title: "Chez Léon",
        subtitle: "Blanquette — 14 €",
        imageUrl: "https://cdn/1.jpg",
        buttons: [
          { type: "url", title: "Voir", url: "https://pdj/1" },
          { type: "postback", id: "book_1", title: "Réserver" },
        ],
      },
    ],
  };

  it("Instagram: text then generic template", () => {
    const out = body("instagram", carousel);
    expect(out.bodies).toHaveLength(2);
    expect(out.bodies[1]).toEqual({
      accountId: "acc",
      template: {
        type: "generic",
        elements: [
          {
            title: "Chez Léon",
            subtitle: "Blanquette — 14 €",
            imageUrl: "https://cdn/1.jpg",
            buttons: [
              { type: "url", title: "Voir", url: "https://pdj/1" },
              { type: "postback", title: "Réserver", payload: "book_1" },
            ],
          },
        ],
      },
    });
  });

  it("WhatsApp: numbered cards in text", () => {
    expect(body("whatsapp", carousel).bodies[0].message).toBe(
      "Plats du jour près de toi\n\n1. Chez Léon\n   Blanquette — 14 €\n   Voir: https://pdj/1\n   Réserver",
    );
  });
});

describe("templates and options", () => {
  it("builds a WhatsApp template", () => {
    expect(
      body("whatsapp", {
        type: "template",
        name: "reservation_new",
        language: "fr",
        components: [{ type: "body", parameters: [{ type: "text", text: "Léa" }] }],
      }).bodies[0],
    ).toEqual({
      accountId: "acc",
      template: {
        elements: [
          {
            name: "reservation_new",
            language: "fr",
            components: [{ type: "body", parameters: [{ type: "text", text: "Léa" }] }],
          },
        ],
      },
    });
  });

  it("refuses templates off WhatsApp", () => {
    expect(() => body("instagram", { type: "template", name: "t", language: "fr" })).toThrow(/WhatsApp-only/);
  });

  it("applies utility on WhatsApp only, message tags on Meta only", () => {
    expect(body("whatsapp", { type: "text", text: "x" }, { utility: true, messageTag: "HUMAN_AGENT" }).bodies[0]).toEqual({
      accountId: "acc",
      message: "x",
      category: "utility",
    });
    expect(body("facebook", { type: "text", text: "x" }, { utility: true, messageTag: "HUMAN_AGENT" }).bodies[0]).toEqual({
      accountId: "acc",
      message: "x",
      messagingType: "MESSAGE_TAG",
      messageTag: "HUMAN_AGENT",
    });
  });

  it("rejects utility on a WhatsApp template", () => {
    expect(() => body("whatsapp", { type: "template", name: "t", language: "fr" }, { utility: true })).toThrow(
      /utility/,
    );
  });

  it("puts replyTo on the first body only", () => {
    const out = body(
      "tiktok",
      { type: "media", kind: "image", url: "https://cdn/p.png", caption: "c" },
      { replyTo: "m1" },
    );
    expect(out.bodies[0]).toHaveProperty("replyTo", "m1");
    expect(out.bodies[1]).not.toHaveProperty("replyTo");
  });

  it("degrades unknown platforms to text", () => {
    expect(body("myspace", three).degraded).toBe(true);
  });
});

describe("truncation", () => {
  it("never splits an emoji", () => {
    expect(truncate("🍽️🍽️🍽️", 3)).toBe("🍽️🍽");
    expect(truncate("ab😀cd", 3)).toBe("ab😀");
  });

  it("caps Telegram callback data at 64 bytes", () => {
    expect(new TextEncoder().encode(truncateBytes("é".repeat(40), 64)).length).toBe(64);
    expect(truncateBytes("é".repeat(40), 63)).toBe("é".repeat(31));
  });
});

describe("toPlainText", () => {
  it("returns null for templates", () => {
    expect(toPlainText({ type: "template", name: "t", language: "fr" })).toBeNull();
  });

  it("formats contact cards", () => {
    expect(
      toPlainText({
        type: "contacts",
        contacts: [{ name: { formatted_name: "Léon" }, phones: [{ phone: "+33612345678" }] }],
      }),
    ).toBe("👤 Léon\n📞 +33612345678");
  });
});
