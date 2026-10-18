import { describe, expect, it } from "vitest";
import { buildStartConversationBody } from "../src/shared/build.js";
import { renderWhatsAppTemplate, summarizeWhatsAppTemplate } from "../src/shared/templates.js";

const raw = {
  id: "t1",
  name: "relance_menu",
  language: "fr",
  status: "APPROVED",
  category: "UTILITY",
  components: [
    { type: "HEADER", format: "TEXT", text: "Bonjour {{1}}" },
    { type: "BODY", text: "Ton plat du jour de {{1}} est en ligne : {{2}}. {{1}}, à demain !" },
    { type: "FOOTER", text: "Plat du Jour" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "URL", text: "Voir la fiche", url: "https://platdujour.app/r/{{1}}" },
        { type: "QUICK_REPLY", text: "Stop" },
        { type: "URL", text: "Site", url: "https://platdujour.app" },
      ],
    },
  ],
};

describe("summarizeWhatsAppTemplate", () => {
  it("lists header, body and dynamic URL button values in send order", () => {
    const t = summarizeWhatsAppTemplate(raw);
    expect(t).toMatchObject({
      id: "t1",
      name: "relance_menu",
      headerFormat: "TEXT",
      headerText: "Bonjour {{1}}",
      footer: "Plat du Jour",
    });
    expect(t.params).toEqual([
      { part: "header", name: "1" },
      { part: "body", name: "1" },
      { part: "body", name: "2" },
      { part: "button", name: "Voir la fiche" },
    ]);
    expect(t.buttons).toHaveLength(3);
  });

  it("keeps named placeholders and skips media headers", () => {
    const t = summarizeWhatsAppTemplate({
      name: "promo",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "Salut {{ first_name }}, -{{discount}} ce soir" },
      ],
    });
    expect(t.headerFormat).toBe("IMAGE");
    expect(t.headerText).toBeUndefined();
    expect(t.params).toEqual([
      { part: "body", name: "first_name" },
      { part: "body", name: "discount" },
    ]);
  });
});

describe("renderWhatsAppTemplate", () => {
  it("fills header and body, repeated placeholders included", () => {
    const t = summarizeWhatsAppTemplate(raw);
    expect(renderWhatsAppTemplate(t, ["Léa", "Chez Léa", "Blanquette", "chez-lea"])).toBe(
      "Bonjour Léa\n\nTon plat du jour de Chez Léa est en ligne : Blanquette. Chez Léa, à demain !\n\nPlat du Jour",
    );
  });

  it("leaves placeholders without a value", () => {
    const t = summarizeWhatsAppTemplate(raw);
    expect(renderWhatsAppTemplate(t, ["Léa"])).toContain("de {{1}} est en ligne : {{2}}");
  });
});

describe("buildStartConversationBody", () => {
  it("sends a WhatsApp template to a phone in digits", () => {
    expect(
      buildStartConversationBody({
        accountId: "acc",
        platform: "whatsapp",
        to: "+33 6 12-34.56 78",
        template: { name: "relance_menu", language: "fr", params: ["Léa", "x"] },
      }),
    ).toEqual({
      accountId: "acc",
      participantId: "33612345678",
      templateName: "relance_menu",
      templateLanguage: "fr",
      templateParams: ["Léa", "x"],
    });
    expect(buildStartConversationBody({ accountId: "a", platform: "sms", to: "0033612345678", text: "Hi" })).toEqual({
      accountId: "a",
      participantId: "33612345678",
      message: "Hi",
    });
  });

  it("passes header media, location and button values through", () => {
    const body = buildStartConversationBody({
      accountId: "acc",
      platform: "whatsapp",
      to: "33612345678",
      template: {
        name: "facture",
        language: "fr",
        headerMedia: { type: "document", link: "https://cdn/f.pdf", filename: "Facture.pdf" },
        buttonParams: [{ index: 0, subType: "copy_code", value: "PROMO10" }],
      },
    });
    expect(body).toMatchObject({
      headerMedia: { type: "document", link: "https://cdn/f.pdf", filename: "Facture.pdf" },
      templateButtonParams: [{ index: 0, subType: "copy_code", value: "PROMO10" }],
    });
    expect(body).not.toHaveProperty("templateParams");
  });

  it("sends Direct Send text on WhatsApp and keeps other ids as given", () => {
    expect(buildStartConversationBody({ accountId: "a", platform: "whatsapp", to: "33612345678", text: "RDV", utility: true })).toEqual({
      accountId: "a",
      participantId: "33612345678",
      message: "RDV",
      category: "utility",
    });
    expect(buildStartConversationBody({ accountId: "a", platform: "imessage", to: " +33612345678 ", text: "x" })).toMatchObject({
      participantId: "+33612345678",
    });
    expect(buildStartConversationBody({ accountId: "a", platform: "bluesky", username: "@lea.bsky.social", text: "x" })).toEqual({
      accountId: "a",
      participantUsername: "@lea.bsky.social",
      message: "x",
    });
  });

  it("refuses templates off WhatsApp, template + utility, and no recipient", () => {
    const template = { name: "t", language: "fr" };
    expect(() => buildStartConversationBody({ accountId: "a", platform: "sms", to: "33", template })).toThrow(/WhatsApp-only/);
    expect(() =>
      buildStartConversationBody({ accountId: "a", platform: "whatsapp", to: "33", template, utility: true }),
    ).toThrow(/Direct Send/);
    expect(() => buildStartConversationBody({ accountId: "a", platform: "whatsapp", template })).toThrow(/`to` or `username`/);
  });
});
