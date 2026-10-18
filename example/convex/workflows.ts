import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { createFunctionHandle } from "convex/server";
import { ConvexFlows, type FlowRunResult } from "../../src/client/index.js";

const flows = new ConvexFlows(components.convexFlows);

const ACTIONS = [
  { name: "lookup", label: "Lookup", params: [{ name: "radius", label: "Radius", required: true }], outputs: [{ id: "found", label: "Found" }, { id: "none", label: "None" }] },
];

const demoGraph = {
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "keyword", keywords: ["PROMO"], match: "exact" }] } },
    { id: "m1", type: "message", position: { x: 0, y: 100 }, data: { text: "Salut {{contact.name}}, tu veux la promo ?", buttons: [{ id: "yes", title: "Oui" }, { id: "no", title: "Non" }] } },
    { id: "a1", type: "ask", position: { x: 0, y: 200 }, data: { text: "Envoie ta position", saveAs: "position", expect: "location" } },
    { id: "x1", type: "action", position: { x: 0, y: 300 }, data: { action: "lookup", params: { radius: "3" }, saveAs: "found" } },
    { id: "c1", type: "condition", position: { x: 0, y: 400 }, data: { mode: "all", rules: [{ variable: "vars.found.count", operator: "greater_than", value: "1" }] } },
    { id: "m2", type: "message", position: { x: 0, y: 500 }, data: { text: "Bon appétit {{contact.name}} ({{vars.found.count}} plats)" } },
    { id: "d1", type: "delay", position: { x: 0, y: 600 }, data: { amount: 0.05, unit: "minutes" } },
    { id: "m3", type: "message", position: { x: 0, y: 700 }, data: { text: "Alors, c'était bon ?" } },
    { id: "h1", type: "handoff", position: { x: 300, y: 200 }, data: {} },
  ],
  edges: [
    { id: "e1", source: "t", target: "m1" },
    { id: "e2", source: "m1", sourceHandle: "yes", target: "a1" },
    { id: "e3", source: "m1", sourceHandle: "no", target: "h1" },
    { id: "e4", source: "a1", sourceHandle: "reply", target: "x1" },
    { id: "e5", source: "x1", sourceHandle: "found", target: "c1" },
    { id: "e6", source: "c1", sourceHandle: "true", target: "m2" },
    { id: "e7", source: "m2", target: "d1" },
    { id: "e8", source: "d1", target: "m3" },
  ],
};

const welcomeGraph = {
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "any" }] } },
    { id: "m", type: "message", position: { x: 0, y: 100 }, data: { text: "{{t.welcome}}", buttons: [{ id: "foodie", title: "{{t.btn_foodie}}" }, { id: "owner", title: "{{t.btn_owner}}" }] } },
    { id: "f", type: "message", position: { x: 0, y: 200 }, data: { text: "client ({{contact.locale}})" } },
    { id: "o", type: "message", position: { x: 200, y: 200 }, data: { text: "restaurateur" } },
  ],
  edges: [
    { id: "1", source: "t", target: "m" },
    { id: "2", source: "m", sourceHandle: "foodie", target: "f" },
    { id: "3", source: "m", sourceHandle: "owner", target: "o" },
  ],
};

export const setupWelcome = mutation({
  args: {},
  handler: async (ctx) => {
    const flowId = await flows.createFlow(ctx, { name: "Welcome", graph: welcomeGraph, by: "example" });
    return flows.publishFlow(ctx, { flowId, actions: [], by: "example" });
  },
});

export const setupDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const flowId = await flows.createFlow(ctx, { name: "Promo", graph: demoGraph, by: "example" });
    const bad = await flows.publishFlow(ctx, { flowId, actions: [], by: "example" });
    const ok = await flows.publishFlow(ctx, { flowId, actions: ACTIONS, by: "example" });
    return { flowId, withoutCatalog: bad, withCatalog: ok, list: await flows.listFlows(ctx) };
  },
});

export const inbound = action({
  args: {
    conversationId: v.string(),
    text: v.string(),
    replyId: v.optional(v.string()),
    latitude: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    locale: v.optional(v.string()),
    segments: v.optional(v.array(v.string())),
    triggerKinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<FlowRunResult> => {
    return flows.handleInbound(ctx, {
      conversationId: args.conversationId,
      platform: "whatsapp",
      contact: {
        id: args.conversationId,
        name: "Léa",
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.segments ? { segments: args.segments } : {}),
      },
      ...(args.triggerKinds ? { triggerKinds: args.triggerKinds } : {}),
      input: {
        text: args.text,
        ...(args.replyId ? { replyId: args.replyId } : {}),
        ...(args.latitude !== undefined ? { location: { latitude: args.latitude, longitude: 5.78 } } : {}),
      },
      hostContext: { channel: "demo" },
      // The demo workflow picks no account.
      allowUnscoped: true,
      sendHandle: await createFunctionHandle(internal.host.send),
      actionHandle: await createFunctionHandle(internal.host.runAction),
      textsHandle: await createFunctionHandle(internal.host.texts),
      dryRun: args.dryRun,
    });
  },
});

export const outbox = query({
  args: { conversationId: v.string() },
  handler: async (ctx, { conversationId }) => {
    const rows = await ctx.db
      .query("outbox")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    return rows.map((r) => r.message);
  },
});

export const paused = query({
  args: { conversationId: v.string() },
  handler: async (ctx, { conversationId }) => flows.isBotPaused(ctx, conversationId),
});

const RESTAURANT_ACTIONS = [
  ...ACTIONS,
  { name: "restaurants", label: "Restaurants", params: [], outputs: [{ id: "done", label: "Done" }] },
];

const node = (id: string, type: string, data: unknown) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, sourceHandle?: string) => ({
  id: `${source}-${sourceHandle ?? "next"}-${target}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

/** 0.7 demo: a workflow calls another one (dynamic choice), then waits for an event. */
export const setupJourney = mutation({
  args: {},
  handler: async (ctx) => {
    const pick = await flows.createFlow(ctx, {
      key: "pick_restaurant",
      name: "Choisir un restaurant",
      graph: {
        nodes: [
          node("t", "trigger", { triggers: [{ kind: "api" }] }),
          node("load", "action", { action: "restaurants", params: {}, saveAs: "restaurants" }),
          node("ask", "message", { text: "Lequel ?", choices: { from: "vars.restaurants", saveAs: "restaurant" } }),
          node("done", "end", {}),
        ],
        edges: [edge("t", "load"), edge("load", "ask", "done"), edge("ask", "done", "chosen")],
      },
    });
    await flows.publishFlow(ctx, { flowId: pick, actions: RESTAURANT_ACTIONS });
    // Called workflows need not be on: only their triggers would be.
    await flows.setFlowActive(ctx, { flowId: pick, active: false });

    const main = await flows.createFlow(ctx, {
      key: "book",
      name: "Réserver",
      graph: {
        nodes: [
          node("t", "trigger", { triggers: [{ kind: "keyword", keywords: ["RESA"], match: "exact", segments: ["new"] }] }),
          node("call", "flow", { flowId: pick, returnAfter: true }),
          node("ok", "message", { text: "Choisi : {{vars.restaurant.title}}" }),
          node("pay", "wait_event", { event: "paid", saveAs: "payment", timeoutMinutes: 30 }),
          node("thanks", "message", { text: "Payé {{vars.payment.amount}} €" }),
        ],
        edges: [edge("t", "call"), edge("call", "ok"), edge("ok", "pay"), edge("pay", "thanks", "received")],
      },
    });
    const published = await flows.publishFlow(ctx, { flowId: main, actions: RESTAURANT_ACTIONS });
    return { pick, main, published, keys: await flows.activeFlowKeys(ctx) };
  },
});

export const emit = mutation({
  args: { conversationId: v.string(), event: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, args) => flows.emitEvent(ctx, args),
});
