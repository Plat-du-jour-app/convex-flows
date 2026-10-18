import { describe, expect, it } from "vitest";
import { buildHttpRequest, validateFlowGraph, type FlowScope } from "../src/shared/flowRuntime.js";
import { outputsOf, type FlowGraph, type HttpNodeData, type HttpRequestSpec } from "../src/shared/flowTypes.js";
import { isAllowedHost, performHttpRequest } from "../src/shared/http.js";
import { FlowSimulation } from "../src/shared/simulate.js";

const scope: FlowScope = {
  contact: { id: "c1", name: 'Léa "la cheffe"', phone: "+33612345678" },
  vars: { order: { id: "A/12", total: 42 }, guests: 9 },
  last: { text: "réserver" },
};

const node = (id: string, type: string, data: unknown) => ({ id, type, position: { x: 0, y: 0 }, data }) as FlowGraph["nodes"][number];
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, sourceHandle });

describe("buildHttpRequest", () => {
  it("encodes URL values, escapes JSON values and keeps secrets for the host", () => {
    const data: HttpNodeData = {
      method: "POST",
      url: "https://hook.eu1.make.com/abc?order={{vars.order.id}}&key={{secret.MAKE_KEY}}",
      headers: [
        { name: "Authorization", value: "Bearer {{secret.MAKE_KEY}}" },
        { name: "X-Contact", value: "{{contact.name}}\r\nX-Evil: 1" },
        { name: " ", value: "ignored" },
      ],
      body: '{"name": "{{contact.name}}", "guests": {{vars.guests}}, "key": "{{secret.MAKE_KEY}}"}',
      timeoutSeconds: 120,
    };
    const req = buildHttpRequest(data, scope);
    expect(req.url).toBe("https://hook.eu1.make.com/abc?order=A%2F12&key={{secret.MAKE_KEY}}");
    expect(req.headers).toEqual({
      Authorization: "Bearer {{secret.MAKE_KEY}}",
      "X-Contact": 'Léa "la cheffe" X-Evil: 1',
    });
    expect(JSON.parse(req.body!.replace("{{secret.MAKE_KEY}}", "k"))).toEqual({ name: 'Léa "la cheffe"', guests: 9, key: "k" });
    expect(req.timeoutMs).toBe(30_000);
  });

  it("sends no body with GET and defaults the timeout to 10 s", () => {
    const req = buildHttpRequest({ method: "GET", url: "https://api.example.com/x", body: '{"a":1}' }, scope);
    expect(req).toEqual({ method: "GET", url: "https://api.example.com/x", headers: {}, timeoutMs: 10_000 });
  });
});

describe("http node validation", () => {
  const graph = (data: Partial<HttpNodeData>): FlowGraph => ({
    nodes: [node("t", "trigger", { triggers: [{ kind: "api" }] }), node("h", "http", { method: "POST", url: "", ...data })],
    edges: [edge("t", "h"), edge("h", "t", "ok")].slice(0, 1),
  });
  const codes = (data: Partial<HttpNodeData>) => validateFlowGraph(graph(data)).map((i) => i.code);

  it("exposes ok and error outputs", () => {
    expect(outputsOf(node("h", "http", { method: "GET", url: "https://a.b" }))).toEqual(["ok", "error"]);
  });

  it("requires an https URL with a written-out host", () => {
    expect(codes({})).toContain("missing_url");
    expect(codes({ url: "http://hook.make.com/x" })).toContain("bad_http_url");
    expect(codes({ url: "https://{{vars.host}}/x" })).toContain("bad_http_url");
    expect(codes({ url: "https://hook.make.com/{{vars.order.id}}" })).toEqual([]);
  });

  it("checks the JSON body with placeholders and the variable name", () => {
    expect(codes({ url: "https://a.b/x", body: '{"n": {{vars.guests}}, "s": "{{contact.name}}"}' })).toEqual([]);
    expect(codes({ url: "https://a.b/x", body: '{"n": oops}' })).toContain("invalid_json_body");
    expect(codes({ url: "https://a.b/x", method: "GET", body: "not json" })).toEqual([]);
    expect(codes({ url: "https://a.b/x", saveAs: "bad name" })).toContain("invalid_variable_name");
  });
});

describe("isAllowedHost", () => {
  it("matches exact domains and *.subdomains only", () => {
    const allow = ["api.example.com", "*.make.com"];
    expect(isAllowedHost("api.example.com", allow)).toBe(true);
    expect(isAllowedHost("API.Example.com.", allow)).toBe(true);
    expect(isAllowedHost("hook.eu1.make.com", allow)).toBe(true);
    expect(isAllowedHost("make.com", allow)).toBe(false);
    expect(isAllowedHost("evilmake.com", allow)).toBe(false);
    expect(isAllowedHost("example.com", allow)).toBe(false);
  });

  it("lets * reach any domain name but not localhost or a bare IP", () => {
    expect(isAllowedHost("api.anything.io", ["*"])).toBe(true);
    expect(isAllowedHost("localhost", ["*"])).toBe(false);
    expect(isAllowedHost("admin.localhost", ["*"])).toBe(false);
    expect(isAllowedHost("169.254.169.254", ["*"])).toBe(false);
    expect(isAllowedHost("[::1]", ["*"])).toBe(false);
    expect(isAllowedHost("10.0.0.5", ["*", "10.0.0.5"])).toBe(true);
  });
});

describe("performHttpRequest", () => {
  const request = (patch: Partial<HttpRequestSpec> = {}): HttpRequestSpec => ({
    method: "POST",
    url: "https://hook.eu1.make.com/abc?key={{secret.MAKE_KEY}}",
    headers: { Authorization: "Bearer {{secret.MAKE_KEY}}" },
    body: '{"key":"{{secret.MAKE_KEY}}"}',
    timeoutMs: 1000,
    ...patch,
  });
  const recorder = (status: number, text: string) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(text, { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  it("fills secrets, adds the JSON content type and parses a JSON answer", async () => {
    const f = recorder(200, '{"booked":true}');
    const res = await performHttpRequest(request(), { allow: ["*.make.com"], secrets: { MAKE_KEY: 'k&"1' }, fetch: f.impl });
    expect(res).toEqual({ ok: true, status: 200, body: { booked: true } });
    expect(f.calls[0].url).toBe("https://hook.eu1.make.com/abc?key=k%26%221");
    expect(f.calls[0].init.headers).toEqual({ Authorization: 'Bearer k&"1', "Content-Type": "application/json" });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ key: 'k&"1' });
    expect(f.calls[0].init.redirect).toBe("manual");
  });

  it("refuses other domains, plain http and unknown secrets before sending", async () => {
    const f = recorder(200, "{}");
    const guard = { allow: ["api.example.com"], secrets: {}, fetch: f.impl };
    expect(await performHttpRequest(request({ url: "https://evil.com/x", headers: {}, body: undefined }), guard)).toMatchObject({ ok: false, error: "domain not allowed: evil.com" });
    expect(await performHttpRequest(request({ url: "http://api.example.com/x", headers: {}, body: undefined }), guard)).toMatchObject({ ok: false, error: "only https URLs can be called" });
    expect(await performHttpRequest(request({ url: "https://api.example.com/x" }), guard)).toMatchObject({ ok: false, error: "unknown secret: MAKE_KEY" });
    expect(f.calls).toHaveLength(0);
  });

  it("returns non-2xx answers as errors with their body, and text bodies as text", async () => {
    const f = recorder(422, "missing field");
    const res = await performHttpRequest(request({ url: "https://api.example.com/x", headers: {}, body: undefined }), { allow: ["api.example.com"], fetch: f.impl });
    expect(res).toEqual({ ok: false, status: 422, body: "missing field" });
  });

  it("caps the response size and times out", async () => {
    const big = recorder(200, "x".repeat(50));
    expect(
      await performHttpRequest(request({ url: "https://api.example.com/x", headers: {}, body: undefined }), { allow: ["api.example.com"], maxBytes: 10, fetch: big.impl }),
    ).toMatchObject({ ok: false, status: 200, error: "response too large" });

    const hanging = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(
      await performHttpRequest(request({ url: "https://api.example.com/x", headers: {}, body: undefined, timeoutMs: 20 }), { allow: ["api.example.com"], fetch: hanging }),
    ).toEqual({ ok: false, status: 0, error: "timeout" });
  });
});

describe("http node in FlowSimulation", () => {
  const flow: FlowGraph = {
    nodes: [
      node("t", "trigger", { triggers: [{ kind: "api" }] }),
      node("h", "http", { method: "POST", url: "https://api.example.com/book", body: '{"guests": {{vars.guests}}}', saveAs: "booking" }),
      node("ok", "message", { text: "Réservé : {{vars.booking.body.ref}}" }),
      node("ko", "message", { text: "Erreur {{vars.booking.status}}" }),
    ],
    edges: [edge("t", "h"), edge("h", "ok", "ok"), edge("h", "ko", "error")],
  };

  it("follows ok with the parsed body in the variable", async () => {
    const sim = new FlowSimulation(flow, {
      contact: { id: "c" },
      vars: { guests: 4 },
      host: { http: () => ({ ok: true, status: 201, body: { ref: "R-7" } }) },
    });
    const step = await sim.start();
    expect(step.requests).toEqual([
      { request: { method: "POST", url: "https://api.example.com/book", headers: {}, body: '{"guests": 4}', timeoutMs: 10_000 }, status: 201, ok: true },
    ]);
    expect(step.messages).toEqual([{ type: "text", text: "Réservé : R-7" }]);
  });

  it("follows error without a handler or on a failed call", async () => {
    const none = await new FlowSimulation(flow, { contact: { id: "c" } }).start();
    expect(none.messages).toEqual([{ type: "text", text: "Erreur 0" }]);
    const failed = await new FlowSimulation(flow, {
      contact: { id: "c" },
      host: { http: () => ({ ok: false, status: 503, body: "down" }) },
    }).start();
    expect(failed.messages).toEqual([{ type: "text", text: "Erreur 503" }]);
  });
});
