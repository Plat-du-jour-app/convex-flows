import { describe, expect, it } from "vitest";
import {
  calledFlowsOf,
  chosenItem,
  dynamicItems,
  segmentsMatch,
  evaluateCondition,
  inputMatchesTrigger,
  interpolate,
  matchesKeyword,
  normalizeText,
  pickChoice,
  readAnswer,
  renderMessage,
  renderQuestion,
  triggerRank,
  validateFlowGraph,
  type FlowScope,
} from "../src/shared/flowRuntime.js";
import { outputsOf, type ActionDefinition, type FlowGraph } from "../src/shared/flowTypes.js";

const scope: FlowScope = {
  contact: { id: "336", name: "Léa" },
  vars: { position: { latitude: 43.8, longitude: 5.7 }, found: { count: 2 }, plat: "Blanquette" },
  last: { text: "Oui" },
};

describe("keywords", () => {
  it("ignores case, accents, punctuation and emoji", () => {
    expect(normalizeText("  Déjà-vu ! 🍽️ ")).toBe("deja vu");
    const exact = { kind: "keyword" as const, keywords: ["PROMO"], match: "exact" as const };
    expect(matchesKeyword(exact, "promo !")).toBe(true);
    expect(matchesKeyword(exact, "la promo")).toBe(false);
  });

  it("supports contains and startsWith", () => {
    expect(matchesKeyword({ kind: "keyword", keywords: ["menu"], match: "contains" }, "je veux le MENU svp")).toBe(true);
    expect(matchesKeyword({ kind: "keyword", keywords: ["resa"], match: "startsWith" }, "Résa 4 personnes")).toBe(true);
    expect(matchesKeyword({ kind: "keyword", keywords: ["resa"], match: "startsWith" }, "ma resa")).toBe(false);
  });

  it("ranks exact keywords above generic triggers", () => {
    expect(triggerRank({ kind: "keyword", keywords: ["x"], match: "exact" })).toBeGreaterThan(
      triggerRank({ kind: "location" }),
    );
    expect(triggerRank({ kind: "location" })).toBeGreaterThan(triggerRank({ kind: "first_message" }));
  });

  it("matches location, image and first-message triggers", () => {
    expect(inputMatchesTrigger({ kind: "location" }, { text: "", location: { latitude: 1, longitude: 2 } }, false)).toBe(true);
    expect(inputMatchesTrigger({ kind: "image" }, { text: "" }, false)).toBe(false);
    expect(inputMatchesTrigger({ kind: "first_message" }, { text: "hey" }, true)).toBe(true);
  });
});

describe("variables", () => {
  it("fills placeholders, unknown ones become empty", () => {
    expect(interpolate("Bonjour {{contact.name}}, {{vars.plat}} {{vars.nope}}!", scope)).toBe("Bonjour Léa, Blanquette !");
    expect(interpolate("{{vars.position}}", scope)).toBe("43.8,5.7");
  });

  it("evaluates conditions", () => {
    expect(evaluateCondition({ mode: "all", rules: [{ variable: "vars.found.count", operator: "greater_than", value: "1" }] }, scope)).toBe(true);
    expect(evaluateCondition({ mode: "all", rules: [{ variable: "vars.position", operator: "exists" }, { variable: "vars.plat", operator: "equals", value: "blanquette" }] }, scope)).toBe(true);
    expect(evaluateCondition({ mode: "any", rules: [{ variable: "vars.nope", operator: "exists" }, { variable: "last.text", operator: "contains", value: "ou" }] }, scope)).toBe(true);
    expect(evaluateCondition({ mode: "all", rules: [{ variable: "vars.nope", operator: "exists" }] }, scope)).toBe(false);
  });
});

describe("messages and answers", () => {
  const buttons = { text: "Tu viens {{contact.name}} ?", buttons: [{ id: "yes", title: "✅ Oui" }, { id: "no", title: "Non" }] };

  it("renders buttons, lists, links, images and location requests", () => {
    expect(renderMessage(buttons, scope)).toEqual({ type: "buttons", text: "Tu viens Léa ?", buttons: [{ id: "yes", title: "✅ Oui" }, { id: "no", title: "Non" }] });
    expect(renderMessage({ text: "Choisis", list: { buttonLabel: "Voir", rows: [{ id: "a", title: "A", description: "d" }] } }, scope).type).toBe("list");
    expect(renderMessage({ text: "Lien", link: { title: "Ouvrir", url: "https://x" } }, scope).type).toBe("ctaUrl");
    expect(renderMessage({ text: "Photo", mediaUrl: "https://cdn/p.jpg" }, scope)).toEqual({ type: "media", kind: "image", url: "https://cdn/p.jpg", caption: "Photo" });
    expect(renderQuestion({ text: "Où ?", saveAs: "pos", expect: "location" }, scope)).toEqual({ type: "locationRequest", text: "Où ?" });
  });

  it("picks a choice by id, echoed title or number", () => {
    expect(pickChoice(buttons, { text: "whatever", replyId: "no" })).toBe("no");
    expect(pickChoice(buttons, { text: "✅ Oui" })).toBe("yes");
    expect(pickChoice(buttons, { text: "oui" })).toBe("yes");
    expect(pickChoice(buttons, { text: "2" })).toBe("no");
    expect(pickChoice(buttons, { text: "peut-être" })).toBe("other");
  });

  it("reads answers of the expected kind", () => {
    expect(readAnswer({ text: "", saveAs: "p", expect: "location" }, { text: "📍", location: { latitude: 1, longitude: 2 } })).toEqual({ handle: "reply", value: { latitude: 1, longitude: 2 } });
    expect(readAnswer({ text: "", saveAs: "p", expect: "location" }, { text: "Manosque" }).handle).toBe("other");
    expect(readAnswer({ text: "", saveAs: "n", expect: "text" }, { text: " Léa " })).toEqual({ handle: "reply", value: "Léa" });
    expect(readAnswer({ text: "", saveAs: "i", expect: "image" }, { text: "", imageUrl: "https://i" }).handle).toBe("reply");
  });
});

describe("validateFlowGraph", () => {
  const catalog: ActionDefinition[] = [
    { name: "nearby", label: "Plats proches", params: [{ name: "radius", label: "Rayon", required: true }], outputs: [{ id: "found", label: "Trouvés" }, { id: "none", label: "Aucun" }] },
  ];
  const good: FlowGraph = {
    nodes: [
      { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "keyword", keywords: ["MENU"], match: "exact" }] } },
      { id: "m", type: "message", position: { x: 0, y: 0 }, data: { text: "Hello", buttons: [{ id: "a", title: "A" }] } },
      { id: "x", type: "action", position: { x: 0, y: 0 }, data: { action: "nearby", params: { radius: "3" } } },
      { id: "e", type: "end", position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [
      { id: "1", source: "t", target: "m" },
      { id: "2", source: "m", sourceHandle: "a", target: "x" },
      { id: "3", source: "x", sourceHandle: "none", target: "e" },
    ],
  };

  it("accepts a valid graph", () => {
    expect(validateFlowGraph(good, catalog)).toEqual([]);
  });

  it("reports the problems an editor must show", () => {
    const bad: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "keyword", keywords: [" "], match: "exact" }] } },
        { id: "t2", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [] } },
        { id: "m", type: "message", position: { x: 0, y: 0 }, data: { text: "", buttons: [{ id: "a", title: "A" }, { id: "a", title: "" }, { id: "c", title: "C" }, { id: "d", title: "D" }] } },
        { id: "q", type: "ask", position: { x: 0, y: 0 }, data: { text: "?", saveAs: "1bad", expect: "text" } },
        { id: "x", type: "action", position: { x: 0, y: 0 }, data: { action: "nearby", params: {} } },
        { id: "d", type: "delay", position: { x: 0, y: 0 }, data: { amount: 0, unit: "minutes" } },
        { id: "e", type: "end", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [
        { id: "1", source: "m", sourceHandle: "zzz", target: "q" },
        { id: "2", source: "e", target: "q" },
        { id: "3", source: "q", sourceHandle: "reply", target: "ghost" },
      ],
    };
    const codes = validateFlowGraph(bad, catalog).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "many_triggers",
        "empty_keyword",
        "no_trigger_rule",
        "trigger_not_connected",
        "unknown_handle",
        "edge_from_terminal",
        "dangling_edge",
        "empty_text",
        "too_many_buttons",
        "empty_option",
        "duplicate_option",
        "invalid_variable_name",
        "missing_param",
        "bad_delay",
      ]),
    );
  });

  it("derives node outputs", () => {
    expect(outputsOf(good.nodes[1]!)).toEqual(["a", "other"]);
    expect(outputsOf(good.nodes[2]!, catalog)).toEqual(["found", "none"]);
    expect(outputsOf(good.nodes[3]!)).toEqual([]);
  });
});

describe("accounts", () => {
  it("scopes workflows to the accounts they pick", async () => {
    const { accountMatches, accountsOf } = await import("../src/shared/flowRuntime.js");
    expect(accountMatches(["ig1", "wa1"], "ig1", false)).toBe(true);
    expect(accountMatches(["ig1"], "fb9", true)).toBe(false);
    expect(accountMatches([], "fb9", false)).toBe(false);
    expect(accountMatches([], "fb9", true)).toBe(true);
    expect(
      accountsOf({
        nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [], accounts: [{ id: "ig1", platform: "instagram" }] } }],
        edges: [],
      }),
    ).toEqual(["ig1"]);
  });

  it("can require an account before publishing", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "first_message" }] } },
        { id: "e", type: "end", position: { x: 0, y: 0 }, data: {} },
      ],
      edges: [{ id: "1", source: "t", target: "e" }],
    };
    expect(validateFlowGraph(graph).map((i) => i.code)).toEqual([]);
    expect(validateFlowGraph(graph, [], { requireAccounts: true }).map((i) => i.code)).toEqual(["no_account"]);
  });
});

describe("migration helpers", () => {
  it("captures what follows a keyword", async () => {
    const { keywordRemainder } = await import("../src/shared/flowRuntime.js");
    const visit = { kind: "keyword" as const, keywords: ["VISIT"], match: "startsWith" as const };
    expect(keywordRemainder(visit, "VISIT_k974qk2614bj6s")).toBe("k974qk2614bj6s");
    expect(keywordRemainder({ kind: "keyword", keywords: ["menu"], match: "startsWith" }, "Menu Chez Léon table 4")).toBe("Chez Léon table 4");
    expect(keywordRemainder({ kind: "keyword", keywords: ["ami"], match: "startsWith" }, "AMI_X7Q2 merci !")).toBe("X7Q2 merci");
    expect(keywordRemainder(visit, "bonjour")).toBe("");
  });

  it("lists the host texts a node uses", async () => {
    const { textKeysOf } = await import("../src/shared/flowRuntime.js");
    expect(
      textKeysOf({ text: "{{t.consumer_welcome}}", buttons: [{ id: "a", title: "{{ t.btn_foodie }}" }, { id: "b", title: "{{contact.name}}" }] }).sort(),
    ).toEqual(["btn_foodie", "consumer_welcome"]);
  });

  it("resolves {{t.key}} from the scope", () => {
    expect(interpolate("{{t.hello}} {{contact.name}}", { ...scope, t: { hello: "Bonjour" } })).toBe("Bonjour Léa");
  });

  it("matches a typed reply against the options as sent", () => {
    const data = { text: "", buttons: [{ id: "foodie", title: "{{t.btn_foodie}}" }] };
    expect(pickChoice(data, { text: "🍽 Je cherche un plat" }, [{ id: "foodie", title: "🍽 Je cherche un plat" }])).toBe("foodie");
    expect(pickChoice(data, { text: "🍽 Je cherche un plat" })).toBe("other");
  });

  it("has a catch-all trigger, ranked last", () => {
    expect(inputMatchesTrigger({ kind: "any" }, { text: "n'importe quoi" }, false)).toBe(true);
    expect(triggerRank({ kind: "any" })).toBeLessThan(triggerRank({ kind: "first_message" }));
  });
});

describe("0.7: building blocks for real journeys", () => {
  const restaurants = [
    { id: "r1", title: "Chez Léon", description: "Manosque" },
    { id: "r2", name: "La Table" },
  ];
  const choiceScope: FlowScope = { ...scope, vars: { ...scope.vars, restaurants } };

  it("compares a value with a list of words", () => {
    const rule = (operator: "one_of" | "contains_any" | "starts_with", value: string, text: string) =>
      evaluateCondition({ mode: "all", rules: [{ variable: "last.text", operator, value }] }, { ...scope, last: { text } });
    expect(rule("one_of", "1, GOURMAND, Foodie", "gourmand !")).toBe(true);
    expect(rule("one_of", "1, GOURMAND", "je suis gourmand")).toBe(false);
    expect(rule("contains_any", "revendiquer, claim", "Je veux CLAIM ma fiche")).toBe(true);
    expect(rule("starts_with", "REF", "REF_LEON_ab12")).toBe(true);
    expect(rule("starts_with", "REF", "PREFERENCE")).toBe(false);
  });

  it("builds options from a variable, before the fixed ones", () => {
    const data = { text: "Quel restaurant ?", choices: { from: "vars.restaurants", saveAs: "restaurant" }, buttons: [{ id: "new", title: "Autre" }] };
    const message = renderMessage(data, choiceScope);
    // Descriptions only fit in a list.
    expect(message.type).toBe("list");
    if (message.type !== "list") return;
    expect(message.sections[0]!.rows.map((r) => r.id)).toEqual(["choice:r1", "choice:r2", "new"]);
    expect(dynamicItems(data, choiceScope).map((d) => d.option.title)).toEqual(["Chez Léon", "La Table"]);
    expect(chosenItem(data, choiceScope, "choice:r2")).toEqual(restaurants[1]);
    expect(chosenItem(data, choiceScope, "new")).toBeNull();
    expect(outputsOf({ id: "m", type: "message", position: { x: 0, y: 0 }, data })).toEqual(["new", "chosen", "empty", "other"]);
  });

  it("sends few short options as buttons", () => {
    const data = { text: "Lequel ?", choices: { from: "vars.names", saveAs: "picked" } };
    const message = renderMessage(data, { ...scope, vars: { names: ["Midi", "Soir"] } });
    expect(message.type).toBe("buttons");
    if (message.type === "buttons") expect(message.buttons).toEqual([{ id: "choice:Midi", title: "Midi" }, { id: "choice:Soir", title: "Soir" }]);
  });

  it("validates flow calls, events and dynamic choices", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { triggers: [{ kind: "any", segments: ["new"] }] } },
        { id: "m", type: "message", position: { x: 0, y: 0 }, data: { text: "?", choices: { from: "", saveAs: "1x" } } },
        { id: "f", type: "flow", position: { x: 0, y: 0 }, data: { flowId: "abc", returnAfter: true } },
        { id: "g", type: "flow", position: { x: 0, y: 0 }, data: { flowId: "" } },
        { id: "w", type: "wait_event", position: { x: 0, y: 0 }, data: { event: " " } },
      ],
      edges: [
        { id: "1", source: "t", target: "m" },
        { id: "2", source: "m", sourceHandle: "chosen", target: "f" },
        { id: "3", source: "f", target: "w" },
        { id: "4", source: "g", target: "w" },
      ],
    };
    const codes = validateFlowGraph(graph, [], { knownFlows: [] }).map((i) => `${i.code}@${i.nodeId ?? ""}`);
    expect(codes).toEqual(
      expect.arrayContaining(["missing_choices_source@m", "invalid_variable_name@m", "unknown_flow@f", "missing_flow@g", "missing_event@w", "unknown_handle@g"]),
    );
    expect(calledFlowsOf(graph)).toEqual(["abc"]);
  });

  it("limits a trigger to the audiences it names", () => {
    const welcome = { kind: "any" as const, segments: ["new"] };
    expect(segmentsMatch(welcome, ["new"])).toBe(true);
    expect(segmentsMatch(welcome, ["consumer"])).toBe(false);
    expect(segmentsMatch(welcome, undefined)).toBe(false);
    expect(segmentsMatch({ kind: "any" }, undefined)).toBe(true);
  });
});

describe("0.8: matching like the coded bot", () => {
  it("matches keywords on the first line (list replies) and symbols as typed", () => {
    const exact = { kind: "keyword" as const, keywords: ["changer"], match: "exact" as const };
    expect(matchesKeyword(exact, "🔄 Changer\nBasculer vers un autre restaurant")).toBe(true);
    const symbols = { kind: "keyword" as const, keywords: ["?", "✅"], match: "exact" as const };
    expect(matchesKeyword(symbols, "?")).toBe(true);
    expect(matchesKeyword(symbols, " ✅ ")).toBe(true);
    expect(matchesKeyword(symbols, "ok ?")).toBe(false);
  });

  it("gives choices a timeout output when asked", () => {
    const node = { id: "m", type: "message" as const, position: { x: 0, y: 0 }, data: { text: "?", buttons: [{ id: "a", title: "A" }], timeoutMinutes: 1 } };
    expect(outputsOf(node)).toEqual(["a", "other", "timeout"]);
  });
});
