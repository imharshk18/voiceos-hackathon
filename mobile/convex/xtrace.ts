"use node";

import { MemoryClient } from "@xtraceai/memory";
import { v } from "convex/values";
import { action } from "./_generated/server";

declare const process: { env: { XTRACE_API_KEY?: string } };

function clientFromEnvironment() {
  const apiKey = process.env.XTRACE_API_KEY;
  return apiKey ? new MemoryClient({ apiKey }) : null;
}

export const remember = action({
  args: {
    ownerId: v.string(),
    conversationId: v.string(),
    content: v.string(),
  },
  returns: v.object({ accepted: v.boolean(), message: v.string() }),
  handler: async (_ctx, args) => {
    const client = clientFromEnvironment();
    if (!client) {
      return { accepted: false, message: "Memory is not configured yet." };
    }

    try {
      const job = await client.memories.ingest({
        messages: [{ role: "user", content: args.content }],
        user_id: args.ownerId,
        conv_id: args.conversationId,
        app_id: "mise",
      });
      return {
        accepted: true,
        message:
          job.status === "succeeded"
            ? "Mise remembered that for future cooks."
            : "Mise is saving that for future cooks.",
      };
    } catch {
      return { accepted: false, message: "Memory is temporarily unavailable." };
    }
  },
});

export const recallPreferences = action({
  args: { ownerId: v.string(), query: v.string() },
  returns: v.object({ available: v.boolean(), context: v.string() }),
  handler: async (_ctx, args) => {
    const client = clientFromEnvironment();
    if (!client) {
      return { available: false, context: "" };
    }

    try {
      const result = await client.memories.recall({
        query: args.query,
        pools: [{ user_id: args.ownerId }],
        limit: 5,
      });
      return { available: true, context: result.prompt };
    } catch {
      return { available: false, context: "" };
    }
  },
});

export const healthCheck = action({
  args: {},
  returns: v.object({ available: v.boolean() }),
  handler: async () => {
    const client = clientFromEnvironment();
    if (!client) {
      return { available: false };
    }

    try {
      await client.memories.search({
        query: "mise",
        user_id: "mise-health-check",
        limit: 1,
      });
      return { available: true };
    } catch {
      return { available: false };
    }
  },
});
