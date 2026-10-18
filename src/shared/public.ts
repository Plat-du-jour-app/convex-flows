/**
 * Browser-safe entry point (`convex-flows/shared`): types, workflow helpers
 * and capabilities, without the Convex client class. Used by editors.
 */
export * from "./flowTypes.js";
export * from "./flowRuntime.js";
export * from "./capabilities.js";
export * from "./limits.js";
export { toPlainText, buildSendBodies } from "./build.js";
export { INBOX_PLATFORMS } from "./client.js";
export type { InboxAccount } from "./client.js";
export type * from "./types.js";
export * from "./simulate.js";
