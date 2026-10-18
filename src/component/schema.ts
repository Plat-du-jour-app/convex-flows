import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * One row per Zernio webhook event id. Zernio retries a delivery up to 7
   * times over ~51h with the same id, so claiming the id makes processing
   * idempotent across retries and redeliveries.
   */
  webhookEvents: defineTable({
    eventId: v.string(),
    event: v.string(),
    receivedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_receivedAt", ["receivedAt"]),

  /**
   * Per-conversation automation state. A conversation with `botPaused` is
   * handled by a human: the host keeps storing inbound messages but does not
   * run its bot on them.
   */
  conversations: defineTable({
    conversationId: v.string(),
    botPaused: v.boolean(),
    pausedAt: v.optional(v.number()),
    /** Who paused it (host-defined: user id, email…). */
    pausedBy: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_botPaused", ["botPaused", "updatedAt"]),

  /**
   * Workflows built in the editor. `ownerId` scopes a workflow (absent =
   * global, e.g. the platform team; later a restaurant id). The engine only
   * runs the `published` snapshot, so drafts can be edited safely.
   */
  flows: defineTable({
    ownerId: v.optional(v.string()),
    /** Stable host identifier (e.g. to seed or find a workflow from code). */
    key: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    /** Folder the editor files the workflow in (organisation only, not an edit). */
    folder: v.optional(v.string()),
    draft: v.any(),
    published: v.optional(v.any()),
    version: v.number(),
    active: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId", "updatedAt"])
    .index("by_owner_key", ["ownerId", "key"]),

  /** Folders of the workflow list, kept even while empty (see folders.ts). */
  flowFolders: defineTable({
    ownerId: v.optional(v.string()),
    name: v.string(),
  }).index("by_owner_name", ["ownerId", "name"]),

  /** Triggers of active published workflows, for matching inbound messages. */
  flowTriggers: defineTable({
    flowId: v.id("flows"),
    ownerId: v.optional(v.string()),
    /** Accounts the workflow listens on (absent/empty: unscoped). */
    accountIds: v.optional(v.array(v.string())),
    trigger: v.any(),
    rank: v.number(),
  })
    .index("by_owner", ["ownerId", "rank"])
    .index("by_flow", ["flowId"]),

  /**
   * One run of a workflow for one conversation. Keeps its own copy of the
   * graph so publishing a new version never breaks a run in progress.
   */
  flowSessions: defineTable({
    conversationId: v.string(),
    flowId: v.id("flows"),
    version: v.number(),
    graph: v.any(),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("done"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    nodeId: v.string(),
    waitKind: v.optional(v.union(v.literal("reply"), v.literal("delay"), v.literal("event"))),
    /** Event name the run waits for (`wait_event`). */
    waitEvent: v.optional(v.string()),
    /**
     * Workflows to return to, innermost last, when the current one was run by
     * a `flow` node with `returnAfter`.
     */
    stack: v.optional(
      v.array(v.object({ flowId: v.id("flows"), version: v.number(), graph: v.any(), nodeId: v.string() })),
    ),
    /** Bumped at every wait so a stale timer cannot resume the run. */
    waitToken: v.number(),
    vars: v.any(),
    last: v.any(),
    contact: v.any(),
    platform: v.string(),
    accountId: v.optional(v.string()),
    hostContext: v.any(),
    sendHandle: v.string(),
    actionHandle: v.optional(v.string()),
    textsHandle: v.optional(v.string()),
    /** Options of the choice the run waits on, as sent (texts resolved). */
    waitChoices: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
    dryRun: v.boolean(),
    error: v.optional(v.string()),
    startedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversation", ["conversationId", "status"])
    .index("by_flow", ["flowId", "startedAt"])
    .index("by_conversation_event", ["conversationId", "waitEvent", "status"]),
});
