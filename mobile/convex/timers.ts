import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const timerStatus = v.union(
  v.literal("running"),
  v.literal("paused"),
  v.literal("completed"),
  v.literal("cancelled"),
);

const timerResult = v.object({
  _id: v.id("timers"),
  _creationTime: v.number(),
  sessionId: v.id("cookingSessions"),
  label: v.string(),
  durationSeconds: v.number(),
  endsAt: v.number(),
  status: timerStatus,
  remainingSeconds: v.optional(v.number()),
  createdAt: v.number(),
});

export const listRunning = query({
  args: { sessionId: v.id("cookingSessions") },
  returns: v.array(timerResult),
  handler: async (ctx, args) => {
    const [running, paused] = await Promise.all([
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", args.sessionId).eq("status", "running"),
        )
        .order("asc")
        .take(10),
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", args.sessionId).eq("status", "paused"),
        )
        .order("asc")
        .take(10),
    ]);
    return [...running, ...paused];
  },
});

export const start = mutation({
  args: {
    sessionId: v.id("cookingSessions"),
    label: v.string(),
    durationSeconds: v.number(),
  },
  returns: v.object({ timerId: v.id("timers"), endsAt: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Cooking session not found.");
    }

    const durationSeconds = Math.max(10, Math.min(7200, Math.round(args.durationSeconds)));
    const now = Date.now();
    const endsAt = now + durationSeconds * 1000;
    const timerId = await ctx.db.insert("timers", {
      sessionId: args.sessionId,
      label: args.label.trim().slice(0, 80) || "Kitchen timer",
      durationSeconds,
      endsAt,
      status: "running",
      createdAt: now,
    });

    await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "timer",
      text: `Started ${durationSeconds}-second timer.`,
      createdAt: now,
    });
    return { timerId, endsAt };
  },
});

export const complete = mutation({
  args: { timerId: v.id("timers") },
  returns: v.object({ completed: v.boolean() }),
  handler: async (ctx, args) => {
    const timer = await ctx.db.get(args.timerId);
    if (!timer || (timer.status !== "running" && timer.status !== "paused")) {
      return { completed: false };
    }

    await ctx.db.patch(args.timerId, { status: "completed" });
    return { completed: true };
  },
});

export const cancel = mutation({
  args: { timerId: v.id("timers") },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, args) => {
    const timer = await ctx.db.get(args.timerId);
    if (!timer || (timer.status !== "running" && timer.status !== "paused")) {
      return { cancelled: false };
    }
    await ctx.db.patch(args.timerId, { status: "cancelled" });
    return { cancelled: true };
  },
});
