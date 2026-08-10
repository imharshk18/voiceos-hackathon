import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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

export default defineSchema({
  recipes: defineTable({
    ownerId: v.string(),
    title: v.string(),
    emoji: v.string(),
    description: v.string(),
    cuisine: v.string(),
    baseServings: v.number(),
    prepMinutes: v.number(),
    cookMinutes: v.number(),
    ingredients: v.array(ingredient),
    steps: v.array(recipeStep),
    notes: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner_id", ["ownerId"]),

  cookingSessions: defineTable({
    ownerId: v.string(),
    recipeId: v.id("recipes"),
    servings: v.number(),
    currentStep: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("complete"),
    ),
    startedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_id", ["ownerId"])
    .index("by_owner_id_and_status", ["ownerId", "status"]),

  timers: defineTable({
    sessionId: v.id("cookingSessions"),
    label: v.string(),
    durationSeconds: v.number(),
    endsAt: v.number(),
    status: v.union(
      v.literal("running"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    // Captured when a cook is paused so the timer resumes from the exact
    // remainder instead of continuing to count down in the background.
    remainingSeconds: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_session_id_and_status", ["sessionId", "status"]),

  cookingEvents: defineTable({
    sessionId: v.optional(v.id("cookingSessions")),
    ownerId: v.string(),
    kind: v.union(
      v.literal("voice"),
      v.literal("agent"),
      v.literal("step"),
      v.literal("timer"),
      v.literal("rescue"),
      v.literal("memory"),
    ),
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner_id", ["ownerId"])
    .index("by_session_id", ["sessionId"])
    .index("by_owner_id_and_kind", ["ownerId", "kind"])
    .index("by_session_id_and_kind", ["sessionId", "kind"]),
});
