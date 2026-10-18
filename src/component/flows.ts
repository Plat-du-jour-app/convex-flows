import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { accountsOf, calledFlowsOf, triggerRank, triggersOf, validateFlowGraph } from "../shared/flowRuntime.js";
import type { ActionDefinition, FlowGraph } from "../shared/flowTypes.js";
import { ensureFolder } from "./folders.js";

const EMPTY_GRAPH: FlowGraph = {
  nodes: [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [] } }],
  edges: [],
};

const issueValidator = v.object({ code: v.string(), nodeId: v.optional(v.string()), detail: v.optional(v.string()) });

const flowSummary = v.object({
  _id: v.id("flows"),
  key: v.optional(v.string()),
  name: v.string(),
  description: v.optional(v.string()),
  folder: v.optional(v.string()),
  active: v.boolean(),
  version: v.number(),
  publishedAt: v.optional(v.number()),
  updatedAt: v.number(),
  updatedBy: v.optional(v.string()),
  published: v.boolean(),
  hasDraftChanges: v.boolean(),
  triggers: v.array(v.any()),
  accounts: v.array(v.any()),
  nodeCount: v.number(),
});

const flowDoc = v.object({
  _id: v.id("flows"),
  _creationTime: v.number(),
  ownerId: v.optional(v.string()),
  key: v.optional(v.string()),
  name: v.string(),
  description: v.optional(v.string()),
  folder: v.optional(v.string()),
  draft: v.any(),
  published: v.optional(v.any()),
  version: v.number(),
  active: v.boolean(),
  updatedAt: v.number(),
  updatedBy: v.optional(v.string()),
  publishedAt: v.optional(v.number()),
  hasDraftChanges: v.boolean(),
});

const runSummary = v.object({
  _id: v.id("flowSessions"),
  conversationId: v.string(),
  contact: v.any(),
  status: v.string(),
  nodeId: v.string(),
  version: v.number(),
  startedAt: v.number(),
  updatedAt: v.number(),
  error: v.optional(v.string()),
});

/** The accounts picked on the trigger, with their labels (for lists). */
function accountsListOf(graph: FlowGraph): unknown[] {
  const trigger = graph?.nodes?.find((n) => n.type === "trigger");
  return ((trigger?.data as { accounts?: unknown[] } | undefined)?.accounts ?? []) as unknown[];
}

function sameGraph(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Rebuilds the trigger index of one workflow from its published graph. */
async function reindexTriggers(ctx: MutationCtx, flowId: Id<"flows">) {
  const existing = await ctx.db
    .query("flowTriggers")
    .withIndex("by_flow", (q) => q.eq("flowId", flowId))
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);
  const flow = await ctx.db.get(flowId);
  if (!flow?.active || !flow.published) return;
  const accountIds = accountsOf(flow.published as FlowGraph);
  for (const trigger of triggersOf(flow.published as FlowGraph)) {
    if (trigger.kind === "api") continue;
    await ctx.db.insert("flowTriggers", {
      flowId,
      ownerId: flow.ownerId,
      accountIds,
      trigger,
      rank: triggerRank(trigger),
    });
  }
}

export const list = query({
  args: { ownerId: v.optional(v.string()) },
  returns: v.array(flowSummary),
  handler: async (ctx, { ownerId }) => {
    const flows = await ctx.db
      .query("flows")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect();
    return flows.map((f) => ({
      _id: f._id,
      ...(f.key !== undefined ? { key: f.key } : {}),
      name: f.name,
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.folder !== undefined ? { folder: f.folder } : {}),
      active: f.active,
      version: f.version,
      ...(f.publishedAt !== undefined ? { publishedAt: f.publishedAt } : {}),
      updatedAt: f.updatedAt,
      ...(f.updatedBy !== undefined ? { updatedBy: f.updatedBy } : {}),
      published: !!f.published,
      hasDraftChanges: !sameGraph(f.draft, f.published),
      triggers: triggersOf((f.published ?? f.draft) as FlowGraph),
      accounts: accountsListOf((f.published ?? f.draft) as FlowGraph),
      nodeCount: ((f.draft as FlowGraph)?.nodes ?? []).length,
    }));
  },
});

export const get = query({
  args: { flowId: v.id("flows") },
  returns: v.union(v.null(), flowDoc),
  handler: async (ctx, { flowId }) => {
    const flow = await ctx.db.get(flowId);
    if (!flow) return null;
    return { ...flow, hasDraftChanges: !sameGraph(flow.draft, flow.published) };
  },
});

/** A workflow by its host key (see `create`). */
export const getByKey = query({
  args: { ownerId: v.optional(v.string()), key: v.string() },
  returns: v.union(v.null(), flowDoc),
  handler: async (ctx, { ownerId, key }) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
      .first();
    if (!flow) return null;
    return { ...flow, hasDraftChanges: !sameGraph(flow.draft, flow.published) };
  },
});

/** Keys of the workflows that are published and turned on. */
export const activeKeys = query({
  args: { ownerId: v.optional(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { ownerId }) => {
    const flows = await ctx.db
      .query("flows")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    return flows.filter((f) => f.active && f.published && f.key).map((f) => f.key!);
  },
});

export const create = mutation({
  args: {
    ownerId: v.optional(v.string()),
    /** Stable identifier for the host's code; unique per owner. */
    key: v.optional(v.string()),
    name: v.string(),
    description: v.optional(v.string()),
    folder: v.optional(v.string()),
    graph: v.optional(v.any()),
    by: v.optional(v.string()),
  },
  returns: v.id("flows"),
  handler: async (ctx, args) => {
    if (args.key) {
      const taken = await ctx.db
        .query("flows")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId).eq("key", args.key))
        .first();
      if (taken) throw new Error(`A workflow already uses the key "${args.key}"`);
    }
    if (args.folder?.trim()) await ensureFolder(ctx, args.ownerId, args.folder.trim());
    return ctx.db.insert("flows", {
      ownerId: args.ownerId,
      ...(args.key ? { key: args.key } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.folder?.trim() ? { folder: args.folder.trim() } : {}),
      name: args.name.trim() || "Workflow",
      draft: args.graph ?? EMPTY_GRAPH,
      version: 0,
      active: false,
      updatedAt: Date.now(),
      updatedBy: args.by,
    });
  },
});

export const saveDraft = mutation({
  args: {
    flowId: v.id("flows"),
    graph: v.optional(v.any()),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    by: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow) throw new Error("Workflow not found");
    const graph = args.graph as FlowGraph | undefined;
    if (graph && (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))) {
      throw new Error("Invalid graph: nodes and edges must be arrays");
    }
    await ctx.db.patch(args.flowId, {
      ...(graph ? { draft: graph } : {}),
      ...(args.name !== undefined ? { name: args.name.trim() || flow.name } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      updatedAt: Date.now(),
      updatedBy: args.by,
    });
    return null;
  },
});

/**
 * Files workflows in a folder ("" takes them out of any folder). Organising
 * is not an edit: `updatedAt` / `updatedBy` stay as they are.
 */
export const setFolder = mutation({
  args: { flowIds: v.array(v.id("flows")), folder: v.string() },
  returns: v.null(),
  handler: async (ctx, { flowIds, folder }) => {
    const name = folder.trim();
    for (const flowId of flowIds) {
      const flow = await ctx.db.get(flowId);
      if (!flow) throw new Error("Workflow not found");
      if (name) await ensureFolder(ctx, flow.ownerId, name);
      await ctx.db.patch(flowId, { folder: name || undefined });
    }
    return null;
  },
});

/**
 * Publishes the draft: validated first (with the host's action catalog), then
 * becomes the version new runs use. Runs in progress keep their own copy.
 */
export const publish = mutation({
  args: {
    flowId: v.id("flows"),
    actions: v.optional(v.any()),
    /** Refuse workflows that do not pick at least one inbox account. */
    requireAccounts: v.optional(v.boolean()),
    /**
     * Workflows published in the same go (a journey and the ones it runs,
     * which may run each other): accepted as targets of `flow` nodes.
     */
    publishingWith: v.optional(v.array(v.string())),
    by: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), version: v.number() }),
    v.object({ ok: v.literal(false), issues: v.array(issueValidator) }),
  ),
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow) throw new Error("Workflow not found");
    // Workflows this one runs must exist and be published (or be published with it).
    const together = new Set(args.publishingWith ?? []);
    const knownFlows: string[] = [];
    for (const id of calledFlowsOf(flow.draft as FlowGraph)) {
      const target = ctx.db.normalizeId("flows", id);
      const called = target ? await ctx.db.get(target) : null;
      if (called && (called.published || called._id === flow._id || together.has(called._id))) knownFlows.push(id);
    }
    const issues = validateFlowGraph(flow.draft as FlowGraph, args.actions as ActionDefinition[] | undefined, {
      requireAccounts: args.requireAccounts,
      knownFlows,
    });
    if (issues.length > 0) return { ok: false as const, issues };
    const version = flow.version + 1;
    await ctx.db.patch(args.flowId, {
      published: flow.draft,
      version,
      active: true,
      publishedAt: Date.now(),
      updatedAt: Date.now(),
      updatedBy: args.by,
    });
    await reindexTriggers(ctx, args.flowId);
    return { ok: true as const, version };
  },
});

/** Turns a published workflow on or off without touching its content. */
export const setActive = mutation({
  args: { flowId: v.id("flows"), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { flowId, active }) => {
    const flow = await ctx.db.get(flowId);
    if (!flow) throw new Error("Workflow not found");
    if (active && !flow.published) throw new Error("Publish the workflow before turning it on");
    await ctx.db.patch(flowId, { active, updatedAt: Date.now() });
    await reindexTriggers(ctx, flowId);
    return null;
  },
});

/** Deletes a workflow and stops its runs in progress. */
export const remove = mutation({
  args: { flowId: v.id("flows") },
  returns: v.null(),
  handler: async (ctx, { flowId }) => {
    await ctx.db.patch(flowId, { active: false });
    await reindexTriggers(ctx, flowId);
    const sessions = await ctx.db
      .query("flowSessions")
      .withIndex("by_flow", (q) => q.eq("flowId", flowId))
      .collect();
    for (const s of sessions) {
      if (s.status === "running" || s.status === "waiting") {
        await ctx.db.patch(s._id, { status: "cancelled", updatedAt: Date.now() });
      }
    }
    await ctx.db.delete(flowId);
    return null;
  },
});

/** Recent runs of a workflow (for its stats in the editor). */
export const runs = query({
  args: { flowId: v.id("flows"), limit: v.optional(v.number()) },
  returns: v.array(runSummary),
  handler: async (ctx, { flowId, limit }) => {
    const rows = await ctx.db
      .query("flowSessions")
      .withIndex("by_flow", (q) => q.eq("flowId", flowId))
      .order("desc")
      .take(Math.min(Math.max(limit ?? 50, 1), 200));
    return rows
      .filter((r) => !r.dryRun)
      .map((r) => ({
        _id: r._id,
        conversationId: r.conversationId,
        contact: r.contact,
        status: r.status,
        nodeId: r.nodeId,
        version: r.version,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        ...(r.error !== undefined ? { error: r.error } : {}),
      }));
  },
});
