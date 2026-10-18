import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { action, internalAction, internalMutation, internalQuery, mutation, type ActionCtx } from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  accountMatches,
  chosenItem,
  delayMs,
  dynamicItems,
  segmentsMatch,
  keywordRemainder,
  textKeysOf,
  evaluateCondition,
  inputMatchesTrigger,
  interpolate,
  nextNodeId,
  pickChoice,
  readAnswer,
  renderMessage,
  renderQuestion,
  buildHttpRequest,
  type FlowScope,
} from "../shared/flowRuntime.js";
import {
  CHOICE_ID_PREFIX,
  outputsOf,
  type AskNodeData,
  type FlowContact,
  type FlowGraph,
  type FlowInput,
  type FlowNode,
  type FlowNodeData,
  type HostActionArgs,
  type HostActionResult,
  type HostHttpArgs,
  type HostHttpResult,
  type HostSendArgs,
  type HostSendResult,
  type HostTextsArgs,
  type HostTextsResult,
  type MessageNodeData,
  type Trigger,
  type TriggerKind,
} from "../shared/flowTypes.js";
import type { OutboundMessage } from "../shared/types.js";

/** Guards against graphs that loop without ever waiting. */
const MAX_STEPS = 60;
/** A run left "running" longer than this crashed: the next message may start over. */
const STALE_RUN_MS = 2 * 60 * 1000;
/** Unanswered choices stop waiting after a day. */
const CHOICE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ASK_TIMEOUT_MIN = 24 * 60;
/** Workflows running workflows (`flow` nodes with return), at most this deep. */
const MAX_CALL_DEPTH = 5;
/** Triggers too generic to interrupt a run that sleeps (delay, event). */
const BACKGROUND_TRIGGERS: ReadonlySet<TriggerKind> = new Set(["any", "first_message"]);

const inputValidator = v.object({
  text: v.string(),
  replyId: v.optional(v.string()),
  location: v.optional(
    v.object({
      latitude: v.number(),
      longitude: v.number(),
      name: v.optional(v.string()),
      address: v.optional(v.string()),
    }),
  ),
  imageUrl: v.optional(v.string()),
});

const contactValidator = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  phone: v.optional(v.string()),
  /** Contact language, for `{{t.key}}` texts and conditions. */
  locale: v.optional(v.string()),
  /** Audiences the contact belongs to (see trigger `segments`). */
  segments: v.optional(v.array(v.string())),
});

const hostArgs = {
  conversationId: v.string(),
  ownerId: v.optional(v.string()),
  platform: v.string(),
  accountId: v.optional(v.string()),
  contact: contactValidator,
  /** Opaque value passed back to the host's handles (channel, chat id…). */
  hostContext: v.optional(v.any()),
  sendHandle: v.string(),
  actionHandle: v.optional(v.string()),
  /** Resolves `{{t.key}}` texts (see HostTextsArgs). */
  textsHandle: v.optional(v.string()),
  /** Sends `http` node requests (see HostHttpArgs and `performHttpRequest`). */
  httpHandle: v.optional(v.string()),
  dryRun: v.optional(v.boolean()),
};

const statusValidator = v.union(
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("cancelled"),
  v.literal("failed"),
);

const runResultValidator = v.object({
  handled: v.boolean(),
  sessionId: v.optional(v.id("flowSessions")),
  flowId: v.optional(v.id("flows")),
  status: v.optional(statusValidator),
  /** Event the run now waits for (`wait_event`), if any. */
  waitEvent: v.optional(v.string()),
  /**
   * The run let go of the message (`release` node, or a reply with no branch):
   * it ended, and the message is free for the host or another workflow.
   */
  released: v.optional(v.boolean()),
  /**
   * The conversation's run is busy with an earlier message: this one was not
   * processed. The host should hand it in again a few seconds later.
   */
  busy: v.optional(v.boolean()),
  messages: v.array(v.any()),
  trace: v.array(v.string()),
});

type Session = Doc<"flowSessions">;
type Frame = NonNullable<Session["stack"]>[number];
type Candidate = { flowId: Id<"flows">; trigger: Trigger; rank: number; accountIds: string[] };

type RunResult = {
  handled: boolean;
  sessionId?: Id<"flowSessions">;
  flowId?: Id<"flows">;
  status?: Session["status"];
  waitEvent?: string;
  released?: boolean;
  busy?: boolean;
  /** Messages sent during this step (or that would be, in a dry run). */
  messages: OutboundMessage[];
  /** Node ids visited, in order. */
  trace: string[];
};

// ─── Session storage ───

export const _active = internalQuery({
  args: { conversationId: v.string() },
  handler: async (ctx, { conversationId }): Promise<Session | null> => {
    for (const status of ["waiting", "running"] as const) {
      const row = await ctx.db
        .query("flowSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId).eq("status", status))
        .order("desc")
        .first();
      if (row) return row;
    }
    return null;
  },
});

export const _candidates = internalQuery({
  args: { ownerId: v.optional(v.string()) },
  handler: async (ctx, { ownerId }): Promise<Candidate[]> => {
    const rows = await ctx.db
      .query("flowTriggers")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(500);
    return rows.map((r) => ({
      flowId: r.flowId,
      trigger: r.trigger as Trigger,
      rank: r.rank,
      accountIds: r.accountIds ?? [],
    }));
  },
});

/** The graph a `flow` node runs: published, or the draft in the simulator. */
export const _loadFlow = internalQuery({
  args: { flowId: v.string(), useDraft: v.boolean() },
  handler: async (ctx, { flowId, useDraft }): Promise<{ flowId: Id<"flows">; version: number; graph: FlowGraph } | null> => {
    const id = ctx.db.normalizeId("flows", flowId);
    const flow = id ? await ctx.db.get(id) : null;
    if (!flow) return null;
    const graph = (useDraft ? (flow.draft ?? flow.published) : flow.published) as FlowGraph | undefined;
    if (!graph?.nodes) return null;
    return { flowId: flow._id, version: flow.version, graph };
  },
});

export const _start = internalMutation({
  args: {
    flowId: v.id("flows"),
    conversationId: v.string(),
    platform: v.string(),
    accountId: v.optional(v.string()),
    contact: contactValidator,
    hostContext: v.optional(v.any()),
    sendHandle: v.string(),
    actionHandle: v.optional(v.string()),
    textsHandle: v.optional(v.string()),
    httpHandle: v.optional(v.string()),
    dryRun: v.boolean(),
    input: inputValidator,
    useDraft: v.optional(v.boolean()),
    /** Variables the run starts with (e.g. what followed the keyword). */
    initialVars: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<Session | null> => {
    const flow = await ctx.db.get(args.flowId);
    const graph = (args.useDraft ? flow?.draft : flow?.published) as FlowGraph | undefined;
    if (!flow || !graph) return null;
    const trigger = graph.nodes.find((n) => n.type === "trigger");
    if (!trigger) return null;
    // One run at a time per conversation: a new start replaces older ones.
    for (const status of ["running", "waiting"] as const) {
      const older = await ctx.db
        .query("flowSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId).eq("status", status))
        .collect();
      for (const s of older) await ctx.db.patch(s._id, { status: "cancelled", updatedAt: Date.now() });
    }
    const now = Date.now();
    const id = await ctx.db.insert("flowSessions", {
      conversationId: args.conversationId,
      flowId: args.flowId,
      version: flow.version,
      graph,
      status: "running",
      nodeId: trigger.id,
      waitToken: 0,
      vars: args.initialVars ?? {},
      last: args.input,
      contact: args.contact,
      platform: args.platform,
      accountId: args.accountId,
      hostContext: args.hostContext ?? null,
      sendHandle: args.sendHandle,
      actionHandle: args.actionHandle,
      textsHandle: args.textsHandle,
      httpHandle: args.httpHandle,
      dryRun: args.dryRun,
      startedAt: now,
      updatedAt: now,
    });
    return ctx.db.get(id);
  },
});

/** Moves a waiting run to running, once. Returns null if someone else did. */
export const _claim = internalMutation({
  args: { sessionId: v.id("flowSessions"), waitToken: v.number() },
  handler: async (ctx, { sessionId, waitToken }): Promise<Session | null> => {
    const s = await ctx.db.get(sessionId);
    if (!s || s.status !== "waiting" || s.waitToken !== waitToken) return null;
    await ctx.db.patch(sessionId, { status: "running", updatedAt: Date.now() });
    return { ...s, status: "running" as const };
  },
});

const frameValidator = v.object({ flowId: v.id("flows"), version: v.number(), graph: v.any(), nodeId: v.string() });

export const _save = internalMutation({
  args: {
    sessionId: v.id("flowSessions"),
    status: v.union(v.literal("running"), v.literal("waiting"), v.literal("done"), v.literal("cancelled"), v.literal("failed")),
    nodeId: v.string(),
    waitKind: v.optional(v.union(v.literal("reply"), v.literal("delay"), v.literal("event"))),
    waitEvent: v.optional(v.string()),
    waitToken: v.number(),
    vars: v.any(),
    last: v.any(),
    waitChoices: v.optional(v.array(v.object({ id: v.string(), title: v.string() }))),
    error: v.optional(v.string()),
    /** The workflow now running, when a `flow` node switched to another one. */
    frame: v.optional(
      v.object({ flowId: v.id("flows"), version: v.number(), graph: v.any(), stack: v.array(frameValidator) }),
    ),
  },
  handler: async (ctx, { sessionId, frame, ...patch }): Promise<void> => {
    await ctx.db.patch(sessionId, {
      ...patch,
      // Undefined removes the field: a run no longer waiting has no event.
      waitEvent: patch.status === "waiting" ? patch.waitEvent : undefined,
      ...(frame ?? {}),
      updatedAt: Date.now(),
    });
  },
});

// ─── Execution ───

type Run = {
  /** A `release` node gave the message back to the host. */
  released?: boolean;
  session: Session;
  graph: FlowGraph;
  scope: FlowScope;
  sent: OutboundMessage[];
  trace: string[];
  /** Workflows to return to (see `flow` nodes). */
  stack: Frame[];
  /** The running workflow changed since the session was loaded. */
  frameChanged: boolean;
};

function openRun(session: Session, input?: FlowInput): Run {
  return {
    session,
    stack: [...(session.stack ?? [])],
    frameChanged: false,
    graph: session.graph as FlowGraph,
    scope: {
      contact: session.contact as FlowContact,
      vars: { ...((session.vars as Record<string, unknown>) ?? {}) },
      last: (input ?? (session.last as FlowInput) ?? {}) as Partial<FlowInput>,
      t: {},
    },
    sent: [],
    trace: [],
  };
}

async function send(ctx: ActionCtx, run: Run, message: OutboundMessage) {
  if (run.session.dryRun) {
    run.sent.push(message);
    return;
  }
  const args: HostSendArgs = {
    conversationId: run.session.conversationId,
    platform: run.session.platform,
    accountId: run.session.accountId,
    hostContext: run.session.hostContext,
    message,
  };
  const result = (await ctx.runAction(
    run.session.sendHandle as FunctionHandle<"action", HostSendArgs, HostSendResult>,
    args,
  )) as HostSendResult;
  if (result?.ok) run.sent.push(message);
}

/** Fetches the host texts (`{{t.key}}`) a node needs and are not loaded yet. */
async function loadTexts(ctx: ActionCtx, run: Run, data: unknown) {
  if (!run.session.textsHandle) return;
  const missing = textKeysOf(data).filter((k) => !(k in (run.scope.t ?? {})));
  if (missing.length === 0) return;
  const args: HostTextsArgs = {
    keys: missing,
    locale: run.scope.contact.locale,
    contact: run.scope.contact,
    vars: run.scope.vars,
    hostContext: run.session.hostContext,
  };
  try {
    const texts = (await ctx.runAction(
      run.session.textsHandle as FunctionHandle<"action", HostTextsArgs, HostTextsResult>,
      args,
    )) as HostTextsResult;
    run.scope.t = { ...run.scope.t, ...texts };
  } catch {
    // Missing texts render empty rather than breaking the conversation.
  }
}

async function runHostAction(ctx: ActionCtx, run: Run, node: FlowNode<"action">): Promise<HostActionResult> {
  if (!run.session.actionHandle) return { output: "error", result: "no action handler" };
  const params: Record<string, string> = {};
  for (const [k, value] of Object.entries(node.data.params ?? {})) params[k] = interpolate(value, run.scope);
  const args: HostActionArgs = {
    name: node.data.action,
    params,
    conversationId: run.session.conversationId,
    platform: run.session.platform,
    accountId: run.session.accountId,
    hostContext: run.session.hostContext,
    contact: run.scope.contact,
    vars: run.scope.vars,
    dryRun: run.session.dryRun,
  };
  try {
    return (await ctx.runAction(
      run.session.actionHandle as FunctionHandle<"action", HostActionArgs, HostActionResult>,
      args,
    )) as HostActionResult;
  } catch (e) {
    return { output: "error", result: e instanceof Error ? e.message : String(e) };
  }
}

/** Sends an `http` node's request through the host (never in the simulator). */
async function runHttp(ctx: ActionCtx, run: Run, node: FlowNode<"http">): Promise<HostHttpResult> {
  if (run.session.dryRun) return { ok: true, status: 0, body: null, skipped: true };
  if (!run.session.httpHandle) return { ok: false, status: 0, error: "no http handler" };
  const args: HostHttpArgs = {
    request: buildHttpRequest(node.data, run.scope),
    conversationId: run.session.conversationId,
    platform: run.session.platform,
    accountId: run.session.accountId,
    hostContext: run.session.hostContext,
    contact: run.scope.contact,
  };
  try {
    return (await ctx.runAction(
      run.session.httpHandle as FunctionHandle<"action", HostHttpArgs, HostHttpResult>,
      args,
    )) as HostHttpResult;
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** What `_save` needs to persist a change of running workflow. */
function framePatch(run: Run) {
  if (!run.frameChanged) return {};
  return {
    frame: { flowId: run.session.flowId, version: run.session.version, graph: run.graph, stack: run.stack },
  };
}

async function finish(ctx: ActionCtx, run: Run, nodeId: string, status: "done" | "failed" | "cancelled", error?: string) {
  await ctx.runMutation(internal.engine._save, {
    sessionId: run.session._id,
    status,
    nodeId,
    waitToken: run.session.waitToken,
    vars: run.scope.vars,
    last: run.scope.last,
    error,
    ...framePatch(run),
  });
  run.session = { ...run.session, status, nodeId };
}

async function wait(
  ctx: ActionCtx,
  run: Run,
  nodeId: string,
  waitKind: "reply" | "delay" | "event",
  ms: number,
  onTimer: string,
  extra: { waitChoices?: Array<{ id: string; title: string }>; waitEvent?: string } = {},
) {
  const waitToken = run.session.waitToken + 1;
  await ctx.runMutation(internal.engine._save, {
    sessionId: run.session._id,
    status: "waiting",
    nodeId,
    waitKind,
    waitToken,
    vars: run.scope.vars,
    last: run.scope.last,
    ...(extra.waitChoices ? { waitChoices: extra.waitChoices } : {}),
    ...(extra.waitEvent ? { waitEvent: extra.waitEvent } : {}),
    ...framePatch(run),
  });
  run.frameChanged = false;
  run.session = { ...run.session, status: "waiting", nodeId, waitKind, waitToken, waitEvent: extra.waitEvent };
  if (ms > 0 && !run.session.dryRun) {
    await ctx.scheduler.runAfter(ms, internal.engine._resume, {
      sessionId: run.session._id,
      waitToken,
      handle: onTimer,
    });
  }
}

/** Back to the workflow that ran this one (`flow` node with return), if any. */
function popFrame(run: Run): Frame | null {
  const frame = run.stack.pop();
  if (!frame) return null;
  run.session = { ...run.session, flowId: frame.flowId, version: frame.version };
  run.graph = frame.graph as FlowGraph;
  run.frameChanged = true;
  return frame;
}

/** The options a waiting `message` node was sent with (texts resolved). */
function sentOptions(message: OutboundMessage): Array<{ id: string; title: string }> | undefined {
  if (message.type === "buttons") return message.buttons.map((b) => ({ id: b.id, title: b.title }));
  if (message.type === "list") return message.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
  return undefined;
}

/** Runs nodes from `nodeId` until the workflow waits or ends. */
async function advance(ctx: ActionCtx, run: Run, startNodeId: string | undefined) {
  let current = startNodeId;
  let last = run.session.nodeId;
  for (let steps = 0; ; steps++) {
    if (steps >= MAX_STEPS) {
      run.released = true;
      return finish(ctx, run, last, "failed", "too_many_steps");
    }
    if (!current) {
      // This workflow is over: continue the one that ran it, if any.
      const frame = popFrame(run);
      if (!frame) break;
      last = frame.nodeId;
      current = nextNodeId(run.graph, frame.nodeId, "next");
      continue;
    }
    const node = run.graph.nodes.find((n) => n.id === current);
    if (!node) {
      current = undefined;
      continue;
    }
    last = node.id;
    run.trace.push(node.id);

    switch (node.type) {
      case "trigger":
        current = nextNodeId(run.graph, node.id, "next");
        break;

      case "message": {
        const data = node.data as MessageNodeData;
        await loadTexts(ctx, run, data);
        if (data.choices && dynamicItems(data, run.scope).length === 0) {
          current = nextNodeId(run.graph, node.id, "empty");
          break;
        }
        const message = renderMessage(data, run.scope);
        await send(ctx, run, message);
        if (outputsOf(node).includes("other")) {
          const minutes = data.timeoutMinutes && data.timeoutMinutes > 0 ? data.timeoutMinutes : 0;
          return minutes
            ? wait(ctx, run, node.id, "reply", minutes * 60_000, "timeout", { waitChoices: sentOptions(message) })
            : wait(ctx, run, node.id, "reply", CHOICE_EXPIRY_MS, "__expire", { waitChoices: sentOptions(message) });
        }
        current = nextNodeId(run.graph, node.id, "next");
        break;
      }

      case "ask": {
        const data = node.data as AskNodeData;
        await loadTexts(ctx, run, data);
        await send(ctx, run, renderQuestion(data, run.scope));
        const minutes = data.timeoutMinutes && data.timeoutMinutes > 0 ? data.timeoutMinutes : DEFAULT_ASK_TIMEOUT_MIN;
        return wait(ctx, run, node.id, "reply", minutes * 60_000, "timeout");
      }

      case "condition": {
        const ok = evaluateCondition(node.data as FlowNodeData["condition"], run.scope);
        current = nextNodeId(run.graph, node.id, ok ? "true" : "false");
        break;
      }

      case "delay": {
        const ms = delayMs(node.data as FlowNodeData["delay"]);
        if (run.session.dryRun) {
          current = nextNodeId(run.graph, node.id, "next");
          break;
        }
        return wait(ctx, run, node.id, "delay", ms, "next");
      }

      case "wait_event": {
        const data = node.data as FlowNodeData["wait_event"];
        const minutes = data.timeoutMinutes && data.timeoutMinutes > 0 ? data.timeoutMinutes : DEFAULT_ASK_TIMEOUT_MIN;
        return wait(ctx, run, node.id, "event", minutes * 60_000, "timeout", { waitEvent: data.event.trim() });
      }

      case "action": {
        const actionNode = node as FlowNode<"action">;
        const out = await runHostAction(ctx, run, actionNode);
        if (actionNode.data.saveAs) run.scope.vars[actionNode.data.saveAs] = out.result ?? null;
        for (const m of out.messages ?? []) await send(ctx, run, m);
        current = nextNodeId(run.graph, node.id, out.output);
        break;
      }

      case "http": {
        const httpNode = node as FlowNode<"http">;
        const res = await runHttp(ctx, run, httpNode);
        if (httpNode.data.saveAs) {
          run.scope.vars[httpNode.data.saveAs] = {
            status: res.status,
            body: res.body ?? null,
            ...(res.error ? { error: res.error } : {}),
            ...(res.skipped ? { skipped: true } : {}),
          };
        }
        current = nextNodeId(run.graph, node.id, res.ok ? "ok" : "error");
        break;
      }

      case "set_variable": {
        const data = node.data as FlowNodeData["set_variable"];
        run.scope.vars[data.name] = interpolate(data.value ?? "", run.scope);
        current = nextNodeId(run.graph, node.id, "next");
        break;
      }

      case "flow": {
        const data = node.data as FlowNodeData["flow"];
        // A broken call gives the message back to the host rather than swallow it.
        if (data.returnAfter && run.stack.length >= MAX_CALL_DEPTH) {
          run.released = true;
          return finish(ctx, run, node.id, "failed", "flow_depth");
        }
        const target = await ctx.runQuery(internal.engine._loadFlow, {
          flowId: data.flowId ?? "",
          useDraft: run.session.dryRun,
        });
        if (!target) {
          run.released = true;
          return finish(ctx, run, node.id, "failed", "flow_not_found");
        }
        if (data.returnAfter) {
          run.stack.push({ flowId: run.session.flowId, version: run.session.version, graph: run.graph, nodeId: node.id });
        }
        run.session = { ...run.session, flowId: target.flowId, version: target.version };
        run.graph = target.graph;
        run.frameChanged = true;
        const entry = target.graph.nodes.find((n) => n.type === "trigger");
        if (entry) run.trace.push(entry.id);
        current = entry ? nextNodeId(target.graph, entry.id, "next") : undefined;
        break;
      }

      case "handoff":
        if (!run.session.dryRun) {
          await ctx.runMutation(api.conversations.setBotPaused, {
            conversationId: run.session.conversationId,
            paused: true,
            by: "workflow",
          });
        }
        run.stack = [];
        return finish(ctx, run, node.id, "done");

      case "end":
        // Ends this workflow; the one that ran it (if any) continues.
        current = undefined;
        break;

      case "release":
        run.released = true;
        run.stack = [];
        return finish(ctx, run, node.id, "done");
    }
  }
  return finish(ctx, run, last, "done");
}

function result(run: Run, handled: boolean): RunResult {
  return {
    handled,
    ...(run.released ? { released: true } : {}),
    sessionId: run.session._id,
    flowId: run.session.flowId,
    status: run.session.status,
    ...(run.session.status === "waiting" && run.session.waitEvent ? { waitEvent: run.session.waitEvent } : {}),
    messages: run.sent,
    trace: run.trace,
  };
}

/**
 * Resumes a run waiting for a reply. Returns `handled: false` when the reply
 * leads nowhere (e.g. free text on a choice with no "other" branch): the run
 * ends and the host's own bot can answer the message.
 */
async function resumeWithReply(ctx: ActionCtx, session: Session, input: FlowInput): Promise<RunResult> {
  const run = openRun(session, input);
  const node = run.graph.nodes.find((n) => n.id === session.nodeId);
  if (!node) {
    await finish(ctx, run, session.nodeId, "done");
    return result(run, false);
  }
  let handle = "other";
  if (node.type === "message") {
    const data = node.data as MessageNodeData;
    handle = pickChoice(data, input, session.waitChoices);
    if (data.choices && handle.startsWith(CHOICE_ID_PREFIX)) {
      run.scope.vars[data.choices.saveAs] = chosenItem(data, run.scope, handle);
      handle = "chosen";
    }
  } else if (node.type === "ask") {
    const data = node.data as AskNodeData;
    const answer = readAnswer(data, input);
    handle = answer.handle;
    if (answer.handle === "reply") run.scope.vars[data.saveAs] = answer.value;
  }
  const next = nextNodeId(run.graph, node.id, handle);
  if (!next) {
    run.released = true;
    await finish(ctx, run, node.id, "done");
    return result(run, false);
  }
  await advance(ctx, run, next);
  return result(run, !run.released);
}

/**
 * Hands an inbound message to the engine: resumes the conversation's waiting
 * run, or starts the best-matching active workflow. `handled: false` means no
 * workflow took it and the host should process it as usual.
 */
export const handleInbound = action({
  args: {
    ...hostArgs,
    input: inputValidator,
    isFirstMessage: v.optional(v.boolean()),
    /** False while the host's own bot is mid-conversation: only resume, never start. */
    allowTriggers: v.optional(v.boolean()),
    /** Let workflows that pick no account start here (default: only workflows listing `accountId`). */
    allowUnscoped: v.optional(v.boolean()),
    /**
     * Only these trigger kinds may start a workflow (default: all). Lets the
     * host run keyword workflows before its own bot and `any` ones after it.
     */
    triggerKinds: v.optional(v.array(v.string())),
    /** Workflows that may not start for this message (e.g. the one that just released it). */
    excludeFlowIds: v.optional(v.array(v.string())),
  },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    const empty: RunResult = { handled: false, messages: [], trace: [] };
    const dryRun = args.dryRun ?? false;
    const active: Session | null = await ctx.runQuery(internal.engine._active, {
      conversationId: args.conversationId,
    });

    if (active?.status === "running" && Date.now() - active.updatedAt < STALE_RUN_MS) {
      // Another message is being processed for this run right now.
      return { ...empty, handled: true, busy: true, sessionId: active._id, flowId: active.flowId, status: "running" };
    }
    if (active?.status === "waiting" && active.waitKind === "reply") {
      const session: Session | null = await ctx.runMutation(internal.engine._claim, {
        sessionId: active._id,
        waitToken: active.waitToken,
      });
      // Null: a concurrent message claimed it first.
      if (!session) return { ...empty, handled: true };
      // Not handled = the run let go of the message (`released`): the host
      // answers it, or calls again to let another workflow start.
      return resumeWithReply(ctx, session, args.input);
    }
    // A run sleeping on a delay or an event: the message is not for it, but a
    // specific trigger (keyword, location…) may start something else.
    const sleeping = active?.status === "waiting";

    if (args.allowTriggers === false) return empty;
    const kinds = args.triggerKinds ? new Set(args.triggerKinds) : null;
    const excluded = new Set(args.excludeFlowIds ?? []);
    const candidates: Candidate[] = await ctx.runQuery(internal.engine._candidates, { ownerId: args.ownerId });
    const match = candidates
      .filter((c) => !excluded.has(c.flowId))
      .filter((c) => !kinds || kinds.has(c.trigger.kind))
      .filter((c) => !sleeping || !BACKGROUND_TRIGGERS.has(c.trigger.kind))
      .filter((c) => accountMatches(c.accountIds, args.accountId, args.allowUnscoped ?? false))
      .filter((c) => segmentsMatch(c.trigger, args.contact.segments))
      .filter((c) => inputMatchesTrigger(c.trigger, args.input, args.isFirstMessage ?? false))
      .sort((a, b) => b.rank - a.rank)[0];
    if (!match) return empty;

    const initialVars = {
      trigger_kind: match.trigger.kind,
      trigger_text: args.input.text,
      ...(match.trigger.kind === "keyword" ? { trigger_rest: keywordRemainder(match.trigger, args.input.text) } : {}),
    };
    const session: Session | null = await ctx.runMutation(internal.engine._start, {
      initialVars,
      flowId: match.flowId,
      conversationId: args.conversationId,
      platform: args.platform,
      accountId: args.accountId,
      contact: args.contact,
      hostContext: args.hostContext,
      sendHandle: args.sendHandle,
      actionHandle: args.actionHandle,
      textsHandle: args.textsHandle,
      httpHandle: args.httpHandle,
      dryRun,
      input: args.input,
    });
    if (!session) return empty;
    const run = openRun(session, args.input);
    await advance(ctx, run, session.nodeId);
    return result(run, !run.released);
  },
});

/**
 * Starts a given workflow for a conversation, whatever its triggers (host
 * code, "api" trigger, or the editor's simulator with `useDraft`).
 */
export const startFlow = action({
  args: {
    ...hostArgs,
    flowId: v.id("flows"),
    input: v.optional(inputValidator),
    useDraft: v.optional(v.boolean()),
    /** Variables the run starts with (`{{vars.x}}`), e.g. the order it is about. */
    vars: v.optional(v.any()),
  },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => {
    const input = args.input ?? { text: "" };
    const session: Session | null = await ctx.runMutation(internal.engine._start, {
      flowId: args.flowId,
      conversationId: args.conversationId,
      platform: args.platform,
      accountId: args.accountId,
      contact: args.contact,
      hostContext: args.hostContext,
      sendHandle: args.sendHandle,
      actionHandle: args.actionHandle,
      textsHandle: args.textsHandle,
      httpHandle: args.httpHandle,
      dryRun: args.dryRun ?? false,
      input,
      useDraft: args.useDraft,
      initialVars: { ...((args.vars as Record<string, unknown> | undefined) ?? {}), trigger_kind: "api", trigger_text: input.text },
    });
    if (!session) return { handled: false, messages: [], trace: [] };
    const run = openRun(session, input);
    await advance(ctx, run, session.nodeId);
    return result(run, !run.released);
  },
});

/** Timer continuation: delays, ask timeouts, expired choices. */
export const _resume = internalAction({
  args: { sessionId: v.id("flowSessions"), waitToken: v.number(), handle: v.string() },
  handler: async (ctx, { sessionId, waitToken, handle }): Promise<void> => {
    const session: Session | null = await ctx.runMutation(internal.engine._claim, { sessionId, waitToken });
    if (!session) return;
    const run = openRun(session);
    if (handle === "__expire") return finish(ctx, run, session.nodeId, "done");
    // No branch for the timer: this workflow ends (the caller, if any, goes on).
    await advance(ctx, run, nextNodeId(run.graph, session.nodeId, handle));
  },
});

async function resumeWithEvent(
  ctx: ActionCtx,
  args: { conversationId: string; event: string; data?: unknown },
): Promise<RunResult> {
  const waiting: Session | null = await ctx.runQuery(internal.engine._waitingFor, {
    conversationId: args.conversationId,
    event: args.event,
  });
  if (!waiting) return { handled: false, messages: [], trace: [] };
  const session: Session | null = await ctx.runMutation(internal.engine._claim, {
    sessionId: waiting._id,
    waitToken: waiting.waitToken,
  });
  if (!session) return { handled: false, messages: [], trace: [] };
  const run = openRun(session);
  const node = run.graph.nodes.find((n) => n.id === session.nodeId);
  const saveAs = node?.type === "wait_event" ? (node.data as FlowNodeData["wait_event"]).saveAs : undefined;
  if (saveAs) run.scope.vars[saveAs] = args.data ?? null;
  await advance(ctx, run, nextNodeId(run.graph, session.nodeId, "received"));
  return result(run, !run.released);
}

export const _waitingFor = internalQuery({
  args: { conversationId: v.string(), event: v.string() },
  handler: async (ctx, { conversationId, event }): Promise<Session | null> => {
    return ctx.db
      .query("flowSessions")
      .withIndex("by_conversation_event", (q) =>
        q.eq("conversationId", conversationId).eq("waitEvent", event).eq("status", "waiting"),
      )
      .order("desc")
      .first();
  },
});

export const _resumeEvent = internalAction({
  args: { conversationId: v.string(), event: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, args): Promise<void> => {
    await resumeWithEvent(ctx, args);
  },
});

/**
 * Signals an event to the conversation's run waiting for it (`wait_event`).
 * Callable from mutations: the run continues right after, in the background.
 */
export const emitEvent = mutation({
  args: { conversationId: v.string(), event: v.string(), data: v.optional(v.any()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const waiting = await ctx.db
      .query("flowSessions")
      .withIndex("by_conversation_event", (q) =>
        q.eq("conversationId", args.conversationId).eq("waitEvent", args.event).eq("status", "waiting"),
      )
      .first();
    if (!waiting) return false;
    await ctx.scheduler.runAfter(0, internal.engine._resumeEvent, args);
    return true;
  },
});

/** Same as `emitEvent`, but runs now and returns what was sent (simulator). */
export const deliverEvent = action({
  args: { conversationId: v.string(), event: v.string(), data: v.optional(v.any()) },
  returns: runResultValidator,
  handler: async (ctx, args): Promise<RunResult> => resumeWithEvent(ctx, args),
});

/** Stops the conversation's run (e.g. the contact typed STOP). */
export const cancel = mutation({
  args: { conversationId: v.string() },
  returns: v.number(),
  handler: async (ctx, { conversationId }) => {
    let count = 0;
    for (const status of ["running", "waiting"] as const) {
      const rows = await ctx.db
        .query("flowSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId).eq("status", status))
        .collect();
      for (const s of rows) {
        await ctx.db.patch(s._id, { status: "cancelled", updatedAt: Date.now() });
        count++;
      }
    }
    return count;
  },
});
