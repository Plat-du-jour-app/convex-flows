import type { WhatsAppTemplate, WhatsAppTemplateParam } from "./types.js";

/** `{{1}}`, `{{ first_name }}`… */
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Placeholder names of one text, each once, in order of first appearance. */
function placeholders(text: string | undefined): string[] {
  const names: string[] = [];
  for (const match of (text ?? "").matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

type RawComponent = {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
};

/**
 * Flattens a template from `GET /v1/whatsapp/templates` (Meta's component
 * list) into header / body / footer / buttons, and lists the values a send
 * takes in Zernio's order: text-header variables, body variables, then one
 * per dynamic URL button.
 */
export function summarizeWhatsAppTemplate(raw: {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: Array<Record<string, unknown>>;
}): WhatsAppTemplate {
  const components = (raw.components ?? []) as RawComponent[];
  const find = (type: string) => components.find((c) => c.type?.toUpperCase() === type);
  const header = find("HEADER");
  const headerFormat = header?.format?.toUpperCase();
  const headerText = headerFormat === "TEXT" ? header?.text : undefined;
  const body = find("BODY")?.text ?? "";
  const footer = find("FOOTER")?.text;
  const buttons = (find("BUTTONS")?.buttons ?? []).map((b) => ({
    type: (b.type ?? "").toUpperCase(),
    text: b.text ?? "",
    ...(b.url ? { url: b.url } : {}),
  }));

  const params: WhatsAppTemplateParam[] = [
    ...placeholders(headerText).map((name) => ({ part: "header" as const, name })),
    ...placeholders(body).map((name) => ({ part: "body" as const, name })),
    ...buttons
      .filter((b) => b.type === "URL" && placeholders(b.url).length > 0)
      .map((b) => ({ part: "button" as const, name: b.text })),
  ];

  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    language: raw.language ?? "",
    status: raw.status ?? "",
    category: raw.category ?? "",
    ...(headerFormat ? { headerFormat } : {}),
    ...(headerText ? { headerText } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons,
    params,
  };
}

/**
 * The text a contact reads once `values` (same order as `template.params`)
 * fill the header and body, for previews and message logs. Placeholders
 * without a value stay as they are.
 */
export function renderWhatsAppTemplate(template: WhatsAppTemplate, values: string[] = []): string {
  const fill = (text: string | undefined, part: "header" | "body") => {
    if (!text) return text;
    const byName = new Map<string, string>();
    template.params.forEach((p, i) => {
      if (p.part === part && values[i] !== undefined && values[i] !== "") byName.set(p.name, values[i]);
    });
    return text.replace(PLACEHOLDER, (whole, name: string) => byName.get(name) ?? whole);
  };
  return [fill(template.headerText, "header"), fill(template.body, "body"), template.footer]
    .filter(Boolean)
    .join("\n\n");
}
