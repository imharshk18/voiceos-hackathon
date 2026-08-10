import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

// A deliberately shared, unauthenticated kitchen for the private hackathon demo.
// Replace this with authenticated ownership before distributing the app publicly.
const DEMO_OWNER_ID = "mise-demo-kitchen";

const sessionStatus = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("complete"),
);

const ingredient = v.object({
  name: v.string(),
  quantity: v.number(),
  unit: v.string(),
});

const recipeStep = v.object({
  title: v.string(),
  instruction: v.string(),
  minutes: v.number(),
  heat: v.string(),
  tip: v.string(),
});

type RecipeStep = {
  title: string;
  instruction: string;
  minutes: number;
  heat: string;
  tip: string;
};

const timer = v.object({
  timerId: v.id("timers"),
  label: v.string(),
  durationSeconds: v.number(),
  endsAt: v.number(),
  remainingSeconds: v.number(),
  paused: v.boolean(),
});

const countertopSession = v.object({
  sessionId: v.id("cookingSessions"),
  recipeTitle: v.string(),
  recipeEmoji: v.string(),
  servings: v.number(),
  status: sessionStatus,
  currentStepIndex: v.number(),
  ingredients: v.array(ingredient),
  steps: v.array(recipeStep),
  activeTimers: v.array(timer),
  visualReference: v.null(),
  visualCue: v.string(),
  latestChefMessage: v.string(),
  updatedAt: v.number(),
});

async function getOpenSession(ctx: QueryCtx | MutationCtx) {
  const active = await ctx.db
    .query("cookingSessions")
    .withIndex("by_owner_id_and_status", (q) =>
      q.eq("ownerId", DEMO_OWNER_ID).eq("status", "active"),
    )
    .order("desc")
    .first();
  if (active) return active;

  return await ctx.db
    .query("cookingSessions")
    .withIndex("by_owner_id_and_status", (q) =>
      q.eq("ownerId", DEMO_OWNER_ID).eq("status", "paused"),
    )
    .order("desc")
    .first();
}

/**
 * VoiceOS sometimes hands us a sensible recipe outline but packs several
 * physical actions into one instruction. Store those as small cookable steps
 * so both the phone and Countertop can guide one move, then wait for the cook.
 */
function atomicRecipeSteps(steps: RecipeStep[]): RecipeStep[] {
  const actionWord = "add|heat|sear|saute|sauté|pour|stir|cover|cook|bring|reduce|whisk|toss|remove|slice|season|place|return|transfer|crack|scatter|turn|serve|drain|mix|fold|spread";
  const boundary = new RegExp(`,\\s*(?:then\\s+)?(?=${actionWord}\\b)|\\s+(?:then|and then|and)\\s+(?=${actionWord}\\b)`, "gi");

  return steps.flatMap((step) => {
    const sentences = step.instruction
      .replace(/\s+/g, " ")
      .replace(boundary, ". ")
      .split(/[.!?]+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .slice(0, 4);

    if (sentences.length <= 1) return [step];
    const minutesPerAction = Math.max(1, Math.round(Math.max(1, step.minutes) / sentences.length));
    return sentences.map((instruction, index) => ({
      title: index === 0 ? step.title : `Continue: ${step.title}`,
      instruction: `${instruction}.`,
      minutes: minutesPerAction,
      heat: step.heat,
      tip: index === sentences.length - 1 ? step.tip : "Do this one move, then tell Chef Mise when you are ready.",
    }));
  }).slice(0, 20);
}

function currentAtomicIndex(steps: RecipeStep[], currentStep: number): number {
  return atomicRecipeSteps(steps.slice(0, Math.max(0, currentStep))).length;
}

export const getActiveCookingSession = query({
  args: {},
  returns: v.union(countertopSession, v.null()),
  handler: async (ctx) => {
    const session = await getOpenSession(ctx);
    if (!session) return null;
    const recipe = await ctx.db.get(session.recipeId);
    if (!recipe) return null;

    const [runningTimers, pausedTimers, latestChefMessage] = await Promise.all([
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
        )
        .order("asc")
        .take(10),
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "paused"),
        )
        .order("asc")
        .take(10),
      ctx.db
        .query("cookingEvents")
        .withIndex("by_session_id_and_kind", (q) =>
          q.eq("sessionId", session._id).eq("kind", "agent"),
        )
        .order("desc")
        .first(),
    ]);
    const currentStep = recipe.steps[session.currentStep];

    return {
      sessionId: session._id,
      recipeTitle: recipe.title,
      recipeEmoji: recipe.emoji,
      servings: session.servings,
      status: session.status,
      currentStepIndex: session.currentStep,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      activeTimers: [...runningTimers, ...pausedTimers].map((entry) => ({
        timerId: entry._id,
        label: entry.label,
        durationSeconds: entry.durationSeconds,
        endsAt: entry.endsAt,
        remainingSeconds: entry.status === "paused"
          ? Math.max(0, entry.remainingSeconds ?? 0)
          : Math.max(0, Math.ceil((entry.endsAt - Date.now()) / 1000)),
        paused: entry.status === "paused",
      })),
      visualReference: null,
      visualCue: currentStep?.tip ?? "",
      latestChefMessage: latestChefMessage?.text ?? "",
      updatedAt: session.updatedAt,
    };
  },
});

export const startCook = mutation({
  args: { recipeTitle: v.string(), servings: v.number() },
  returns: v.object({
    sessionId: v.id("cookingSessions"),
    recipeTitle: v.string(),
    servings: v.number(),
    currentStepIndex: v.number(),
    status: v.literal("active"),
  }),
  handler: async (ctx, args) => {
    const title = args.recipeTitle.trim();
    if (!title) throw new Error("Choose a saved recipe before starting.");
    const recipes = await ctx.db
      .query("recipes")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", DEMO_OWNER_ID))
      .take(50);
    const normalizedTitle = title.toLocaleLowerCase();
    const recipe =
      recipes.find(
        (candidate) => candidate.title.trim().toLocaleLowerCase() === normalizedTitle,
      ) ??
      recipes.find((candidate) =>
        candidate.title.trim().toLocaleLowerCase().includes(normalizedTitle),
      );
    if (!recipe) throw new Error(`Saved recipe \"${title}\" was not found.`);

    const [activeSessions, pausedSessions] = await Promise.all([
      ctx.db
        .query("cookingSessions")
        .withIndex("by_owner_id_and_status", (q) =>
          q.eq("ownerId", DEMO_OWNER_ID).eq("status", "active"),
        )
        .take(10),
      ctx.db
        .query("cookingSessions")
        .withIndex("by_owner_id_and_status", (q) =>
          q.eq("ownerId", DEMO_OWNER_ID).eq("status", "paused"),
        )
        .take(10),
    ]);
    const now = Date.now();
    for (const session of [...activeSessions, ...pausedSessions]) {
      const runningTimers = await ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
        )
        .take(20);
      await ctx.db.patch(session._id, { status: "complete", updatedAt: now });
      await Promise.all(runningTimers.map((entry) => ctx.db.patch(entry._id, { status: "cancelled" })));
    }

    const servings = Math.max(1, Math.min(12, Math.round(args.servings)));
    const sessionId = await ctx.db.insert("cookingSessions", {
      ownerId: DEMO_OWNER_ID,
      recipeId: recipe._id,
      servings,
      currentStep: 0,
      status: "active",
      startedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cookingEvents", {
      sessionId,
      ownerId: DEMO_OWNER_ID,
      kind: "step",
      text: `Started ${recipe.title} from Mise Countertop.`,
      createdAt: now,
    });
    return {
      sessionId,
      recipeTitle: recipe.title,
      servings,
      currentStepIndex: 0,
      status: "active" as const,
    };
  },
});

/**
 * Demo-only bridge for a dish identified in VoiceOS (for example, a dish the
 * user circles while browsing). VoiceOS sends a small, structured recipe; we
 * save it in the same shared kitchen and immediately make it the active cook.
 * This deliberately avoids accepting an owner id from the caller.
 */
export const createBrowserRecipeAndStart = mutation({
  args: {
    recipeTitle: v.string(),
    servings: v.number(),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    cuisine: v.optional(v.string()),
    prepMinutes: v.optional(v.number()),
    cookMinutes: v.optional(v.number()),
    ingredients: v.array(ingredient),
    steps: v.array(recipeStep),
    notes: v.optional(v.string()),
  },
  returns: v.object({
    sessionId: v.id("cookingSessions"),
    recipeId: v.id("recipes"),
    recipeTitle: v.string(),
    servings: v.number(),
    currentStepIndex: v.number(),
    status: v.literal("active"),
  }),
  handler: async (ctx, args) => {
    const title = args.recipeTitle.trim().slice(0, 80);
    if (!title) throw new Error("Give the discovered dish a recipe name first.");
    if (args.ingredients.length === 0 || args.steps.length === 0) {
      throw new Error("A discovered dish needs at least one ingredient and one step.");
    }

    const now = Date.now();
    const [activeSessions, pausedSessions] = await Promise.all([
      ctx.db
        .query("cookingSessions")
        .withIndex("by_owner_id_and_status", (q) =>
          q.eq("ownerId", DEMO_OWNER_ID).eq("status", "active"),
        )
        .take(10),
      ctx.db
        .query("cookingSessions")
        .withIndex("by_owner_id_and_status", (q) =>
          q.eq("ownerId", DEMO_OWNER_ID).eq("status", "paused"),
        )
        .take(10),
    ]);
    for (const session of [...activeSessions, ...pausedSessions]) {
      const runningTimers = await ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
        )
        .take(20);
      await ctx.db.patch(session._id, { status: "complete", updatedAt: now });
      await Promise.all(
        runningTimers.map((entry) => ctx.db.patch(entry._id, { status: "cancelled" })),
      );
    }

    const servings = Math.max(1, Math.min(12, Math.round(args.servings)));
    const steps = atomicRecipeSteps(args.steps).slice(0, 20);
    const recipeId = await ctx.db.insert("recipes", {
      ownerId: DEMO_OWNER_ID,
      title,
      emoji: args.emoji?.trim().slice(0, 12) || "🍽️",
      description: args.description?.trim().slice(0, 240) || "A recipe discovered with VoiceOS.",
      cuisine: args.cuisine?.trim().slice(0, 60) || "Custom",
      baseServings: servings,
      prepMinutes: Math.max(0, Math.min(240, Math.round(args.prepMinutes ?? 10))),
      cookMinutes: Math.max(0, Math.min(480, Math.round(args.cookMinutes ?? 25))),
      ingredients: args.ingredients.slice(0, 30),
      steps,
      notes: args.notes?.trim().slice(0, 600) || "Created from a VoiceOS dish selection.",
      createdAt: now,
      updatedAt: now,
    });
    const sessionId = await ctx.db.insert("cookingSessions", {
      ownerId: DEMO_OWNER_ID,
      recipeId,
      servings,
      currentStep: 0,
      status: "active",
      startedAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cookingEvents", {
      sessionId,
      ownerId: DEMO_OWNER_ID,
      kind: "step",
      text: `Created and started ${title} from a VoiceOS dish selection.`,
      createdAt: now,
    });
    return {
      sessionId,
      recipeId,
      recipeTitle: title,
      servings,
      currentStepIndex: 0,
      status: "active" as const,
    };
  },
});

/**
 * One-time-safe migration for the cook already on the shared demo kitchen.
 * It is also harmless to run again: already atomic recipes are left unchanged.
 */
export const simplifyCurrentCook = mutation({
  args: {},
  returns: v.object({
    changed: v.boolean(),
    recipeTitle: v.string(),
    stepCount: v.number(),
    currentStepIndex: v.number(),
  }),
  handler: async (ctx) => {
    const session = await getOpenSession(ctx);
    if (!session) throw new Error("There is no active or paused cook to simplify.");
    const recipe = await ctx.db.get(session.recipeId);
    if (!recipe) throw new Error("The current recipe is unavailable.");

    const steps = atomicRecipeSteps(recipe.steps);
    const changed = JSON.stringify(steps) !== JSON.stringify(recipe.steps);
    const currentStepIndex = changed
      ? Math.min(steps.length - 1, currentAtomicIndex(recipe.steps, session.currentStep))
      : session.currentStep;
    const now = Date.now();

    if (changed) {
      await ctx.db.patch(recipe._id, { steps, updatedAt: now });
      await ctx.db.patch(session._id, { currentStep: currentStepIndex, updatedAt: now });
      await ctx.db.insert("cookingEvents", {
        sessionId: session._id,
        ownerId: DEMO_OWNER_ID,
        kind: "step",
        text: "Split this recipe into one-action Chef Mise steps.",
        createdAt: now,
      });
    }

    return {
      changed,
      recipeTitle: recipe.title,
      stepCount: steps.length,
      currentStepIndex,
    };
  },
});

export const setTimer = mutation({
  args: { label: v.string(), durationSeconds: v.number() },
  returns: v.object({
    timerId: v.id("timers"),
    label: v.string(),
    durationSeconds: v.number(),
    endsAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await getOpenSession(ctx);
    if (!session || session.status !== "active") {
      throw new Error("Start or resume a cook before setting a timer.");
    }
    const durationSeconds = Math.max(10, Math.min(7200, Math.round(args.durationSeconds)));
    const label = args.label.trim().slice(0, 80) || "Kitchen timer";
    const now = Date.now();
    const endsAt = now + durationSeconds * 1000;
    const timerId = await ctx.db.insert("timers", {
      sessionId: session._id,
      label,
      durationSeconds,
      endsAt,
      status: "running",
      createdAt: now,
    });
    await ctx.db.insert("cookingEvents", {
      sessionId: session._id,
      ownerId: DEMO_OWNER_ID,
      kind: "timer",
      text: `Started ${label} for ${durationSeconds} seconds from Mise Countertop.`,
      createdAt: now,
    });
    return { timerId, label, durationSeconds, endsAt };
  },
});

export const cancelTimer = mutation({
  args: { timerLabel: v.string() },
  returns: v.object({ cancelled: v.boolean(), label: v.string() }),
  handler: async (ctx, args) => {
    const session = await getOpenSession(ctx);
    if (!session) throw new Error("There is no active or paused cook.");
    const label = args.timerLabel.trim().toLocaleLowerCase();
    if (!label) throw new Error("Say which timer to stop.");
    const [running, paused] = await Promise.all([
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
        )
        .take(20),
      ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "paused"),
        )
        .take(20),
    ]);
    const matches = [...running, ...paused].filter((timer) => {
      const candidate = timer.label.toLocaleLowerCase();
      return candidate === label || candidate.includes(label) || label.includes(candidate);
    });
    if (matches.length === 0) throw new Error(`No timer matches "${args.timerLabel}".`);
    if (matches.length > 1) throw new Error("More than one timer matches. Say the timer label.");
    const timer = matches[0];
    await ctx.db.patch(timer._id, { status: "cancelled" });
    await ctx.db.insert("cookingEvents", {
      sessionId: session._id,
      ownerId: DEMO_OWNER_ID,
      kind: "timer",
      text: `Cancelled ${timer.label} from Mise Countertop.`,
      createdAt: Date.now(),
    });
    return { cancelled: true, label: timer.label };
  },
});

export const controlCook = mutation({
  args: {
    action: v.union(
      v.literal("pause"),
      v.literal("resume"),
      v.literal("next"),
      v.literal("back"),
      v.literal("end"),
    ),
  },
  returns: v.object({
    status: sessionStatus,
    currentStepIndex: v.number(),
    recipeTitle: v.string(),
    timersStopped: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await getOpenSession(ctx);
    if (!session) throw new Error("There is no active or paused cook.");
    const recipe = await ctx.db.get(session.recipeId);
    if (!recipe) throw new Error("The current recipe is unavailable.");

    const now = Date.now();
    let status: "active" | "paused" | "complete" = session.status;
    let currentStepIndex = session.currentStep;
    let timersStopped = 0;
    if (args.action === "pause") {
      if (status !== "active") throw new Error("The cook is already paused.");
      status = "paused";
      const runningTimers = await ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
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
    } else if (args.action === "resume") {
      if (status !== "paused") throw new Error("The cook is already running.");
      status = "active";
      const pausedTimers = await ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "paused"),
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
    } else if (args.action === "next") {
      if (status !== "active") throw new Error("Resume the cook before moving to the next step.");
      currentStepIndex += 1;
      if (currentStepIndex >= recipe.steps.length) status = "complete";
    } else if (args.action === "back") {
      if (status !== "active") throw new Error("Resume the cook before going back a step.");
      currentStepIndex = Math.max(0, currentStepIndex - 1);
    } else {
      status = "complete";
      const runningTimers = await ctx.db
        .query("timers")
        .withIndex("by_session_id_and_status", (q) =>
          q.eq("sessionId", session._id).eq("status", "running"),
        )
        .take(20);
      timersStopped = runningTimers.length;
      await Promise.all(runningTimers.map((entry) => ctx.db.patch(entry._id, { status: "cancelled" })));
    }

    await ctx.db.patch(session._id, { status, currentStep: currentStepIndex, updatedAt: now });
    await ctx.db.insert("cookingEvents", {
      sessionId: session._id,
      ownerId: DEMO_OWNER_ID,
      kind: "step",
      text: `Mise Countertop: ${args.action}.`,
      createdAt: now,
    });
    return { status, currentStepIndex, recipeTitle: recipe.title, timersStopped };
  },
});
