import { v } from "convex/values";
import { mutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { ConvexFlows } from "../../src/client/index.js";

const flows = new ConvexFlows(components.convexFlows);

export const claimEvent = mutation({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return flows.claimWebhookEvent(ctx, { eventId: args.eventId, event: "message.received" });
  },
});

export const purgeEvents = mutation({
  args: {},
  handler: async (ctx) => {
    return flows.purgeWebhookEvents(ctx, { before: Date.now() + 1 });
  },
});

export const pause = mutation({
  args: { conversationId: v.string(), paused: v.boolean() },
  handler: async (ctx, args) => {
    await flows.setBotPaused(ctx, { ...args, by: "example" });
    return {
      paused: await flows.isBotPaused(ctx, args.conversationId),
      states: await flows.getConversationStates(ctx, [args.conversationId, "unknown"]),
      pausedList: await flows.listPausedConversations(ctx),
    };
  },
});
