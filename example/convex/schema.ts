import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /** Messages the engine asked the example host to deliver. */
  outbox: defineTable({ conversationId: v.string(), message: v.any(), at: v.number() }).index(
    "by_conversation",
    ["conversationId", "at"],
  ),
});
