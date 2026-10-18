import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server.js";

/**
 * Folders of the editor's workflow list. A workflow names its folder
 * (`flows.folder`); a `flowFolders` row keeps a folder that has no workflow
 * yet (or any more) until it is deleted.
 */

/** Records the folder so it stays listed even once empty. */
export async function ensureFolder(ctx: MutationCtx, ownerId: string | undefined, name: string) {
  const existing = await ctx.db
    .query("flowFolders")
    .withIndex("by_owner_name", (q) => q.eq("ownerId", ownerId).eq("name", name))
    .first();
  if (!existing) await ctx.db.insert("flowFolders", { ownerId, name });
}

async function folderRow(ctx: MutationCtx, ownerId: string | undefined, name: string) {
  return ctx.db
    .query("flowFolders")
    .withIndex("by_owner_name", (q) => q.eq("ownerId", ownerId).eq("name", name))
    .first();
}

async function flowsIn(ctx: MutationCtx, ownerId: string | undefined, name: string) {
  const flows = await ctx.db
    .query("flows")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .collect();
  return flows.filter((f) => f.folder === name);
}

/** Every folder: created ones and the ones workflows are filed in, by name. */
export const list = query({
  args: { ownerId: v.optional(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { ownerId }) => {
    const saved = await ctx.db
      .query("flowFolders")
      .withIndex("by_owner_name", (q) => q.eq("ownerId", ownerId))
      .collect();
    const flows = await ctx.db
      .query("flows")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
    const names = new Set([...saved.map((f) => f.name), ...flows.flatMap((f) => (f.folder ? [f.folder] : []))]);
    return [...names].sort((a, b) => a.localeCompare(b));
  },
});

export const create = mutation({
  args: { ownerId: v.optional(v.string()), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, name }) => {
    const folder = name.trim();
    if (!folder) throw new Error("A folder needs a name");
    await ensureFolder(ctx, ownerId, folder);
    return null;
  },
});

/** Renames a folder; into an existing folder's name, the two are merged. */
export const rename = mutation({
  args: { ownerId: v.optional(v.string()), from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, from, to }) => {
    const name = to.trim();
    if (!name) throw new Error("A folder needs a name");
    if (name === from) return null;
    for (const flow of await flowsIn(ctx, ownerId, from)) await ctx.db.patch(flow._id, { folder: name });
    const row = await folderRow(ctx, ownerId, from);
    if (row) await ctx.db.delete(row._id);
    await ensureFolder(ctx, ownerId, name);
    return null;
  },
});

/** Deletes a folder; its workflows are kept, without a folder. */
export const remove = mutation({
  args: { ownerId: v.optional(v.string()), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId, name }) => {
    for (const flow of await flowsIn(ctx, ownerId, name)) await ctx.db.patch(flow._id, { folder: undefined });
    const row = await folderRow(ctx, ownerId, name);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});
