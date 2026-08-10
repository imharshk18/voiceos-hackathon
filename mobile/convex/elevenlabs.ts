"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";

declare const process: {
  env: {
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_AGENT_ID?: string;
  };
};

type ElevenLabsTokenResponse = {
  token?: unknown;
  conversation_id?: unknown;
};

type ElevenLabsSignedUrlResponse = {
  signed_url?: unknown;
};

export const createConversationToken = action({
  args: { userId: v.string() },
  returns: v.object({
    configured: v.boolean(),
    token: v.union(v.string(), v.null()),
    conversationId: v.union(v.string(), v.null()),
    message: v.string(),
  }),
  handler: async (_ctx, args) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey || !agentId) {
      return {
        configured: false,
        token: null,
        conversationId: null,
        message: "ElevenLabs is not configured yet.",
      };
    }

    try {
      const query = new URLSearchParams({
        agent_id: agentId,
        participant_name: args.userId,
      });
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?${query.toString()}`,
        { headers: { "xi-api-key": apiKey } },
      );

      if (!response.ok) {
        return {
          configured: true,
          token: null,
          conversationId: null,
          message: "Mise could not start its voice connection.",
        };
      }

      const body = (await response.json()) as ElevenLabsTokenResponse;
      if (typeof body.token !== "string" || typeof body.conversation_id !== "string") {
        return {
          configured: true,
          token: null,
          conversationId: null,
          message: "Mise received an invalid voice-session token.",
        };
      }

      return {
        configured: true,
        token: body.token,
        conversationId: body.conversation_id,
        message: "Voice connection ready.",
      };
    } catch {
      return {
        configured: true,
        token: null,
        conversationId: null,
        message: "Mise could not reach its voice service.",
      };
    }
  },
});

/**
 * Creates a short-lived URL for ElevenLabs Chat Mode. The mobile app opens
 * this URL with React Native's native WebSocket, which avoids routing a
 * text-only conversation through LiveKit/WebRTC.
 */
export const createTextConversationUrl = action({
  args: { userId: v.string() },
  returns: v.object({
    configured: v.boolean(),
    signedUrl: v.union(v.string(), v.null()),
    message: v.string(),
  }),
  handler: async (_ctx, _args) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey || !agentId) {
      return {
        configured: false,
        signedUrl: null,
        message: "ElevenLabs is not configured yet.",
      };
    }

    try {
      const query = new URLSearchParams({ agent_id: agentId });
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?${query.toString()}`,
        { headers: { "xi-api-key": apiKey } },
      );

      if (!response.ok) {
        return {
          configured: true,
          signedUrl: null,
          message: "Mise could not open its private text chat.",
        };
      }

      const body = (await response.json()) as ElevenLabsSignedUrlResponse;
      if (typeof body.signed_url !== "string") {
        return {
          configured: true,
          signedUrl: null,
          message: "Mise received an invalid text-chat link.",
        };
      }

      return {
        configured: true,
        signedUrl: body.signed_url,
        message: "Text chat ready.",
      };
    } catch {
      return {
        configured: true,
        signedUrl: null,
        message: "Mise could not reach its text-chat service.",
      };
    }
  },
});
