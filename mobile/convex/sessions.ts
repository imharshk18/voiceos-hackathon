import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const sessionStatus = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("complete"),
);

const cookingEventKind = v.union(
  v.literal("voice"),
  v.literal("agent"),
  v.literal("step"),
  v.literal("timer"),
  v.literal("rescue"),
  v.literal("memory"),
);

const sessionResult = v.object({
  _id: v.id("cookingSessions"),
  _creationTime: v.number(),
  ownerId: v.string(),
  recipeId: v.id("recipes"),
  servings: v.number(),
  currentStep: v.number(),
  status: sessionStatus,
  startedAt: v.number(),
  updatedAt: v.number(),
});

const cookingEventResult = v.object({
  _id: v.id("cookingEvents"),
  _creationTime: v.number(),
  sessionId: v.optional(v.id("cookingSessions")),
  ownerId: v.string(),
  kind: cookingEventKind,
  text: v.string(),
  createdAt: v.number(),
});

function cleanEventText(text: string, label: string) {
  const clean = text.trim().replace(/\s+/g, " ").slice(0, 4_000);
  if (!clean) {
    throw new Error(`${label} cannot be empty.`);
  }
  return clean;
}

export const getActive = query({
  args: { ownerId: v.string() },
  returns: v.union(sessionResult, v.null()),
  handler: async (ctx, args) =>
    await ctx.db
      .query("cookingSessions")
      .withIndex("by_owner_id_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "active"),
      )
      .order("desc")
      .first(),
});

export const getCurrent = query({
  args: { ownerId: v.string() },
  returns: v.union(sessionResult, v.null()),
  handler: async (ctx, args) => {
    const active = await ctx.db
      .query("cookingSessions")
      .withIndex("by_owner_id_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "active"),
      )
      .order("desc")
      .first();
    if (active) return active;

    return await ctx.db
      .query("cookingSessions")
      .withIndex("by_owner_id_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "paused"),
      )
      .order("desc")
      .first();
  },
});

export const start = mutation({
  args: {
    ownerId: v.string(),
    recipeId: v.id("recipes"),
    servings: v.number(),
  },
  returns: v.object({ sessionId: v.id("cookingSessions") }),
  handler: async (ctx, args) => {
    const recipe = await ctx.db.get(args.recipeId);
    if (!recipe || recipe.ownerId !== args.ownerId) {
      throw new Error("Recipe not found.");
    }

    const activeSessions = await ctx.db
      .query("cookingSessions")
      .withIndex("by_owner_id_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "active"),
      )
      .take(10);
    const pausedSessions = await ctx.db
      .query("cookingSessions")
      .withIndex("by_owner_id_and_status", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "paused"),
      )
      .take(10);
    const now = Date.now();
    await Promise.all(
      [...activeSessions, ...pausedSessions].map((session) =>
        ctx.db.patch(session._id, { status: "complete", updatedAt: now }),
      ),
    );

    const sessionId = await ctx.db.insert("cookingSessions", {
      ownerId: args.ownerId,
      recipeId: args.recipeId,
      servings: Math.max(1, Math.round(args.servings)),
      currentStep: 0,
      status: "active",
      startedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("cookingEvents", {
      sessionId,
      ownerId: args.ownerId,
      kind: "step",
      text: `Started ${recipe.title}.`,
      createdAt: now,
    });

    return { sessionId };
  },
});

export const pause = mutation({
  args: { sessionId: v.id("cookingSessions") },
  returns: v.object({ paused: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "active") {
      return { paused: false };
    }

    const now = Date.now();
    await ctx.db.patch(args.sessionId, { status: "paused", updatedAt: now });
    const runningTimers = await ctx.db
      .query("timers")
      .withIndex("by_session_id_and_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "running"),
      )
      .take(20);
    await Promise.all(
      runningTimers.map((timer) =>
        ctx.db.patch(timer._id, {
          status: "paused",
          remainingSeconds: Math.max(0, Math.ceil((timer.endsAt - now) / 1000)),
        }),
      ),
    );
    await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "step",
      text: "Paused the cooking session.",
      createdAt: now,
    });
    return { paused: true };
  },
});

export const resume = mutation({
  args: { sessionId: v.id("cookingSessions") },
  returns: v.object({ resumed: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "paused") {
      return { resumed: false };
    }

    const now = Date.now();
    await ctx.db.patch(args.sessionId, { status: "active", updatedAt: now });
    const pausedTimers = await ctx.db
      .query("timers")
      .withIndex("by_session_id_and_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "paused"),
      )
      .take(20);
    await Promise.all(
      pausedTimers.map((timer) => {
        const remainingSeconds = Math.max(0, timer.remainingSeconds ?? 0);
        return ctx.db.patch(timer._id, {
          status: "running",
          endsAt: now + remainingSeconds * 1000,
          remainingSeconds: 0,
        });
      }),
    );
    await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "step",
      text: "Resumed the cooking session.",
      createdAt: now,
    });
    return { resumed: true };
  },
});

export const advance = mutation({
  args: { sessionId: v.id("cookingSessions") },
  returns: v.object({ currentStep: v.number(), status: sessionStatus }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Cooking session not found.");
    }
    if (session.status !== "active") {
      throw new Error("That cooking session is no longer active.");
    }

    const recipe = await ctx.db.get(session.recipeId);
    if (!recipe) {
      throw new Error("Recipe not found.");
    }

    const nextStep = session.currentStep + 1;
    const status: "active" | "complete" =
      nextStep >= recipe.steps.length ? "complete" : "active";
    const now = Date.now();
    await ctx.db.patch(args.sessionId, {
      currentStep: nextStep,
      status,
      updatedAt: now,
    });
    await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "step",
      text: status === "complete" ? "Finished the recipe." : `Moved to step ${nextStep + 1}.`,
      createdAt: now,
    });

    return { currentStep: nextStep, status };
  },
});

export const setServings = mutation({
  args: { sessionId: v.id("cookingSessions"), servings: v.number() },
  returns: v.object({ servings: v.number() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Cooking session not found.");
    }

    const servings = Math.max(1, Math.min(12, Math.round(args.servings)));
    await ctx.db.patch(args.sessionId, { servings, updatedAt: Date.now() });
    return { servings };
  },
});

export const stop = mutation({
  args: {
    sessionId: v.id("cookingSessions"),
    summary: v.optional(v.string()),
  },
  returns: v.object({
    stopped: v.boolean(),
    timersStopped: v.number(),
    summaryEventId: v.union(v.id("cookingEvents"), v.null()),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || (session.status !== "active" && session.status !== "paused")) {
      return { stopped: false, timersStopped: 0, summaryEventId: null };
    }

    const runningTimers = await ctx.db
      .query("timers")
      .withIndex("by_session_id_and_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "running"),
      )
      .take(20);
    const now = Date.now();
    await ctx.db.patch(args.sessionId, { status: "complete", updatedAt: now });
    await Promise.all(
      runningTimers.map((timer) => ctx.db.patch(timer._id, { status: "cancelled" })),
    );
    await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "step",
      text: "Stopped the cooking session.",
      createdAt: now,
    });
    const summary = args.summary
      ? cleanEventText(args.summary, "Cook summary")
      : null;
    const summaryEventId = summary
      ? await ctx.db.insert("cookingEvents", {
          sessionId: args.sessionId,
          ownerId: session.ownerId,
          kind: "memory",
          text: summary,
          createdAt: now,
        })
      : null;
    return { stopped: true, timersStopped: runningTimers.length, summaryEventId };
  },
});

export const recordEvent = mutation({
  args: {
    ownerId: v.string(),
    sessionId: v.optional(v.id("cookingSessions")),
    kind: cookingEventKind,
    text: v.string(),
  },
  returns: v.object({ eventId: v.id("cookingEvents") }),
  handler: async (ctx, args) => {
    const text = cleanEventText(args.text, "Cooking event");
    const eventId = await ctx.db.insert("cookingEvents", {
      ownerId: args.ownerId,
      sessionId: args.sessionId,
      kind: args.kind,
      text,
      createdAt: Date.now(),
    });
    return { eventId };
  },
});

export const listRecent = query({
  args: {
    ownerId: v.string(),
    sessionId: v.optional(v.id("cookingSessions")),
    limit: v.optional(v.number()),
  },
  returns: v.array(cookingEventResult),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(100, Math.round(args.limit ?? 50)));
    if (args.sessionId) {
      return await ctx.db
        .query("cookingEvents")
        .withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("cookingEvents")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(limit);
  },
});

export const recordSummary = mutation({
  args: {
    sessionId: v.id("cookingSessions"),
    summary: v.string(),
  },
  returns: v.object({
    summaryEventId: v.id("cookingEvents"),
    summary: v.string(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Cooking session not found.");
    }

    const summary = cleanEventText(args.summary, "Cook summary");
    const now = Date.now();
    const summaryEventId = await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "memory",
      text: summary,
      createdAt: now,
    });
    await ctx.db.patch(args.sessionId, { updatedAt: now });
    return { summaryEventId, summary };
  },
});

export const completeWithSummary = mutation({
  args: {
    sessionId: v.id("cookingSessions"),
    summary: v.string(),
  },
  returns: v.object({
    completed: v.boolean(),
    timersStopped: v.number(),
    summaryEventId: v.id("cookingEvents"),
    summary: v.string(),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error("Cooking session not found.");
    }

    const summary = cleanEventText(args.summary, "Cook summary");
    const now = Date.now();
    const wasOpen = session.status === "active" || session.status === "paused";
    const runningTimers = wasOpen
      ? await ctx.db
          .query("timers")
          .withIndex("by_session_id_and_status", (q) =>
            q.eq("sessionId", args.sessionId).eq("status", "running"),
          )
          .take(20)
      : [];

    if (wasOpen) {
      await ctx.db.patch(args.sessionId, { status: "complete", updatedAt: now });
      await Promise.all(
        runningTimers.map((timer) =>
          ctx.db.patch(timer._id, { status: "cancelled" }),
        ),
      );
      await ctx.db.insert("cookingEvents", {
        sessionId: args.sessionId,
        ownerId: session.ownerId,
        kind: "step",
        text: "Stopped the cooking session.",
        createdAt: now,
      });
    } else {
      await ctx.db.patch(args.sessionId, { updatedAt: now });
    }

    const summaryEventId = await ctx.db.insert("cookingEvents", {
      sessionId: args.sessionId,
      ownerId: session.ownerId,
      kind: "memory",
      text: summary,
      createdAt: now,
    });

    return {
      completed: wasOpen,
      timersStopped: runningTimers.length,
      summaryEventId,
      summary,
    };
  },
});
