# Chef Mise in ElevenLabs

Mise uses a private ElevenLabs Conversational AI agent. Its API key and agent ID live only in Convex server environment variables, never in the mobile app.

## Current behavior

The app is deliberately in **mic in, text out** testing mode:

- Pressing **Start cook** opens the hands-free kitchen and keeps iPhone Speech Recognition listening until the cook says to end the session or taps **Stop cook**. A short natural pause finishes one thought and immediately reopens the listener for the next.
- iPhone Speech Recognition turns each completed phrase into a text message.
- ElevenLabs receives that text and responds in the on-screen chat.
- Chef Mise does not speak aloud until `TEXT_TEST_MODE` is switched off for a later voice demo.

The agent’s first message is:

```text
Hey chef — I’m Mise. What are we in the mood to make today?
```

Its system prompt and tools are already configured around this flow:

1. The main **Kitchen** tab starts an open conversation; Chef Mise asks what the cook wants to make and starts a recipe only when they are ready.
2. A recipe’s **Start cook** button starts directly in that recipe, without asking the dish again.
3. Use brief, varied affirmations where they help the cook stay confident, and answer ordinary small-talk like a real sous-chef.
4. Guide one useful step at a time and wait for “done” or “what’s next?”
5. Start a timer when food is placed on heat / in an appliance, preserve exact durations (for example, 45 seconds), and stop the relevant timer naturally when the cook says it looks ready, is done, or has taken it off.
6. If the cook sounds unsure, explain expected colour, texture, smell, bubbling, or temperature and offer a small practical test — never pretend to see food while camera mode is off.
7. Suggest parallel prep only when it truly fits, and offer substitutions, rescue advice, and original recipe ideas when helpful.
8. Learn lasting preferences with XTrace and save a compact end-of-cook recap to Convex + XTrace.
9. Capture a new dish’s name, servings, measured ingredients, and steps before saving it to the Recipe Box.

## Client tools

Set **Wait for response** to `true` for every state-changing tool.

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `get_current_cooking_context` | none | Reads the active recipe, exact step, scaled ingredients, servings, and live timers. |
| `select_recipe` | `recipe_name` | Selects a saved dish before cooking it. |
| `start_cooking` | `recipe_name` optional | Starts the selected recipe once the cook is ready. |
| `advance_recipe_step` | none | Moves exactly one step forward after the cook says they are done. |
| `set_kitchen_timer` | `duration_seconds`, `label` optional | Starts an exact visible timer and schedules a local device alert. |
| `stop_kitchen_timer` | `label` optional | Cancels a running timer or silences a ringing one. |
| `adjust_servings` | `servings` | Scales the active recipe. |
| `stop_cooking` | none | Ends the cook and clears its active timers. |
| `save_cooking_preference` | `preference` | Saves a lasting preference or restriction to XTrace. |
| `save_new_recipe` | `title`, `servings`, `ingredients`, `steps` optional, `notes` optional | Saves a dish the cook has taught Chef Mise. Ingredient and step lists are concise semicolon-separated text. |

## Server-only credentials

If you rotate the agent or API key, set the new values on the Convex deployment — never in `EXPO_PUBLIC_*` variables or the mobile app:

```sh
npx convex env set ELEVENLABS_API_KEY "your-key"
npx convex env set ELEVENLABS_AGENT_ID "agent_your-agent-id"
```

After adding a native package or changing iOS permissions, regenerate and rebuild the development app:

```sh
npx expo prebuild --platform ios
npx expo start --dev-client --lan --clear
```

Expo Go cannot run Chef Mise’s ElevenLabs / native-speech setup. Use the installed iPhone development build instead.
