import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server.js";
import { internal } from "./_generated/api.js";

export const _store = internalMutation({
  args: { conversationId: v.string(), message: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.insert("outbox", { ...args, at: Date.now() });
  },
});

/** Send handle: a real host would call Zernio here. */
export const send = internalAction({
  args: {
    conversationId: v.string(),
    platform: v.string(),
    accountId: v.optional(v.string()),
    hostContext: v.any(),
    message: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.host._store, { conversationId: args.conversationId, message: args.message });
    return { ok: true, messageId: `m_${Date.now()}` };
  },
});

/** Action handle: one demo action, "lookup", that needs a position. */
export const runAction = internalAction({
  args: {
    name: v.string(),
    params: v.any(),
    conversationId: v.string(),
    platform: v.string(),
    accountId: v.optional(v.string()),
    hostContext: v.any(),
    contact: v.any(),
    vars: v.any(),
    dryRun: v.boolean(),
  },
  handler: async (_ctx, args) => {
    if (args.name === "restaurants") {
      return { output: "done", result: [{ id: "r1", title: "Chez Léon" }, { id: "r2", title: "La Table" }] };
    }
    if (args.name !== "lookup") return { output: "error", result: "unknown action" };
    const pos = args.vars.position as { latitude?: number } | undefined;
    if (!pos?.latitude) return { output: "none", result: { count: 0 } };
    return {
      output: "found",
      result: { count: 2 },
      messages: [{ type: "text", text: `2 résultats autour de ${pos.latitude} (${args.params.radius} km)` }],
    };
  },
});

/** Texts handle: a real host looks its catalog up in the contact's language. */
export const texts = internalAction({
  args: { keys: v.array(v.string()), locale: v.optional(v.string()), contact: v.any(), vars: v.any(), hostContext: v.any() },
  handler: async (_ctx, args) => {
    const catalog: Record<string, Record<string, string>> = {
      fr: { welcome: "Bienvenue {name} !", btn_foodie: "🍽 Je cherche un plat", btn_owner: "👨‍🍳 Je suis restaurateur" },
      sl: { welcome: "Dobrodošli {name}!", btn_foodie: "🍽 Iščem jed", btn_owner: "👨‍🍳 Sem gostinec" },
    };
    const lang = catalog[args.locale ?? "fr"] ?? catalog.fr;
    return Object.fromEntries(args.keys.map((k) => [k, (lang[k] ?? "").replace("{name}", args.contact?.name ?? "")]));
  },
});
