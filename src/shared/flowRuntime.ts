import type {
  ActionDefinition,
  AskNodeData,
  ChoiceOption,
  ConditionRule,
  FlowContact,
  FlowGraph,
  FlowInput,
  FlowNode,
  HttpNodeData,
  HttpRequestSpec,
  MessageNodeData,
  Trigger,
} from "./flowTypes.js";
import { CHOICE_ID_PREFIX, TERMINAL_NODES, outputsOf } from "./flowTypes.js";
import type { OutboundMessage } from "./types.js";

/** What `{{...}}` placeholders and conditions can read. */
export type FlowScope = {
  contact: FlowContact;
  vars: Record<string, unknown>;
  last: Partial<FlowInput>;
  /** Host texts resolved for this run (`{{t.key}}`). */
  t?: Record<string, string>;
};

const TEXT_TOKEN = /\{\{\s*t\.([\w.-]+)\s*\}\}/g;

/** Host text keys a node uses (`{{t.key}}` anywhere in its data). */
export function textKeysOf(value: unknown): string[] {
  const keys = new Set<string>();
  const json = JSON.stringify(value ?? "");
  for (const m of json.matchAll(TEXT_TOKEN)) keys.add(m[1]!);
  return [...keys];
}

/**
 * What follows the keyword in the message, original casing kept:
 * "VISIT_k97abc" with keyword "VISIT" → "k97abc";
 * "Menu Chez Léon table 4" with "menu" → "Chez Léon table 4".
 */
export function keywordRemainder(trigger: Extract<Trigger, { kind: "keyword" }>, text: string): string {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const normalizedWords = words.map((w) => normalizeText(w));
  for (const raw of trigger.keywords) {
    const kw = normalizeText(raw).split(" ").filter(Boolean);
    if (kw.length === 0) continue;
    for (let i = 0; i + kw.length <= normalizedWords.length; i++) {
      if (kw.every((k, j) => normalizedWords[i + j] === k)) {
        return words.slice(i + kw.length).join(" ");
      }
    }
  }
  return "";
}

/**
 * What keywords and choice titles are compared on: lowercase, no accents,
 * punctuation and emoji dropped, single spaces ("Promo !" → "promo").
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The line keywords are matched on: list replies arrive as "title\ndescription". */
function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

export function matchesKeyword(trigger: Extract<Trigger, { kind: "keyword" }>, text: string): boolean {
  const line = firstLine(text);
  const t = normalizeText(line);
  return trigger.keywords.some((raw) => {
    const k = normalizeText(raw);
    if (!k) {
      // Keywords made of symbols only (?, ✅, ❌) are compared as typed.
      const symbol = raw.trim();
      if (!symbol || !line) return false;
      if (trigger.match === "exact") return line === symbol;
      if (trigger.match === "startsWith") return line.startsWith(symbol);
      return line.includes(symbol);
    }
    if (!t) return false;
    if (trigger.match === "exact") return t === k;
    if (trigger.match === "startsWith") return t === k || t.startsWith(`${k} `);
    return ` ${t} `.includes(` ${k} `) || t.includes(k);
  });
}

export function resolvePath(scope: FlowScope, path: string): unknown {
  let value: unknown = scope;
  for (const key of path.trim().split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const loc = value as { latitude?: unknown; longitude?: unknown };
    if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      return `${loc.latitude},${loc.longitude}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/** Replaces `{{contact.name}}`, `{{vars.x}}`, `{{last.text}}`… (unknown → empty). */
export function interpolate(template: string, scope: FlowScope): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => asText(resolvePath(scope, path)));
}

// ─── HTTP requests (`http` nodes) ───

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
const DEFAULT_HTTP_TIMEOUT_S = 10;
const MAX_HTTP_TIMEOUT_S = 30;
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/** Fills placeholders with `encode`d values; `{{secret.NAME}}` stays for the host. */
function fillTemplate(template: string, scope: FlowScope, encode: (value: string) => string): string {
  return template.replace(PLACEHOLDER, (whole, path: string) =>
    path.startsWith("secret.") ? whole : encode(asText(resolvePath(scope, path))),
  );
}

/** JSON string content (without the quotes). */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * The request an `http` node sends: values URL-encoded in the URL, stripped
 * of line breaks in headers, JSON-escaped in the body. Secrets are left as
 * `{{secret.NAME}}` for the host to fill.
 */
export function buildHttpRequest(data: HttpNodeData, scope: FlowScope): HttpRequestSpec {
  const headers: Record<string, string> = {};
  for (const h of data.headers ?? []) {
    const name = h.name?.trim();
    // A line break would start another header: none, typed or interpolated.
    if (name) headers[name] = fillTemplate(h.value ?? "", scope, (v) => v).replace(/[\r\n]+/g, " ");
  }
  const withBody = BODY_METHODS.has(data.method) && !!data.body?.trim();
  const seconds = Math.min(Math.max(data.timeoutSeconds || DEFAULT_HTTP_TIMEOUT_S, 1), MAX_HTTP_TIMEOUT_S);
  return {
    method: data.method,
    url: fillTemplate(data.url.trim(), scope, encodeURIComponent),
    headers,
    ...(withBody ? { body: fillTemplate(data.body!, scope, jsonEscape) } : {}),
    timeoutMs: seconds * 1000,
  };
}

/** An https URL whose host name is written out (no placeholder before the path). */
const HTTP_URL = /^https:\/\/[^/?#{}\s]+(?:[/?#]\S*)?$/;

/** Comma-separated values of a rule, each normalized; empty ones dropped. */
function listOf(value: string | undefined, scope: FlowScope): string[] {
  return interpolate(value ?? "", scope)
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function evaluateRule(rule: ConditionRule, scope: FlowScope): boolean {
  const value = resolvePath(scope, rule.variable);
  const present = value !== undefined && value !== null && value !== "";
  const left = normalizeText(asText(value));
  const right = normalizeText(interpolate(rule.value ?? "", scope));
  switch (rule.operator) {
    case "exists":
      return present;
    case "not_exists":
      return !present;
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "contains":
      return right !== "" && left.includes(right);
    case "one_of":
      return listOf(rule.value, scope).some((item) => left === item);
    case "contains_any":
      return listOf(rule.value, scope).some((item) => ` ${left} `.includes(` ${item} `) || left.includes(item));
    case "starts_with":
      return listOf(rule.value, scope).some((item) => left === item || left.startsWith(`${item} `) || left.startsWith(item));
    case "greater_than":
    case "less_than": {
      const a = Number(asText(value));
      const b = Number(interpolate(rule.value ?? "", scope));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return rule.operator === "greater_than" ? a > b : a < b;
    }
  }
}

export function evaluateCondition(
  data: { rules: ConditionRule[]; mode: "all" | "any" },
  scope: FlowScope,
): boolean {
  if (data.rules.length === 0) return true;
  return data.mode === "any"
    ? data.rules.some((r) => evaluateRule(r, scope))
    : data.rules.every((r) => evaluateRule(r, scope));
}

const MAX_BUTTONS = 3;
const MAX_ROWS = 10;

/**
 * The items a `choices` source holds right now: a list of objects with an id
 * and a title (`name` / `label` accepted), or of plain strings.
 */
export function dynamicItems(data: MessageNodeData, scope: FlowScope): Array<{ id: string; item: unknown; option: ChoiceOption }> {
  if (!data.choices?.from) return [];
  const path = data.choices.from.replace(/^\{\{\s*|\s*\}\}$/g, "");
  const source = resolvePath(scope, path);
  if (!Array.isArray(source)) return [];
  const out: Array<{ id: string; item: unknown; option: ChoiceOption }> = [];
  source.forEach((item, index) => {
    if (item === null || item === undefined) return;
    const o = typeof item === "object" ? (item as Record<string, unknown>) : { id: String(item), title: String(item) };
    const id = String(o.id ?? o._id ?? index + 1);
    const title = String(o.title ?? o.name ?? o.label ?? id).trim();
    if (!title) return;
    const description = typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined;
    out.push({ id, item, option: { id: `${CHOICE_ID_PREFIX}${id}`, title, ...(description ? { description } : {}) } });
  });
  return out;
}

/** The item a reply picked among the `choices` options (null if none). */
export function chosenItem(data: MessageNodeData, scope: FlowScope, optionId: string): unknown {
  if (!optionId.startsWith(CHOICE_ID_PREFIX)) return null;
  const id = optionId.slice(CHOICE_ID_PREFIX.length);
  return dynamicItems(data, scope).find((d) => d.id === id)?.item ?? null;
}

/** The message a `message` node sends, placeholders filled in. */
export function renderMessage(data: MessageNodeData, scope: FlowScope): OutboundMessage {
  const text = interpolate(data.text ?? "", scope);
  const mediaUrl = data.mediaUrl ? interpolate(data.mediaUrl, scope) : undefined;
  const fixed = (data.list?.rows?.length ? data.list.rows : (data.buttons ?? [])).map((o) => ({
    id: o.id,
    title: interpolate(o.title, scope),
    ...(o.description ? { description: interpolate(o.description, scope) } : {}),
  }));
  const dynamic = dynamicItems(data, scope).map((d) => d.option);
  const options = [...dynamic.slice(0, Math.max(0, MAX_ROWS - fixed.length)), ...fixed];
  const asList =
    !!data.list?.rows?.length ||
    options.length > MAX_BUTTONS ||
    (dynamic.length > 0 && options.some((o) => o.description));
  if (options.length && asList) {
    return {
      type: "list",
      text,
      buttonLabel: interpolate(data.list?.buttonLabel || "Options", scope),
      sections: [{ rows: options }],
    };
  }
  if (options.length) {
    return {
      type: "buttons",
      text,
      buttons: options.map((b) => ({ id: b.id, title: b.title })),
      ...(mediaUrl ? { header: { kind: "image" as const, url: mediaUrl } } : {}),
    };
  }
  if (data.link?.url) {
    return { type: "ctaUrl", text, buttonTitle: interpolate(data.link.title, scope), url: interpolate(data.link.url, scope) };
  }
  if (mediaUrl) return { type: "media", kind: "image", url: mediaUrl, caption: text || undefined };
  return { type: "text", text };
}

/** The message an `ask` node sends. */
export function renderQuestion(data: AskNodeData, scope: FlowScope): OutboundMessage {
  const text = interpolate(data.text ?? "", scope);
  return data.expect === "location" ? { type: "locationRequest", text } : { type: "text", text };
}

/**
 * Which option of a waiting `message` node the reply picks: by reply id, by
 * the tapped title echoed as text, or by its number ("2"). Otherwise `other`.
 */
export function pickChoice(
  data: MessageNodeData,
  input: FlowInput,
  /** Options as they were sent (texts resolved); defaults to the node's. */
  sentOptions?: Array<{ id: string; title: string }>,
): string {
  const options = sentOptions?.length ? sentOptions : data.list?.rows?.length ? data.list.rows : (data.buttons ?? []);
  if (input.replyId) {
    const byId = options.find((o) => o.id === input.replyId);
    if (byId) return byId.id;
  }
  const typed = normalizeText(input.text.split("\n")[0] ?? "");
  if (typed) {
    const byTitle = options.find((o) => normalizeText(o.title) === typed);
    if (byTitle) return byTitle.id;
    const n = Number(typed);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.id;
  }
  return "other";
}

/** Whether a reply answers an `ask` node, and the value to store. */
export function readAnswer(data: AskNodeData, input: FlowInput): { handle: "reply" | "other"; value: unknown } {
  if (data.expect === "location") {
    return input.location ? { handle: "reply", value: input.location } : { handle: "other", value: input.text };
  }
  if (data.expect === "image") {
    return input.imageUrl ? { handle: "reply", value: input.imageUrl } : { handle: "other", value: input.text };
  }
  if (data.expect === "text") {
    return input.text.trim() ? { handle: "reply", value: input.text.trim() } : { handle: "other", value: input.location ?? input.imageUrl };
  }
  const value = input.location ?? input.imageUrl ?? input.text.trim();
  return { handle: value ? "reply" : "other", value };
}

export function nextNodeId(graph: FlowGraph, nodeId: string, handle: string): string | undefined {
  const edge = graph.edges.find(
    (e) => e.source === nodeId && (e.sourceHandle ?? "next") === handle,
  );
  return edge?.target;
}

export function delayMs(data: { amount: number; unit: "minutes" | "hours" | "days" }): number {
  const unit = data.unit === "days" ? 86_400_000 : data.unit === "hours" ? 3_600_000 : 60_000;
  return Math.max(0, data.amount) * unit;
}

// ─── Validation ───

export type FlowIssueCode =
  | "no_trigger"
  | "many_triggers"
  | "no_trigger_rule"
  | "empty_keyword"
  | "trigger_not_connected"
  | "dangling_edge"
  | "unknown_handle"
  | "edge_from_terminal"
  | "empty_text"
  | "too_many_buttons"
  | "too_many_rows"
  | "empty_option"
  | "duplicate_option"
  | "missing_list_label"
  | "missing_link_url"
  | "invalid_variable_name"
  | "missing_action"
  | "unknown_action"
  | "missing_param"
  | "bad_delay"
  | "empty_rule"
  | "no_account"
  | "missing_choices_source"
  | "missing_flow"
  | "unknown_flow"
  | "missing_event"
  | "missing_url"
  | "bad_http_url"
  | "invalid_json_body";

export type FlowIssue = { code: FlowIssueCode; nodeId?: string; detail?: string };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks a graph before publishing. An empty array means it can run.
 * `actions` is the host's catalog; pass it to check action nodes.
 */
export function validateFlowGraph(
  graph: FlowGraph,
  actions?: ActionDefinition[],
  options: {
    requireAccounts?: boolean;
    /** Ids of the workflows a `flow` node may run (checked when given). */
    knownFlows?: string[];
  } = {},
): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const triggers = graph.nodes.filter((n) => n.type === "trigger");

  if (triggers.length === 0) issues.push({ code: "no_trigger" });
  if (triggers.length > 1) issues.push({ code: "many_triggers" });

  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({ code: "dangling_edge", nodeId: ids.has(edge.source) ? edge.source : undefined });
      continue;
    }
    const source = graph.nodes.find((n) => n.id === edge.source)!;
    if (TERMINAL_NODES.has(source.type)) {
      issues.push({ code: "edge_from_terminal", nodeId: source.id });
    } else if (!outputsOf(source, actions ?? []).includes(edge.sourceHandle ?? "next")) {
      issues.push({ code: "unknown_handle", nodeId: source.id, detail: edge.sourceHandle ?? "next" });
    }
  }

  for (const node of graph.nodes) {
    switch (node.type) {
      case "trigger": {
        const d = node.data as { triggers: Trigger[] };
        if (!d.triggers?.length) issues.push({ code: "no_trigger_rule", nodeId: node.id });
        for (const t of d.triggers ?? []) {
          if (t.kind === "keyword" && !t.keywords.some((k) => k.trim())) {
            issues.push({ code: "empty_keyword", nodeId: node.id });
          }
        }
        if (!graph.edges.some((e) => e.source === node.id)) {
          issues.push({ code: "trigger_not_connected", nodeId: node.id });
        }
        if (options.requireAccounts && !(node.data as { accounts?: unknown[] }).accounts?.length) {
          issues.push({ code: "no_account", nodeId: node.id });
        }
        break;
      }
      case "message": {
        const d = node.data as MessageNodeData;
        if (!d.text?.trim() && !d.mediaUrl) issues.push({ code: "empty_text", nodeId: node.id });
        if ((d.buttons?.length ?? 0) > 3) issues.push({ code: "too_many_buttons", nodeId: node.id });
        if ((d.list?.rows?.length ?? 0) > 10) issues.push({ code: "too_many_rows", nodeId: node.id });
        if (d.list?.rows?.length && !d.choices && !d.list.buttonLabel?.trim()) {
          issues.push({ code: "missing_list_label", nodeId: node.id });
        }
        if (d.link && !d.link.url?.trim()) issues.push({ code: "missing_link_url", nodeId: node.id });
        if (d.choices) {
          if (!d.choices.from?.trim()) issues.push({ code: "missing_choices_source", nodeId: node.id });
          if (!VARIABLE_NAME.test(d.choices.saveAs ?? "")) issues.push({ code: "invalid_variable_name", nodeId: node.id });
          if (d.list && !d.list.buttonLabel?.trim()) issues.push({ code: "missing_list_label", nodeId: node.id });
        }
        const options = d.list?.rows?.length ? d.list.rows : (d.buttons ?? []);
        if (options.some((o) => !o.title?.trim() || !o.id)) issues.push({ code: "empty_option", nodeId: node.id });
        if (new Set(options.map((o) => o.id)).size !== options.length) {
          issues.push({ code: "duplicate_option", nodeId: node.id });
        }
        break;
      }
      case "ask": {
        const d = node.data as AskNodeData;
        if (!d.text?.trim()) issues.push({ code: "empty_text", nodeId: node.id });
        if (!VARIABLE_NAME.test(d.saveAs ?? "")) issues.push({ code: "invalid_variable_name", nodeId: node.id });
        break;
      }
      case "condition": {
        const d = node.data as { rules: ConditionRule[] };
        if (d.rules?.some((r) => !r.variable?.trim())) issues.push({ code: "empty_rule", nodeId: node.id });
        break;
      }
      case "delay": {
        const d = node.data as { amount: number };
        if (!(d.amount > 0)) issues.push({ code: "bad_delay", nodeId: node.id });
        break;
      }
      case "action": {
        const d = node.data as { action: string; params: Record<string, string>; saveAs?: string };
        if (!d.action) {
          issues.push({ code: "missing_action", nodeId: node.id });
          break;
        }
        if (d.saveAs && !VARIABLE_NAME.test(d.saveAs)) issues.push({ code: "invalid_variable_name", nodeId: node.id });
        if (actions) {
          const def = actions.find((a) => a.name === d.action);
          if (!def) {
            issues.push({ code: "unknown_action", nodeId: node.id, detail: d.action });
          } else {
            for (const p of def.params) {
              if (p.required && !d.params?.[p.name]?.trim()) {
                issues.push({ code: "missing_param", nodeId: node.id, detail: p.name });
              }
            }
          }
        }
        break;
      }
      case "set_variable": {
        const d = node.data as { name: string };
        if (!VARIABLE_NAME.test(d.name ?? "")) issues.push({ code: "invalid_variable_name", nodeId: node.id });
        break;
      }
      case "flow": {
        const d = node.data as { flowId?: string };
        if (!d.flowId) issues.push({ code: "missing_flow", nodeId: node.id });
        else if (options.knownFlows && !options.knownFlows.includes(d.flowId)) {
          issues.push({ code: "unknown_flow", nodeId: node.id, detail: d.flowId });
        }
        break;
      }
      case "wait_event": {
        const d = node.data as { event?: string; saveAs?: string };
        if (!d.event?.trim()) issues.push({ code: "missing_event", nodeId: node.id });
        if (d.saveAs && !VARIABLE_NAME.test(d.saveAs)) issues.push({ code: "invalid_variable_name", nodeId: node.id });
        break;
      }
      case "http": {
        const d = node.data as HttpNodeData;
        const url = d.url?.trim() ?? "";
        if (!url) issues.push({ code: "missing_url", nodeId: node.id });
        else if (!HTTP_URL.test(url)) issues.push({ code: "bad_http_url", nodeId: node.id });
        if (d.saveAs && !VARIABLE_NAME.test(d.saveAs)) issues.push({ code: "invalid_variable_name", nodeId: node.id });
        if (BODY_METHODS.has(d.method) && d.body?.trim()) {
          try {
            // Placeholders become a bare 0: valid inside quotes and as a number.
            JSON.parse(d.body.replace(PLACEHOLDER, "0"));
          } catch {
            issues.push({ code: "invalid_json_body", nodeId: node.id });
          }
        }
        break;
      }
      case "handoff":
      case "end":
      case "release":
        break;
    }
  }
  return issues;
}

/** Index entries for fast trigger matching, derived from a published graph. */
export function triggersOf(graph: FlowGraph): Trigger[] {
  const node = graph.nodes.find((n) => n.type === "trigger");
  return node ? ((node.data as { triggers: Trigger[] }).triggers ?? []) : [];
}

/** Ids of the accounts a workflow listens on (empty: unscoped). */
export function accountsOf(graph: FlowGraph): string[] {
  const node = graph.nodes.find((n) => n.type === "trigger");
  const accounts = node ? ((node.data as { accounts?: Array<{ id: string }> }).accounts ?? []) : [];
  return accounts.map((a) => a.id).filter(Boolean);
}

/** Whether the contact is in the trigger's audience (no segments: everyone). */
export function segmentsMatch(trigger: Trigger, segments: string[] | undefined): boolean {
  if (!trigger.segments?.length) return true;
  return trigger.segments.some((s) => segments?.includes(s));
}

/** Ids of the workflows a graph runs through `flow` nodes. */
export function calledFlowsOf(graph: FlowGraph): string[] {
  return [
    ...new Set(
      graph.nodes
        .filter((n) => n.type === "flow")
        .map((n) => (n.data as { flowId?: string }).flowId)
        .filter((id): id is string => !!id),
    ),
  ];
}

/** Whether a workflow scoped to `accountIds` may answer on `accountId`. */
export function accountMatches(accountIds: string[], accountId: string | undefined, allowUnscoped: boolean): boolean {
  if (accountIds.length === 0) return allowUnscoped;
  return !!accountId && accountIds.includes(accountId);
}

/** Trigger priority: exact keyword first, generic triggers last. */
export function triggerRank(trigger: Trigger): number {
  switch (trigger.kind) {
    case "keyword":
      return trigger.match === "exact" ? 100 : trigger.match === "startsWith" ? 90 : 80;
    case "location":
    case "image":
      return 50;
    case "first_message":
      return 10;
    case "any":
      return 1;
    case "api":
      return 0;
  }
}

export function inputMatchesTrigger(
  trigger: Trigger,
  input: FlowInput,
  isFirstMessage: boolean,
): boolean {
  switch (trigger.kind) {
    case "keyword":
      return matchesKeyword(trigger, input.text);
    case "location":
      return !!input.location;
    case "image":
      return !!input.imageUrl;
    case "first_message":
      return isFirstMessage;
    case "any":
      return true;
    case "api":
      return false;
  }
}

export type { FlowNode };
