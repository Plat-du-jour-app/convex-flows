import { v } from "convex/values";
import { mutation } from "./_generated/server.js";

/**
 * Records a webhook event id. Returns true the first time an id is seen and
 * false for every later delivery of the same event.
 */
export const claim = mutation({
  args: { eventId: v.string(), event: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (existing) return false;
    await ctx.db.insert("webhookEvents", {
      eventId: args.eventId,
      event: args.event,
      receivedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Deletes events received before `before` (ms epoch), at most `limit` per call.
 * `hasMore` tells the caller to schedule another pass.
 */
export const purge = mutation({
  args: { before: v.number(), limit: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 500, 1), 4000);
    const rows = await ctx.db
      .query("webhookEvents")
      .withIndex("by_receivedAt", (q) => q.lt("receivedAt", args.before))
      .take(limit + 1);
    const batch = rows.slice(0, limit);
    for (const row of batch) await ctx.db.delete(row._id);
    return { deleted: batch.length, hasMore: rows.length > limit };
  },
});
