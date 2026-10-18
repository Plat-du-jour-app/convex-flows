# convex-flows

Convex component for conversational bots over the whole [Zernio](https://zernio.com) inbox:
WhatsApp, Instagram, Messenger, Telegram, SMS, RCS, X, Bluesky, Reddit, Slack, TikTok and iMessage.

It is the transport layer plus a workflow engine: graphs built in an editor, run per
conversation, with the host app's own actions, texts and audiences plugged in.

## What it does

- **Send any message intent on any platform.** `text`, `buttons`, `list`, `ctaUrl`,
  `locationRequest`, `location`, `media`, `carousel`, `template`, `contacts`. Each one is
  rendered natively where the platform supports it (WhatsApp interactive messages, Meta
  button templates / quick replies / generic templates, Telegram inline keyboards) and degraded
  to readable text elsewhere. See `PLATFORM_CAPABILITIES`.
- **Read every inbox webhook the same way.** `normalizeZernioWebhook` returns `message`
  (received and sent), `status` (delivered, read, played, failed), `reaction`, `comment`,
  `conversationStarted`, `referral` or `other`. A tap on a button, list row, quick reply, postback
  or Telegram callback always lands in `message.reply` (`{ kind, id, title }`). Shared locations
  are read from `metadata.location` and from the older Late payloads.
- **Verify signatures.** `X-Zernio-Signature` (or the legacy `X-Late-Signature`), HMAC-SHA256 of
  the raw body, via Web Crypto (works in both Convex runtimes).
- **Dedupe deliveries.** The component stores Zernio event ids. Zernio retries a delivery up to
  7 times over ~51h with the same id.
- **Reply to comments.** Public reply and Instagram/Messenger private reply.
- **Write first.** Open a conversation with an approved WhatsApp template (listed with their
  variables), Direct Send, or plain text on SMS, X, Slack…

## Install

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import convexFlows from "convex-flows/convex.config.js";

const app = defineApp();
app.use(convexFlows);
export default app;
```

```ts
import { ConvexFlows, ZernioClient, normalizeZernioWebhook, verifyZernioSignature, signatureFromHeaders } from "convex-flows";
import { components } from "./_generated/api";

export const flows = new ConvexFlows(components.convexFlows);
const zernio = new ZernioClient({ apiKey: process.env.ZERNIO_API_KEY! });
```

## Webhook handler

```ts
http.route({
  path: "/zernio/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;
    if (secret && !(await verifyZernioSignature(secret, raw, signatureFromHeaders(request.headers)))) {
      return new Response("Invalid signature", { status: 401 });
    }
    const event = normalizeZernioWebhook(JSON.parse(raw), request.headers);
    if (event.eventId && !(await flows.claimWebhookEvent(ctx, { eventId: event.eventId, event: event.event }))) {
      return new Response("OK");
    }
    if (event.kind === "message" && event.direction === "incoming") {
      // event.platform, event.text, event.reply, event.location, event.attachments…
    }
    return new Response("OK");
  }),
});
```

Set the same secret on the Zernio webhook **before** setting `ZERNIO_WEBHOOK_SECRET` on the
deployment: Zernio only signs deliveries when the webhook has a secret.

## Sending

```ts
const target = { conversationId: event.conversationId, accountId: event.accountId, platform: "instagram" as const };
await zernio.send(target, {
  type: "list",
  text: "Que veux-tu faire ?",
  buttonLabel: "Menu",
  sections: [{ rows: [{ id: "menu", title: "Voir la carte" }, { id: "book", title: "Réserver" }] }],
});
// → Instagram quick replies; a WhatsApp list; a Telegram inline keyboard; numbered text on SMS.

await zernio.sendWithFallback(target, { type: "locationRequest", text: "Envoie ta position 📍" });
```

`buildSendBodies(platform, accountId, msg)` exposes the exact request bodies (and a `degraded`
flag) without sending, which is useful for previews and tests.

## Starting a conversation

`send` answers inside a conversation. To write first (a number that never wrote to the account,
or a WhatsApp contact whose 24h window is closed), use `startConversation`. Zernio reuses the
existing conversation with that participant, and the result carries its `conversationId`.

```ts
const templates = await zernio.listWhatsAppTemplates(accountId); // approved ones
// → [{ name: "relance_menu", language: "fr", body: "Bonjour {{1}}…", params: [{ part: "body", name: "1" }], … }]

const result = await zernio.startConversation({
  accountId,
  platform: "whatsapp",
  to: "+33 6 12 34 56 78", // sent as 33612345678
  template: { name: "relance_menu", language: "fr", params: ["Léa"] },
});
if (result.ok) result.conversationId;
else result.code; // TEMPLATE_REQUIRED, INVALID_TEMPLATE_PARAMS, recipient_opted_out…
```

`params` is one flat list in the order of `template.params`: text-header variables, body
variables, then one value per dynamic URL button. Media headers are filled from the approved
template (`headerMedia` overrides them); `headerLocation` and `buttonParams` cover location
headers and copy-code / flow buttons. Without a template, WhatsApp takes `text` with
`utility: true` (Direct Send) when the account is eligible; other platforms take plain `text`
(`to` is a phone for SMS, a user id for X, a member id for Slack; `username` for X, Bluesky and
Reddit handles). `renderWhatsAppTemplate(template, params)` gives the text the contact reads,
for previews and message logs, and `buildStartConversationBody` the exact request body.

## Workflows

A workflow is a graph: one `trigger` node, then nodes linked by named outputs.

| Node | What it does | Outputs |
|---|---|---|
| `trigger` | Keyword (exact / contains / startsWith), first message, location, image, any message, or `api` (started by code). Each trigger can be limited to audiences (`segments`). | `next` |
| `message` | Text, image, up to 3 buttons, a list, or a link. `choices` adds options computed at run time from a variable (list of `{ id, title, description? }`). | one per option, `chosen`, `empty`, `other` / `next` |
| `ask` | Question; stores the answer (text, location, image) in a variable. | `reply`, `other`, `timeout` |
| `condition` | Rules on `vars.*`, `contact.*`, `last.*`: equals, contains, one of, contains any, starts with, exists, greater/less than. | `true`, `false` |
| `action` | Host action (catalog given to the editor and to `publish`). | the action's outputs |
| `flow` | Runs another workflow with the same variables; with `returnAfter`, continues here when it ends. | `next` (with return) |
| `wait_event` | Waits until the host calls `emitEvent(conversationId, event, data)`. | `received`, `timeout` |
| `http` | Calls an external URL (Make, n8n, a CRM…); the response lands in a variable. | `ok`, `error` |
| `release` | Ends the run and gives the contact's message back to the host (its own bot, or another workflow). | |
| `delay`, `set_variable`, `handoff`, `end` | Wait, store a value, hand to a human, stop. | |

The host hands every inbound message to `handleInbound` with function handles for sending,
actions and texts (`{{t.key}}`), the contact's `segments`, and optionally `triggerKinds` (e.g.
keyword workflows before its own bot, `any` workflows after it). Workflows can carry a `key`
so the host's code can find them (`getFlowByKey`, `activeFlowKeys`), and a `folder` for the editor's
list (`createFlow({ folder })`, `setFlowFolder`; filing is not an edit, `updatedAt` stays).
Folders are kept even while empty: `listFlowFolders`, `createFlowFolder`, `renameFlowFolder`,
`removeFlowFolder` (its workflows stay, without a folder).

A result with `released` means the message is free again: the host may call `handleInbound`
once more with `excludeFlowIds: [result.flowId]`. `busy` means the conversation's run is still
processing an earlier message: hand this one in again a few seconds later. Keywords are matched
on the first line of the message (list replies arrive as "title\ndescription"); keywords made of
symbols only (`?`, `✅`) are compared as typed. `publish` takes `publishingWith` to publish
workflows that run each other in one go. `FlowSimulation` runs a graph in memory with the
engine's semantics, for tests.

## Calling an API from a workflow

An `http` node calls an https URL and follows `ok` (2xx) or `error` (other status, timeout,
refused). With `saveAs`, `vars.<saveAs>` holds `{ status, body }`, the body parsed when it is
JSON, so a `condition` can test `vars.booking.body.status`.

```json
{
  "method": "POST",
  "url": "https://hook.eu1.make.com/abc123?order={{vars.order.id}}",
  "headers": [{ "name": "Authorization", "value": "Bearer {{secret.MAKE_TOKEN}}" }],
  "body": "{\"name\": \"{{contact.name}}\", \"guests\": {{vars.guests}}}",
  "saveAs": "booking",
  "timeoutSeconds": 10
}
```

Placeholders are URL-encoded in the URL and JSON-escaped in the body (put them inside quotes;
numbers may stand alone). The host name is always written out, never a placeholder.
`{{secret.NAME}}` is never filled by the engine: the host fills it when it sends, so keys stay out
of graphs and editors.

The engine does not send anything itself. The host passes an `httpHandle` with `handleInbound` /
`startFlow`, and decides which domains workflows may reach (`api.example.com`, `*.make.com`
for subdomains, or `*` for any public domain name; localhost and bare IP addresses are only
reached when listed as such). `performHttpRequest` does the work:
https only, allowed domains only, redirects not followed, timeout, response size cap.

```ts
import { performHttpRequest, type HostHttpArgs } from "convex-flows";

export const flowsHttp = internalAction({
  args: { request: v.any(), conversationId: v.string(), platform: v.string(),
          accountId: v.optional(v.string()), hostContext: v.any(), contact: v.any() },
  handler: (_ctx, args: HostHttpArgs) =>
    performHttpRequest(args.request, {
      allow: ["*.make.com", "api.example.com"],
      secrets: { MAKE_TOKEN: process.env.MAKE_TOKEN! },
    }),
});

// with the other handles:
httpHandle: await createFunctionHandle(internal.flows.flowsHttp),
```

Without an `httpHandle`, `http` nodes follow `error`. In a dry run (the editor's simulator) no
request leaves: the node follows `ok` with `{ status: 0, body: null, skipped: true }`.
`FlowSimulation` takes a `host.http` function to fake responses in tests.

## Develop

```bash
npm install
npm test               # vitest: transport and workflow runtime
npm run build          # dist/ (what consumers import)
npm pack               # convex-flows-<version>.tgz, installable with file:
```

Component codegen needs a deployment; the example app runs on a local anonymous backend:

```bash
CONVEX_AGENT_MODE=anonymous npx convex dev --local --once
```

## License

MIT
