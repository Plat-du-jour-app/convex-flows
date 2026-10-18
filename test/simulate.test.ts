import { describe, expect, it } from "vitest";
import { FlowSimulation, triggerMatches } from "../src/shared/simulate.js";
import type { FlowGraph } from "../src/shared/flowTypes.js";

const node = (id: string, type: string, data: unknown) => ({ id, type, position: { x: 0, y: 0 }, data }) as FlowGraph["nodes"][number];
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, sourceHandle });

const pick: FlowGraph = {
  nodes: [
    node("t", "trigger", { triggers: [{ kind: "api" }] }),
    node("load", "action", { action: "restaurants", params: {}, saveAs: "restaurants" }),
    node("ask", "message", { text: "{{t.which}}", choices: { from: "vars.restaurants", saveAs: "restaurant" } }),
    node("none", "message", { text: "Aucun restaurant" }),
    node("done", "end", {}),
  ],
  edges: [edge("t", "load"), edge("load", "ask", "done"), edge("ask", "done", "chosen"), edge("ask", "none", "empty")],
};

const main: FlowGraph = {
  nodes: [
    node("t", "trigger", { triggers: [{ kind: "keyword", keywords: ["RESA"], match: "exact", segments: ["new"] }] }),
    node("call", "flow", { flowId: "pick", returnAfter: true }),
    node("ok", "message", { text: "Choisi : {{vars.restaurant.title}}" }),
    node("pay", "wait_event", { event: "paid", saveAs: "payment" }),
    node("thanks", "message", { text: "Payé {{vars.payment.amount}} €" }),
  ],
  edges: [edge("t", "call"), edge("call", "ok"), edge("ok", "pay"), edge("pay", "thanks", "received")],
};

describe("FlowSimulation", () => {
  it("runs a called workflow, a dynamic choice and an event like the engine", async () => {
    let list = [{ id: "r1", title: "Chez Léon" }, { id: "r2", title: "La Table" }];
    const sim = new FlowSimulation(main, {
      contact: { id: "c", name: "Léa" },
      host: {
        flows: { pick },
        action: () => ({ output: "done", result: list }),
        texts: (keys) => Object.fromEntries(keys.map((k) => [k, "Lequel ?"])),
      },
    });
    expect(triggerMatches(main, { text: "resa" }, { segments: ["consumer"] })).toBeNull();
    expect(triggerMatches(main, { text: "resa" }, { segments: ["new"] })?.kind).toBe("keyword");

    const first = await sim.start({ text: "RESA" });
    expect(first.status).toBe("waiting");
    expect(first.trace).toEqual(["t", "call", "t", "load", "ask"]);
    expect(first.messages[0]).toMatchObject({ type: "buttons", text: "Lequel ?" });

    const second = await sim.reply({ text: "La Table" });
    expect(second.messages.map((m) => ("text" in m ? m.text : ""))).toEqual(["Choisi : La Table"]);
    expect(second).toMatchObject({ status: "waiting", waitKind: "event", waitEvent: "paid" });
    expect((await sim.reply({ text: "bonjour" })).handled).toBe(false);

    const third = await sim.event("paid", { amount: 42 });
    expect(third.messages.map((m) => ("text" in m ? m.text : ""))).toEqual(["Payé 42 €"]);
    expect(third.status).toBe("done");

    list = [];
    const empty = new FlowSimulation(main, { contact: { id: "c" }, host: { flows: { pick }, action: () => ({ output: "done", result: list }) } });
    const step = await empty.start({ text: "RESA" });
    expect(step.messages.map((m) => ("text" in m ? m.text : ""))).toEqual(["Aucun restaurant", "Choisi : "]);
  });

  it("hands unanswerable replies back to the host", async () => {
    const graph: FlowGraph = {
      nodes: [node("t", "trigger", { triggers: [{ kind: "any" }] }), node("q", "message", { text: "?", buttons: [{ id: "a", title: "Oui" }] })],
      edges: [edge("t", "q")],
    };
    const sim = new FlowSimulation(graph, { contact: { id: "c" } });
    await sim.start({ text: "x" });
    const step = await sim.reply({ text: "Oui" });
    expect(step).toMatchObject({ handled: false, status: "done" });
  });
});

describe("release", () => {
  it("gives the message back to the host", async () => {
    const graph: FlowGraph = {
      nodes: [
        node("t", "trigger", { triggers: [{ kind: "any" }] }),
        node("q", "message", { text: "?", buttons: [{ id: "a", title: "Oui" }] }),
        node("r", "release", {}),
      ],
      edges: [edge("t", "q"), edge("q", "r", "other")],
    };
    const sim = new FlowSimulation(graph, { contact: { id: "c" } });
    await sim.start({ text: "x" });
    const step = await sim.reply({ text: "VISIT_123" });
    expect(step).toMatchObject({ handled: false, status: "done" });
    expect(sim.released).toBe(true);
  });
});
