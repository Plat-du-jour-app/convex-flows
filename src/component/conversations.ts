import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";

const conversationState = v.object({
  conversationId: v.string(),
  botPaused: v.boolean(),
  pausedAt: v.optional(v.number()),
  pausedBy: v.optional(v.string()),
});

/** Pauses or resumes the bot on one conversation (human takeover). */
export const setBotPaused = mutation({
  args: { conversationId: v.string(), paused: v.boolean(), by: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .first();
    const patch = args.paused
      ? { botPaused: true, pausedAt: now, pausedBy: args.by, updatedAt: now }
      : { botPaused: false, pausedAt: undefined, pausedBy: undefined, updatedAt: now };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("conversations", { conversationId: args.conversationId, ...patch });
    }
    return null;
  },
});

export const isBotPaused = query({
  args: { conversationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("conversations")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .first();
    return row?.botPaused ?? false;
  },
});

/** Automation state of several conversations (unknown ones are not paused). */
export const getStates = query({
  args: { conversationIds: v.array(v.string()) },
  returns: v.array(conversationState),
  handler: async (ctx, args) => {
    const ids = [...new Set(args.conversationIds)].slice(0, 500);
    const rows = await Promise.all(
      ids.map((conversationId) =>
        ctx.db
          .query("conversations")
          .withIndex("by_conversationId", (q) => q.eq("conversationId", conversationId))
          .first(),
      ),
    );
    return ids.map((conversationId, i) => ({
      conversationId,
      botPaused: rows[i]?.botPaused ?? false,
      ...(rows[i]?.pausedAt ? { pausedAt: rows[i]!.pausedAt } : {}),
      ...(rows[i]?.pausedBy ? { pausedBy: rows[i]!.pausedBy } : {}),
    }));
  },
});

/** Conversations currently handled by a human, most recently paused first. */
export const listPaused = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(conversationState),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_botPaused", (q) => q.eq("botPaused", true))
      .order("desc")
      .take(Math.min(Math.max(args.limit ?? 100, 1), 500));
    return rows.map((r) => ({
      conversationId: r.conversationId,
      botPaused: r.botPaused,
      ...(r.pausedAt ? { pausedAt: r.pausedAt } : {}),
      ...(r.pausedBy ? { pausedBy: r.pausedBy } : {}),
    }));
  },
});
