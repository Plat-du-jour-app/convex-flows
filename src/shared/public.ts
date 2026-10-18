/**
 * Browser-safe entry point (`convex-flows/shared`): types, workflow helpers
 * and capabilities, without the Convex client class. Used by editors.
 */
export * from "./flowTypes.js";
export * from "./flowRuntime.js";
export * from "./capabilities.js";
export * from "./limits.js";
export { toPlainText, buildSendBodies, buildStartConversationBody } from "./build.js";
export { summarizeWhatsAppTemplate, renderWhatsAppTemplate } from "./templates.js";
export { INBOX_PLATFORMS } from "./client.js";
export type { InboxAccount } from "./client.js";
export type * from "./types.js";
export * from "./simulate.js";
