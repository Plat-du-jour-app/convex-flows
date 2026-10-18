/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    conversations: {
      getStates: FunctionReference<
        "query",
        "internal",
        { conversationIds: Array<string> },
        Array<{
          botPaused: boolean;
          conversationId: string;
          pausedAt?: number;
          pausedBy?: string;
        }>,
        Name
      >;
      isBotPaused: FunctionReference<
        "query",
        "internal",
        { conversationId: string },
        boolean,
        Name
      >;
      listPaused: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        Array<{
          botPaused: boolean;
          conversationId: string;
          pausedAt?: number;
          pausedBy?: string;
        }>,
        Name
      >;
      setBotPaused: FunctionReference<
        "mutation",
        "internal",
        { by?: string; conversationId: string; paused: boolean },
        null,
        Name
      >;
    };
    engine: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { conversationId: string },
        number,
        Name
      >;
      deliverEvent: FunctionReference<
        "action",
        "internal",
        { conversationId: string; data?: any; event: string },
        {
          busy?: boolean;
          flowId?: string;
          handled: boolean;
          messages: Array<any>;
          released?: boolean;
          sessionId?: string;
          status?: "running" | "waiting" | "done" | "cancelled" | "failed";
          trace: Array<string>;
          waitEvent?: string;
        },
        Name
      >;
      emitEvent: FunctionReference<
        "mutation",
        "internal",
        { conversationId: string; data?: any; event: string },
        boolean,
        Name
      >;
      handleInbound: FunctionReference<
        "action",
        "internal",
        {
          accountId?: string;
          actionHandle?: string;
          allowTriggers?: boolean;
          allowUnscoped?: boolean;
          contact: {
            id: string;
            locale?: string;
            name?: string;
            phone?: string;
            segments?: Array<string>;
          };
          conversationId: string;
          dryRun?: boolean;
          excludeFlowIds?: Array<string>;
          hostContext?: any;
          input: {
            imageUrl?: string;
            location?: {
              address?: string;
              latitude: number;
              longitude: number;
              name?: string;
            };
            replyId?: string;
            text: string;
          };
          isFirstMessage?: boolean;
          ownerId?: string;
          platform: string;
          sendHandle: string;
          textsHandle?: string;
          triggerKinds?: Array<string>;
        },
        {
          busy?: boolean;
          flowId?: string;
          handled: boolean;
          messages: Array<any>;
          released?: boolean;
          sessionId?: string;
          status?: "running" | "waiting" | "done" | "cancelled" | "failed";
          trace: Array<string>;
          waitEvent?: string;
        },
        Name
      >;
      startFlow: FunctionReference<
        "action",
        "internal",
        {
          accountId?: string;
          actionHandle?: string;
          contact: {
            id: string;
            locale?: string;
            name?: string;
            phone?: string;
            segments?: Array<string>;
          };
          conversationId: string;
          dryRun?: boolean;
          flowId: string;
          hostContext?: any;
          input?: {
            imageUrl?: string;
            location?: {
              address?: string;
              latitude: number;
              longitude: number;
              name?: string;
            };
            replyId?: string;
            text: string;
          };
          ownerId?: string;
          platform: string;
          sendHandle: string;
          textsHandle?: string;
          useDraft?: boolean;
          vars?: any;
        },
        {
          busy?: boolean;
          flowId?: string;
          handled: boolean;
          messages: Array<any>;
          released?: boolean;
          sessionId?: string;
          status?: "running" | "waiting" | "done" | "cancelled" | "failed";
          trace: Array<string>;
          waitEvent?: string;
        },
        Name
      >;
    };
    flows: {
      activeKeys: FunctionReference<
        "query",
        "internal",
        { ownerId?: string },
        Array<string>,
        Name
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        {
          by?: string;
          description?: string;
          folder?: string;
          graph?: any;
          key?: string;
          name: string;
          ownerId?: string;
        },
        string,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { flowId: string },
        null | {
          _creationTime: number;
          _id: string;
          active: boolean;
          description?: string;
          draft: any;
          folder?: string;
          hasDraftChanges: boolean;
          key?: string;
          name: string;
          ownerId?: string;
          published?: any;
          publishedAt?: number;
          updatedAt: number;
          updatedBy?: string;
          version: number;
        },
        Name
      >;
      getByKey: FunctionReference<
        "query",
        "internal",
        { key: string; ownerId?: string },
        null | {
          _creationTime: number;
          _id: string;
          active: boolean;
          description?: string;
          draft: any;
          folder?: string;
          hasDraftChanges: boolean;
          key?: string;
          name: string;
          ownerId?: string;
          published?: any;
          publishedAt?: number;
          updatedAt: number;
          updatedBy?: string;
          version: number;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { ownerId?: string },
        Array<{
          _id: string;
          accounts: Array<any>;
          active: boolean;
          description?: string;
          folder?: string;
          hasDraftChanges: boolean;
          key?: string;
          name: string;
          nodeCount: number;
          published: boolean;
          publishedAt?: number;
          triggers: Array<any>;
          updatedAt: number;
          updatedBy?: string;
          version: number;
        }>,
        Name
      >;
      publish: FunctionReference<
        "mutation",
        "internal",
        {
          actions?: any;
          by?: string;
          flowId: string;
          publishingWith?: Array<string>;
          requireAccounts?: boolean;
        },
        | { ok: true; version: number }
        | {
            issues: Array<{ code: string; detail?: string; nodeId?: string }>;
            ok: false;
          },
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { flowId: string },
        null,
        Name
      >;
      runs: FunctionReference<
        "query",
        "internal",
        { flowId: string; limit?: number },
        Array<{
          _id: string;
          contact: any;
          conversationId: string;
          error?: string;
          nodeId: string;
          startedAt: number;
          status: string;
          updatedAt: number;
          version: number;
        }>,
        Name
      >;
      saveDraft: FunctionReference<
        "mutation",
        "internal",
        {
          by?: string;
          description?: string;
          flowId: string;
          graph?: any;
          name?: string;
        },
        null,
        Name
      >;
      setActive: FunctionReference<
        "mutation",
        "internal",
        { active: boolean; flowId: string },
        null,
        Name
      >;
      setFolder: FunctionReference<
        "mutation",
        "internal",
        { flowIds: Array<string>; folder: string },
        null,
        Name
      >;
    };
    folders: {
      create: FunctionReference<
        "mutation",
        "internal",
        { name: string; ownerId?: string },
        null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { ownerId?: string },
        Array<string>,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { name: string; ownerId?: string },
        null,
        Name
      >;
      rename: FunctionReference<
        "mutation",
        "internal",
        { from: string; ownerId?: string; to: string },
        null,
        Name
      >;
    };
    webhookEvents: {
      claim: FunctionReference<
        "mutation",
        "internal",
        { event: string; eventId: string },
        boolean,
        Name
      >;
      purge: FunctionReference<
        "mutation",
        "internal",
        { before: number; limit?: number },
        { deleted: number; hasMore: boolean },
        Name
      >;
    };
  };
