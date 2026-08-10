# Mise

Mise is a voice-ready mobile sous-chef. It guides you through a recipe hands-free, keeps cooking timers visible, scales ingredients as servings change, gives quick rescue advice, and remembers the preferences you tell it.

## What is built

- A two-tab mobile experience: **Kitchen** for a hands-free Chef Mise conversation and **Recipes** for every saved dish.
- Four starter recipes: chicken curry, sushi, an egg skillet, and vegetarian pasta, plus recipes Chef Mise captures while you cook.
- A live ElevenLabs text-testing mode: talk continuously to Chef Mise and read the visualized reply before the voice demo.
- Voice-ready ElevenLabs Conversational AI sessions through native WebRTC; the voice path remains intact behind one mode flag.
- Short-lived ElevenLabs WebRTC tokens minted server-side by Convex; the API key never reaches the phone.
- Conversational voice commands for steps, timer starts/stops, portions, substitutions, rescues, ingredient questions, and saved cooking preferences.
- Convex schema and realtime functions for recipes, cooking sessions, timers, and the cooking-event log.
- XTrace memory actions that keep the API key server-side and save user preferences for future cooks.
- Local device notifications for cooking timers, with a live in-app countdown fallback.

## Run it locally

1. Keep the local Convex backend running:

   ```sh
   CONVEX_AGENT_MODE=anonymous npx convex dev
   ```

2. Build for iOS (the ElevenLabs native integration requires a development build, not Expo Go):

   ```sh
   npx expo run:ios
   ```

3. For later launches:

   ```sh
   npx expo start --dev-client
   ```

The app seeds its demo recipe automatically. The XTrace key belongs only in the Convex deployment environment as `XTRACE_API_KEY`; it is never added to `.env.local` or shipped to the phone.

For the ElevenLabs dashboard setup, required client tools, and server-only credential names, follow [ELEVENLABS_AGENT_SETUP.md](./ELEVENLABS_AGENT_SETUP.md).

## Text testing now, voice demo later

Mise currently starts silent text sessions by default. Press **Start cook** and speak naturally: the phone keeps listening, transcribes your phrases, and visualizes Chef Mise’s replies in conversational bubbles. No agent audio is played yet.

This is the right place to tune Mise's system prompt, client-tool descriptions, and XTrace memory behavior. These conversations do not automatically train ElevenLabs' base model.

Use [CHEF_MISE_TEST_SCRIPT.md](./CHEF_MISE_TEST_SCRIPT.md) for a high-value set of natural conversation, timer, food-safety, substitution, and custom-recipe checks.

When it is time for the demo, change `TEXT_TEST_MODE` to `false` near the top of [App.tsx](./App.tsx), rebuild the development app if needed, and the existing ElevenLabs voice session resumes. No new agent or credential setup is required.

## Current MVP boundary

Mise has no sign-in yet, so its demo identity is intentionally local to the hackathon prototype. Before sharing it with testers, connect an authenticated Convex cloud deployment and replace the demo owner ID with the signed-in user identity. The existing recipe/session/timer model is ready for that change.

The ElevenLabs token action is deliberately usable only against the local hackathon backend at this stage. Add Convex Auth before exposing a cloud deployment, otherwise an unauthenticated caller could spend agent minutes by requesting conversation tokens.
