/**
 * In-memory run of a workflow graph, with the engine's semantics, for tests:
 * no Convex, the host's actions and texts are plain callbacks.
 *
 * ```ts
 * const sim = new FlowSimulation(graph, { contact, host: { action, texts, flows } });
 * await sim.start({ text: "AVIS" });
 * await sim.reply({ text: "Chez Léon", replyId: "choice:r1" });
 * ```
 */

import {
  chosenItem,
  delayMs,
  dynamicItems,
  evaluateCondition,
  inputMatchesTrigger,
  interpolate,
  keywordRemainder,
  nextNodeId,
  pickChoice,
  readAnswer,
  renderMessage,
  renderQuestion,
  buildHttpRequest,
  segmentsMatch,
  textKeysOf,
  type FlowScope,
} from "./flowRuntime.js";
import {
  CHOICE_ID_PREFIX,
  outputsOf,
  type AskNodeData,
  type HostHttpResult,
  type HttpRequestSpec,
  type FlowContact,
  type FlowGraph,
  type FlowInput,
  type FlowNodeData,
  type HostActionResult,
  type MessageNodeData,
  type Trigger,
} from "./flowTypes.js";
import type { OutboundMessage } from "./types.js";

const MAX_STEPS = 60;
const MAX_CALL_DEPTH = 5;

export type SimulationHost = {
  /** Runs a host action (params already interpolated). */
  action?: (
    name: string,
    params: Record<string, string>,
    run: { vars: Record<string, unknown>; contact: FlowContact },
  ) => HostActionResult | Promise<HostActionResult>;
  /** Resolves `{{t.key}}` texts. */
  texts?: (
    keys: string[],
    run: { vars: Record<string, unknown>; contact: FlowContact },
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Graphs `flow` nodes may run, by flow id. */
  flows?: Record<string, FlowGraph>;
  /** Answers `http` nodes (a fake API in tests); without it they follow `error`. */
  http?: (request: HttpRequestSpec) => HostHttpResult | Promise<HostHttpResult>;
};

export type SimulationStatus = "running" | "waiting" | "done" | "failed";

export type SimulationStep = {
  /** False when the reply led nowhere: the host's own bot would answer it. */
  handled: boolean;
  status: SimulationStatus;
  waitKind?: "reply" | "delay" | "event";
  waitEvent?: string;
  messages: OutboundMessage[];
  /** Host actions run during the step, in order. */
  actions: Array<{ name: string; params: Record<string, string>; output: string }>;
  /** Requests `http` nodes sent during the step, in order (secrets not filled). */
  requests: Array<{ request: HttpRequestSpec; status: number; ok: boolean }>;
  trace: string[];
  error?: string;
};

type Frame = { flowId: string; graph: FlowGraph; nodeId: string };

/** Whether a graph's trigger accepts this inbound message. */
export function triggerMatches(
  graph: FlowGraph,
  input: FlowInput,
  options: { isFirstMessage?: boolean; segments?: string[] } = {},
): Trigger | null {
  const node = graph.nodes.find((n) => n.type === "trigger");
  const triggers = ((node?.data as { triggers?: Trigger[] } | undefined)?.triggers ?? []) as Trigger[];
  return (
    triggers.find(
      (t) => segmentsMatch(t, options.segments) && inputMatchesTrigger(t, input, options.isFirstMessage ?? false),
    ) ?? null
  );
}

export class FlowSimulation {
  graph: FlowGraph;
  flowId: string;
  stack: Frame[] = [];
  nodeId = "";
  status: SimulationStatus = "running";
  waitKind?: "reply" | "delay" | "event";
  waitEvent?: string;
  waitChoices?: Array<{ id: string; title: string }>;
  /** Contact marked for a human (`handoff`). */
  handedOff = false;
  /** The last message was given back to the host (`release`). */
  released = false;
  scope: FlowScope;
  private step: SimulationStep = { handled: true, status: "running", messages: [], actions: [], requests: [], trace: [] };

  constructor(
    graph: FlowGraph,
    private options: { contact: FlowContact; host?: SimulationHost; vars?: Record<string, unknown>; flowId?: string },
  ) {
    this.graph = graph;
    this.flowId = options.flowId ?? "root";
    this.scope = { contact: options.contact, vars: { ...(options.vars ?? {}) }, last: {}, t: {} };
  }

  get vars(): Record<string, unknown> {
    return this.scope.vars;
  }

  /**
   * Runs from the trigger, as if `input` had started the workflow. Sets the
   * same `vars.trigger_*` as the engine (the trigger that matches for the
   * contact's segments, else `api`).
   */
  async start(input: FlowInput = { text: "" }, options: { isFirstMessage?: boolean } = {}): Promise<SimulationStep> {
    this.begin(input);
    const matched = triggerMatches(this.graph, input, {
      isFirstMessage: options.isFirstMessage,
      segments: this.scope.contact.segments,
    });
    this.scope.vars.trigger_kind = matched?.kind ?? "api";
    this.scope.vars.trigger_text = input.text;
    if (matched?.kind === "keyword") this.scope.vars.trigger_rest = keywordRemainder(matched, input.text);
    const trigger = this.graph.nodes.find((n) => n.type === "trigger");
    if (!trigger) return this.end("failed", "no_trigger");
    this.nodeId = trigger.id;
    await this.advance(trigger.id);
    return this.step;
  }

  /** Answers the node the run waits on. */
  async reply(input: FlowInput): Promise<SimulationStep> {
    this.begin(input);
    if (this.status !== "waiting" || this.waitKind !== "reply") {
      this.step.handled = false;
      return this.snapshot();
    }
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    let handle = "other";
    if (node?.type === "message") {
      const data = node.data as MessageNodeData;
      handle = pickChoice(data, input, this.waitChoices);
      if (data.choices && handle.startsWith(CHOICE_ID_PREFIX)) {
        this.scope.vars[data.choices.saveAs] = chosenItem(data, this.scope, handle);
        handle = "chosen";
      }
    } else if (node?.type === "ask") {
      const data = node.data as AskNodeData;
      const answer = readAnswer(data, input);
      handle = answer.handle;
      if (answer.handle === "reply") this.scope.vars[data.saveAs] = answer.value;
    }
    const next = node ? nextNodeId(this.graph, node.id, handle) : undefined;
    if (!next) {
      this.step.handled = false;
      this.stack = [];
      return this.end("done");
    }
    this.status = "running";
    await this.advance(next);
    return this.step;
  }

  /** The host signals an event (`wait_event`). */
  async event(name: string, data?: unknown): Promise<SimulationStep> {
    this.begin();
    if (this.status !== "waiting" || this.waitKind !== "event" || this.waitEvent !== name) {
      this.step.handled = false;
      return this.snapshot();
    }
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    const saveAs = node?.type === "wait_event" ? (node.data as FlowNodeData["wait_event"]).saveAs : undefined;
    if (saveAs) this.scope.vars[saveAs] = data ?? null;
    this.status = "running";
    await this.advance(nextNodeId(this.graph, this.nodeId, "received"));
    return this.step;
  }

  /** The wait times out (ask, choice, event). */
  async timeout(): Promise<SimulationStep> {
    this.begin();
    if (this.status !== "waiting") return this.snapshot();
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    if (node?.type === "message" && !outputsOf(node).includes("timeout")) return this.end("done");
    this.status = "running";
    await this.advance(nextNodeId(this.graph, this.nodeId, node?.type === "delay" ? "next" : "timeout"));
    return this.step;
  }

  private begin(input?: FlowInput) {
    if (input) this.scope.last = input;
    this.released = false;
    // Like the engine, texts are looked up again for each message.
    this.scope.t = {};
    this.step = { handled: true, status: this.status, messages: [], actions: [], requests: [], trace: [] };
  }

  private snapshot(): SimulationStep {
    this.step.status = this.status;
    this.step.waitKind = this.status === "waiting" ? this.waitKind : undefined;
    this.step.waitEvent = this.status === "waiting" ? this.waitEvent : undefined;
    return this.step;
  }

  private end(status: "done" | "failed", error?: string): SimulationStep {
    this.status = status;
    this.waitKind = undefined;
    this.waitEvent = undefined;
    if (error) this.step.error = error;
    return this.snapshot();
  }

  private wait(nodeId: string, kind: "reply" | "delay" | "event", extra: { choices?: Array<{ id: string; title: string }>; event?: string } = {}) {
    this.nodeId = nodeId;
    this.status = "waiting";
    this.waitKind = kind;
    this.waitChoices = extra.choices;
    this.waitEvent = extra.event;
    return this.snapshot();
  }

  private async loadTexts(data: unknown) {
    const host = this.options.host;
    if (!host?.texts) return;
    const missing = textKeysOf(data).filter((k) => !(k in (this.scope.t ?? {})));
    if (!missing.length) return;
    const texts = await host.texts(missing, { vars: this.scope.vars, contact: this.scope.contact });
    this.scope.t = { ...this.scope.t, ...texts };
  }

  private async advance(startNodeId: string | undefined): Promise<SimulationStep> {
    let current = startNodeId;
    for (let steps = 0; ; steps++) {
      if (steps >= MAX_STEPS) return this.end("failed", "too_many_steps");
      if (!current) {
        const frame = this.stack.pop();
        if (!frame) break;
        this.graph = frame.graph;
        this.flowId = frame.flowId;
        this.nodeId = frame.nodeId;
        current = nextNodeId(this.graph, frame.nodeId, "next");
        continue;
      }
      const node = this.graph.nodes.find((n) => n.id === current);
      if (!node) {
        current = undefined;
        continue;
      }
      this.nodeId = node.id;
      this.step.trace.push(node.id);

      switch (node.type) {
        case "trigger":
          current = nextNodeId(this.graph, node.id, "next");
          break;
        case "message": {
          const data = node.data as MessageNodeData;
          await this.loadTexts(data);
          if (data.choices && dynamicItems(data, this.scope).length === 0) {
            current = nextNodeId(this.graph, node.id, "empty");
            break;
          }
          const message = renderMessage(data, this.scope);
          this.step.messages.push(message);
          if (outputsOf(node).includes("other")) {
            const choices =
              message.type === "buttons"
                ? message.buttons.map((b) => ({ id: b.id, title: b.title }))
                : message.type === "list"
                  ? message.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })))
                  : undefined;
            return this.wait(node.id, "reply", { choices });
          }
          current = nextNodeId(this.graph, node.id, "next");
          break;
        }
        case "ask": {
          const data = node.data as AskNodeData;
          await this.loadTexts(data);
          this.step.messages.push(renderQuestion(data, this.scope));
          return this.wait(node.id, "reply");
        }
        case "condition":
          current = nextNodeId(
            this.graph,
            node.id,
            evaluateCondition(node.data as FlowNodeData["condition"], this.scope) ? "true" : "false",
          );
          break;
        case "delay":
          // Like the engine's dry run: no waiting.
          void delayMs(node.data as FlowNodeData["delay"]);
          current = nextNodeId(this.graph, node.id, "next");
          break;
        case "wait_event":
          return this.wait(node.id, "event", { event: (node.data as FlowNodeData["wait_event"]).event.trim() });
        case "action": {
          const data = node.data as FlowNodeData["action"];
          const params: Record<string, string> = {};
          for (const [k, value] of Object.entries(data.params ?? {})) params[k] = interpolate(value, this.scope);
          let out: HostActionResult;
          try {
            out = this.options.host?.action
              ? await this.options.host.action(data.action, params, { vars: this.scope.vars, contact: this.scope.contact })
              : { output: "error", result: "no action handler" };
          } catch (e) {
            out = { output: "error", result: e instanceof Error ? e.message : String(e) };
          }
          this.step.actions.push({ name: data.action, params, output: out.output });
          if (data.saveAs) this.scope.vars[data.saveAs] = out.result ?? null;
          this.step.messages.push(...(out.messages ?? []));
          current = nextNodeId(this.graph, node.id, out.output);
          break;
        }
        case "http": {
          const data = node.data as FlowNodeData["http"];
          const request = buildHttpRequest(data, this.scope);
          let res: HostHttpResult;
          try {
            res = this.options.host?.http
              ? await this.options.host.http(request)
              : { ok: false, status: 0, error: "no http handler" };
          } catch (e) {
            res = { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
          }
          this.step.requests.push({ request, status: res.status, ok: res.ok });
          if (data.saveAs) {
            this.scope.vars[data.saveAs] = { status: res.status, body: res.body ?? null, ...(res.error ? { error: res.error } : {}) };
          }
          current = nextNodeId(this.graph, node.id, res.ok ? "ok" : "error");
          break;
        }
        case "set_variable": {
          const data = node.data as FlowNodeData["set_variable"];
          this.scope.vars[data.name] = interpolate(data.value ?? "", this.scope);
          current = nextNodeId(this.graph, node.id, "next");
          break;
        }
        case "flow": {
          const data = node.data as FlowNodeData["flow"];
          if (data.returnAfter && this.stack.length >= MAX_CALL_DEPTH) return this.end("failed", "flow_depth");
          const target = this.options.host?.flows?.[data.flowId];
          if (!target) return this.end("failed", "flow_not_found");
          if (data.returnAfter) this.stack.push({ flowId: this.flowId, graph: this.graph, nodeId: node.id });
          this.graph = target;
          this.flowId = data.flowId;
          const entry = target.nodes.find((n) => n.type === "trigger");
          if (entry) this.step.trace.push(entry.id);
          current = entry ? nextNodeId(target, entry.id, "next") : undefined;
          break;
        }
        case "handoff":
          this.handedOff = true;
          this.stack = [];
          return this.end("done");
        case "end":
          current = undefined;
          break;
        case "release":
          this.released = true;
          this.step.handled = false;
          this.stack = [];
          return this.end("done");
      }
    }
    return this.end("done");
  }
}
