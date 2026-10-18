import type {
  FunctionArgs,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

export * from "../shared/flowTypes.js";
export * from "../shared/flowRuntime.js";
export * from "../shared/simulate.js";

export { ZernioClient, DEFAULT_ZERNIO_BASE_URL, INBOX_PLATFORMS } from "../shared/client.js";
export type { ZernioClientOptions, InboxAccount } from "../shared/client.js";
export { buildSendBodies, toPlainText } from "../shared/build.js";
export type { BuiltSend } from "../shared/build.js";
export { PLATFORM_CAPABILITIES, capabilitiesOf, isPlatform } from "../shared/capabilities.js";
export type { PlatformCapabilities } from "../shared/capabilities.js";
export { normalizeZernioWebhook } from "../shared/normalize.js";
export {
  computeZernioSignature,
  verifyZernioSignature,
  signatureFromHeaders,
  SIGNATURE_HEADERS,
  EVENT_ID_HEADER,
} from "../shared/signature.js";
export {
  WHATSAPP_LIMITS,
  META_LIMITS,
  TELEGRAM_LIMITS,
  truncate,
  truncateBytes,
} from "../shared/limits.js";
export type * from "../shared/types.js";
export type { ComponentApi };

/** Any context able to run a mutation: mutation, action or HTTP action. */
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};

/** Any context able to run a query: query, mutation, action or HTTP action. */
type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

/** Any context able to run an action: action or HTTP action. */
type RunActionCtx = {
  runAction: GenericActionCtx<GenericDataModel>["runAction"];
};

type EngineApi = ComponentApi["engine"];
type FlowsApi = ComponentApi["flows"];
type FoldersApi = ComponentApi["folders"];
export type HandleInboundArgs = FunctionArgs<EngineApi["handleInbound"]>;
export type FlowRunResult = FunctionReturnType<EngineApi["handleInbound"]>;

export type ConversationAutomation = {
  conversationId: string;
  botPaused: boolean;
  pausedAt?: number;
  pausedBy?: string;
};

/**
 * App-side handle on the installed component.
 *
 * ```ts
 * import { components } from "./_generated/api";
 * const flows = new ConvexFlows(components.convexFlows);
 * ```
 */
export class ConvexFlows {
  constructor(public readonly component: ComponentApi) {}

  /**
   * Claims a Zernio webhook event id. True on the first delivery, false on
   * Zernio's retries and redeliveries of the same event.
   */
  async claimWebhookEvent(
    ctx: RunMutationCtx,
    args: { eventId: string; event: string },
  ): Promise<boolean> {
    return ctx.runMutation(this.component.webhookEvents.claim, args);
  }

  /** Deletes claimed event ids older than `before` (ms epoch). */
  async purgeWebhookEvents(
    ctx: RunMutationCtx,
    args: { before: number; limit?: number },
  ): Promise<{ deleted: number; hasMore: boolean }> {
    return ctx.runMutation(this.component.webhookEvents.purge, args);
  }

  /** Human takeover: pause (or resume) the bot on a conversation. */
  async setBotPaused(
    ctx: RunMutationCtx,
    args: { conversationId: string; paused: boolean; by?: string },
  ): Promise<void> {
    await ctx.runMutation(this.component.conversations.setBotPaused, args);
  }

  /** True when a human has taken the conversation over. */
  async isBotPaused(ctx: RunQueryCtx, conversationId: string): Promise<boolean> {
    return ctx.runQuery(this.component.conversations.isBotPaused, { conversationId });
  }

  /** Automation state of several conversations at once (for inbox lists). */
  async getConversationStates(
    ctx: RunQueryCtx,
    conversationIds: string[],
  ): Promise<ConversationAutomation[]> {
    return ctx.runQuery(this.component.conversations.getStates, { conversationIds });
  }

  /** Conversations currently handled by a human. */
  async listPausedConversations(
    ctx: RunQueryCtx,
    limit?: number,
  ): Promise<ConversationAutomation[]> {
    return ctx.runQuery(this.component.conversations.listPaused, { limit });
  }

  // ─── Workflows (editor side) ───

  listFlows(ctx: RunQueryCtx, ownerId?: string) {
    return ctx.runQuery(this.component.flows.list, { ownerId });
  }

  getFlow(ctx: RunQueryCtx, flowId: string) {
    return ctx.runQuery(this.component.flows.get, { flowId });
  }

  /** A workflow by the key the host gave it at creation. */
  getFlowByKey(ctx: RunQueryCtx, key: string, ownerId?: string) {
    return ctx.runQuery(this.component.flows.getByKey, { key, ownerId });
  }

  /** Keys of the published, turned-on workflows (e.g. to retire code they replace). */
  activeFlowKeys(ctx: RunQueryCtx, ownerId?: string): Promise<string[]> {
    return ctx.runQuery(this.component.flows.activeKeys, { ownerId });
  }

  createFlow(ctx: RunMutationCtx, args: FunctionArgs<FlowsApi["create"]>) {
    return ctx.runMutation(this.component.flows.create, args);
  }

  saveFlowDraft(ctx: RunMutationCtx, args: FunctionArgs<FlowsApi["saveDraft"]>) {
    return ctx.runMutation(this.component.flows.saveDraft, args);
  }

  /** Files workflows in a folder ("" = no folder); not counted as an edit. */
  setFlowFolder(ctx: RunMutationCtx, args: FunctionArgs<FlowsApi["setFolder"]>) {
    return ctx.runMutation(this.component.flows.setFolder, args);
  }

  /** Folders of the workflow list (created ones, even empty, and the ones in use). */
  listFlowFolders(ctx: RunQueryCtx, ownerId?: string): Promise<string[]> {
    return ctx.runQuery(this.component.folders.list, { ownerId });
  }

  createFlowFolder(ctx: RunMutationCtx, args: FunctionArgs<FoldersApi["create"]>) {
    return ctx.runMutation(this.component.folders.create, args);
  }

  /** Renames a folder (merges into an existing one of that name). */
  renameFlowFolder(ctx: RunMutationCtx, args: FunctionArgs<FoldersApi["rename"]>) {
    return ctx.runMutation(this.component.folders.rename, args);
  }

  /** Deletes a folder; its workflows stay, without a folder. */
  removeFlowFolder(ctx: RunMutationCtx, args: FunctionArgs<FoldersApi["remove"]>) {
    return ctx.runMutation(this.component.folders.remove, args);
  }

  /** Validates (against the host's action catalog) and publishes the draft. */
  publishFlow(ctx: RunMutationCtx, args: FunctionArgs<FlowsApi["publish"]>) {
    return ctx.runMutation(this.component.flows.publish, args);
  }

  setFlowActive(ctx: RunMutationCtx, args: FunctionArgs<FlowsApi["setActive"]>) {
    return ctx.runMutation(this.component.flows.setActive, args);
  }

  removeFlow(ctx: RunMutationCtx, flowId: string) {
    return ctx.runMutation(this.component.flows.remove, { flowId });
  }

  flowRuns(ctx: RunQueryCtx, flowId: string, limit?: number) {
    return ctx.runQuery(this.component.flows.runs, { flowId, limit });
  }

  // ─── Workflows (runtime side) ───

  /**
   * Gives an inbound message to the engine. `handled: false` means no
   * workflow took it: process it with the host's own logic.
   */
  handleInbound(ctx: RunActionCtx, args: FunctionArgs<EngineApi["handleInbound"]>) {
    return ctx.runAction(this.component.engine.handleInbound, args);
  }

  /** Starts one workflow for a conversation (host code, or the simulator with `useDraft`). */
  startFlow(ctx: RunActionCtx, args: FunctionArgs<EngineApi["startFlow"]>) {
    return ctx.runAction(this.component.engine.startFlow, args);
  }

  /**
   * Tells the conversation's run waiting on `event` (`wait_event` node) that
   * it happened. True if a run was waiting. Works from mutations.
   */
  emitEvent(ctx: RunMutationCtx, args: { conversationId: string; event: string; data?: unknown }): Promise<boolean> {
    return ctx.runMutation(this.component.engine.emitEvent, args);
  }

  /** `emitEvent` run immediately, returning the messages sent (simulator). */
  deliverEvent(ctx: RunActionCtx, args: { conversationId: string; event: string; data?: unknown }) {
    return ctx.runAction(this.component.engine.deliverEvent, args);
  }

  /** Stops the conversation's workflow run, if any. */
  cancelRun(ctx: RunMutationCtx, conversationId: string) {
    return ctx.runMutation(this.component.engine.cancel, { conversationId });
  }
}
