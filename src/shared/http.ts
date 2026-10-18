import type { HostHttpResult, HttpRequestSpec } from "./flowTypes.js";

const SECRET = /\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g;
const DEFAULT_MAX_BYTES = 100_000;

export type HttpGuard = {
  /**
   * Domains workflows may call: `hook.eu1.make.com` exactly, `*.make.com` for
   * its subdomains, or `*` for any public domain (only when everyone who edits
   * workflows is trusted). Anything else is refused before sending.
   */
  allow: string[];
  /** Values of `{{secret.NAME}}` (API keys, tokens), never stored in a graph. */
  secrets?: Record<string, string>;
  /** Largest response read, in characters (default 100 000). */
  maxBytes?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

/** IP literals and localhost: reachable through `*` never, only when listed as such. */
function isLocalOrIp(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.includes(":") ||
    host.startsWith("[")
  );
}

/**
 * Whether `hostname` is one of the allowed domains: `*.example.com` matches
 * subdomains only, `*` any domain name (not localhost or a bare IP address).
 */
export function isAllowedHost(hostname: string, allow: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return !isLocalOrIp(host);
    if (rule.startsWith("*.")) return host.endsWith(rule.slice(1));
    return host === rule;
  });
}

/** Fills `{{secret.NAME}}`; reports the first unknown name. */
function fillSecrets(
  text: string,
  secrets: Record<string, string>,
  encode: (value: string) => string,
): { text: string; missing?: string } {
  let missing: string | undefined;
  const filled = text.replace(SECRET, (_, name: string) => {
    const value = secrets[name];
    if (value === undefined) {
      missing ??= name;
      return "";
    }
    return encode(value);
  });
  return { text: filled, ...(missing ? { missing } : {}) };
}

/**
 * Sends the request an `http` node built, for the host's http handle: https
 * only, to allowed domains only, with secrets filled in, within the node's
 * timeout. Redirects are not followed (a 3xx is returned as is), so a call
 * cannot be bounced to a domain the host did not allow. Never throws.
 */
export async function performHttpRequest(request: HttpRequestSpec, guard: HttpGuard): Promise<HostHttpResult> {
  const fail = (error: string): HostHttpResult => ({ ok: false, status: 0, error });
  const secrets = guard.secrets ?? {};

  const url = fillSecrets(request.url, secrets, encodeURIComponent);
  if (url.missing) return fail(`unknown secret: ${url.missing}`);
  let parsed: URL;
  try {
    parsed = new URL(url.text);
  } catch {
    return fail("invalid URL");
  }
  if (parsed.protocol !== "https:") return fail("only https URLs can be called");
  if (!isAllowedHost(parsed.hostname, guard.allow)) return fail(`domain not allowed: ${parsed.hostname}`);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const filled = fillSecrets(value, secrets, (v) => v.replace(/[\r\n]+/g, " "));
    if (filled.missing) return fail(`unknown secret: ${filled.missing}`);
    headers[name] = filled.text;
  }
  let body: string | undefined;
  if (request.body !== undefined) {
    const filled = fillSecrets(request.body, secrets, (v) => JSON.stringify(v).slice(1, -1));
    if (filled.missing) return fail(`unknown secret: ${filled.missing}`);
    body = filled.text;
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  const fetchImpl = guard.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetchImpl(parsed.toString(), {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > (guard.maxBytes ?? DEFAULT_MAX_BYTES)) {
      return { ok: false, status: response.status, error: "response too large" };
    }
    let parsedBody: unknown = text;
    try {
      parsedBody = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text.
    }
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, body: parsedBody };
  } catch (e) {
    if (controller.signal.aborted) return fail("timeout");
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
