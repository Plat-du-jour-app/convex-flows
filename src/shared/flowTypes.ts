/**
 * Workflow graphs: what the editor saves and the engine runs.
 *
 * A graph has one `trigger` node (when the workflow starts) and nodes linked
 * by edges. An edge leaves a node through a named output (`sourceHandle`):
 * `next` for linear nodes, one handle per button/row for choices, `reply` /
 * `other` / `timeout` when waiting for an answer, `true` / `false` for
 * conditions, and the outputs an action declares.
 */

export type TriggerRule =
  /** The message text matches a keyword (accents and case ignored). */
  | { kind: "keyword"; keywords: string[]; match: "exact" | "contains" | "startsWith" }
  /** The contact's very first message. */
  | { kind: "first_message" }
  /** The contact shares a location. */
  | { kind: "location" }
  /** The contact sends a photo. */
  | { kind: "image" }
  /** Started by the host's code (`startFlow`), e.g. after a reservation. */
  | { kind: "api" }
  /** Any message (lowest priority): a fallback or a welcome for unknown contacts. */
  | { kind: "any" };

export type Trigger = TriggerRule & {
  /**
   * Audiences the contact must belong to (one is enough), from the host's
   * segment catalog: e.g. "new contact", "customer". Absent: everyone.
   */
  segments?: string[];
};

export type TriggerKind = Trigger["kind"];

/** A contact audience the host computes for each inbound message. */
export type SegmentDefinition = { id: string; label: string; description?: string };

export type ChoiceOption = { id: string; title: string; description?: string };

/** An inbox account (WhatsApp number, Instagram account…) a workflow listens on. */
export type FlowAccount = { id: string; platform: string; label?: string };

export type MessageNodeData = {
  text: string;
  /** Image shown with the text (header of a button message, or captioned image). */
  mediaUrl?: string;
  /** Up to 3 reply buttons; the workflow waits and follows the tapped one. */
  buttons?: ChoiceOption[];
  /** A list (up to 10 rows); the workflow waits and follows the chosen row. */
  list?: { buttonLabel: string; rows: ChoiceOption[] };
  /** A single link button. */
  link?: { title: string; url: string };
  /**
   * Options computed at run time from a variable holding a list of
   * `{ id, title, description? }` (e.g. an action's result): sent before the
   * fixed buttons/rows. The chosen item is stored in `vars[saveAs]` and the
   * run follows `chosen`; an empty list follows `empty` without sending.
   */
  choices?: { from: string; saveAs: string };
  /**
   * With options: minutes to wait for a pick before following `timeout`
   * (without it, an unanswered choice just expires after a day).
   */
  timeoutMinutes?: number;
};

export type AskNodeData = {
  text: string;
  /** Variable that receives the answer (`{{vars.<saveAs>}}`). */
  saveAs: string;
  expect: "text" | "location" | "image" | "any";
  /** Minutes to wait before following `timeout` (default 24h). */
  timeoutMinutes?: number;
};

export type ConditionRule = {
  /** `vars.x`, `contact.name`, `last.text`… */
  variable: string;
  /** `one_of` / `contains_any` / `starts_with` take a comma-separated list. */
  operator:
    | "equals"
    | "not_equals"
    | "contains"
    | "one_of"
    | "contains_any"
    | "starts_with"
    | "exists"
    | "not_exists"
    | "greater_than"
    | "less_than";
  value?: string;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Calls an external URL (Make, n8n, a CRM…) and follows `ok` (2xx) or `error`.
 * `{{vars.x}}` placeholders are filled (URL-encoded in the URL, JSON-escaped in
 * the body); `{{secret.NAME}}` is left for the host, so a key never sits in
 * the graph. The host decides which domains may be called.
 */
export type HttpNodeData = {
  method: HttpMethod;
  /** https URL; its host name is written out, never a placeholder. */
  url: string;
  headers?: Array<{ name: string; value: string }>;
  /** JSON sent with POST / PUT / PATCH (placeholders go inside quotes; numbers may stand alone). */
  body?: string;
  /** Receives `{ status, body }`, the body parsed when it is JSON. */
  saveAs?: string;
  /** Seconds before giving up: 10 by default, 30 at most (the contact is waiting). */
  timeoutSeconds?: number;
};

export type FlowNodeData = {
  /**
   * `accounts`: the inbox accounts the workflow answers on. A workflow with
   * none only runs where the host allows unscoped workflows.
   */
  trigger: { triggers: Trigger[]; accounts?: FlowAccount[] };
  message: MessageNodeData;
  ask: AskNodeData;
  condition: { rules: ConditionRule[]; mode: "all" | "any" };
  delay: { amount: number; unit: "minutes" | "hours" | "days" };
  /** Runs an action the host registered (`params` support {{variables}}). */
  action: { action: string; params: Record<string, string>; saveAs?: string };
  set_variable: { name: string; value: string };
  /**
   * Runs another workflow (its published version; the draft in the
   * simulator), with the same variables. With `returnAfter`, this workflow
   * continues at `next` once the other one ends; otherwise it ends here.
   */
  flow: { flowId: string; returnAfter?: boolean };
  /**
   * Waits until the host signals `event` for the conversation (payment done,
   * account connected, photo ready…): follows `received`, the event's data
   * in `vars[saveAs]`, or `timeout`.
   */
  wait_event: { event: string; saveAs?: string; timeoutMinutes?: number };
  http: HttpNodeData;
  /** Hands the conversation to a human: the bot stops answering it. */
  handoff: { note?: string };
  /**
   * Ends the run and gives the contact's last message back to the host, as if
   * no workflow had taken it (its own bot, or another workflow, answers).
   */
  release: Record<string, never>;
  end: Record<string, never>;
};

export type FlowNodeType = keyof FlowNodeData;

export type FlowNode<T extends FlowNodeType = FlowNodeType> = {
  id: string;
  type: T;
  position: { x: number; y: number };
  data: FlowNodeData[T];
};

export type FlowEdge = {
  id: string;
  source: string;
  /** Output of the source node (defaults to `next`). */
  sourceHandle?: string;
  target: string;
};

export type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] };

/** An action the host exposes to the editor and runs for the engine. */
export type ActionDefinition = {
  name: string;
  label: string;
  description?: string;
  params: Array<{ name: string; label: string; placeholder?: string; required?: boolean }>;
  /** Named outputs the action can follow (e.g. `found` / `none`). */
  outputs: Array<{ id: string; label: string }>;
};

/** Inbound message as the engine sees it. */
export type FlowInput = {
  text: string;
  /** Id of the tapped button / list row / quick reply, when there is one. */
  replyId?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  imageUrl?: string;
};

export type FlowContact = {
  id: string;
  name?: string;
  phone?: string;
  locale?: string;
  /** Audiences the contact belongs to (see trigger `segments`). */
  segments?: string[];
};

/** Prefix of the ids of options built from `choices` (vs. fixed buttons). */
export const CHOICE_ID_PREFIX = "choice:";

export const TERMINAL_NODES: ReadonlySet<FlowNodeType> = new Set(["handoff", "end", "release"]);

/** Output handles a node exposes (for the editor and for validation). */
export function outputsOf(node: FlowNode, actions: ActionDefinition[] = []): string[] {
  switch (node.type) {
    case "trigger":
    case "delay":
    case "set_variable":
      return ["next"];
    case "message": {
      const d = node.data as MessageNodeData;
      const options = d.list?.rows?.length ? d.list.rows : (d.buttons ?? []);
      const timeout = d.timeoutMinutes && d.timeoutMinutes > 0 ? ["timeout"] : [];
      if (d.choices) return [...options.map((o) => o.id), "chosen", "empty", "other", ...timeout];
      return options.length ? [...options.map((o) => o.id), "other", ...timeout] : ["next"];
    }
    case "ask":
      return ["reply", "other", "timeout"];
    case "condition":
      return ["true", "false"];
    case "action": {
      const name = (node.data as FlowNodeData["action"]).action;
      const def = actions.find((a) => a.name === name);
      return def ? def.outputs.map((o) => o.id) : ["success", "error"];
    }
    case "flow":
      return (node.data as FlowNodeData["flow"]).returnAfter ? ["next"] : [];
    case "wait_event":
      return ["received", "timeout"];
    case "http":
      return ["ok", "error"];
    case "handoff":
    case "end":
    case "release":
      return [];
  }
}

// ─── Contract between the engine and the host app ───
// The host passes two function handles (createFunctionHandle) when it hands an
// inbound message to the engine: one that delivers a message on its channel
// (and stores it where the host keeps its history), one that runs its actions.

export type HostSendArgs = {
  conversationId: string;
  platform: string;
  accountId?: string;
  /** Opaque value the host gave the engine with the inbound message. */
  hostContext: unknown;
  message: import("./types.js").OutboundMessage;
};

export type HostSendResult = { ok: boolean; messageId?: string | null };

export type HostActionArgs = {
  name: string;
  params: Record<string, string>;
  conversationId: string;
  platform: string;
  accountId?: string;
  hostContext: unknown;
  contact: FlowContact;
  vars: Record<string, unknown>;
  /** True in the editor's simulator: compute, but send and change nothing. */
  dryRun: boolean;
};

/**
 * Text tokens: `{{t.<key>}}` in a node is replaced by the host's text for that
 * key, in the contact's language (the host fills its own `{placeholders}`
 * from `contact` and `vars`).
 */
export type HostTextsArgs = {
  keys: string[];
  locale?: string;
  contact: FlowContact;
  vars: Record<string, unknown>;
  hostContext: unknown;
};

export type HostTextsResult = Record<string, string>;

/** The request an `http` node asks the host to send (placeholders filled, secrets not). */
export type HttpRequestSpec = {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

export type HostHttpArgs = {
  request: HttpRequestSpec;
  conversationId: string;
  platform: string;
  accountId?: string;
  hostContext: unknown;
  contact: FlowContact;
};

export type HostHttpResult = {
  /** True for a 2xx answer: the node follows `ok`, otherwise `error`. */
  ok: boolean;
  /** HTTP status, 0 when no answer came back (refused, timeout, network). */
  status: number;
  /** Response body, parsed when it is JSON. */
  body?: unknown;
  error?: string;
  /** The editor's simulator did not send the request. */
  skipped?: boolean;
};

export type HostActionResult = {
  /** Which of the action's declared outputs to follow. */
  output: string;
  /** Stored in `vars[saveAs]` when the node has one. */
  result?: unknown;
  /** Messages the engine sends next (the host never sends them itself). */
  messages?: Array<import("./types.js").OutboundMessage>;
};
