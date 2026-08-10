# Mise Countertop auto-refresh — hackathon bridge

VoiceOS result cards are static after a tool call. This tiny local watcher gives
the demo a live feel by:

1. polling the same public Convex session used by the phone and Countertop;
2. ignoring the timer's ordinary per-second countdown;
3. waiting for a short quiet window after a burst of cook updates, then using
   macOS Accessibility to send a tiny `↻` refresh signal to VoiceOS; and
4. letting VoiceOS call its existing `Step guidance` tool and redraw the card.

It does **not** call ElevenLabs, change your phone, create recipes, or mutate
Convex. It only asks VoiceOS to re-read state that has already changed.

## Run it

Keep VoiceOS open on the Agent Mode chat that has Mise Countertop available,
then run this in Terminal:

```sh
cd "/Users/kadodwala/Documents/voiceos hackathon"
node mise-countertop-autorefresh.mjs
```

The first time, macOS will block the UI automation. Enable the terminal you ran
the command from in:

**System Settings → Privacy & Security → Accessibility**

If the error says `osascript is not allowed assistive access`, turn on the app
that launched the command (usually **Terminal**, **iTerm**, or **Warp**) there.
If it is already on, turn it off and on again, then stop and restart the
watcher. The console should say
`Countertop refreshed` after a phone/Convex update.

## Test safely first

This reads Convex but never controls VoiceOS:

```sh
MISE_DRY_RUN=1 node mise-countertop-autorefresh.mjs
```

Start or change a cook, then look for:

```text
[dry run] Would refresh VoiceOS: Weeknight Chicken Curry · step 2 · active
```

## Expected behavior and limits

- Changes are coalesced for 4 seconds and rate-limited to one refresh every
  15 seconds, so a phone action and its accompanying chef message become one
  current-state update instead of a backlog of VoiceOS turns.
- The existing Countertop card's timer still counts down locally each second.
  This watcher redraws only when the timer is started, paused, cancelled,
  completed, or otherwise changed in Convex.
- VoiceOS must be running and its Agent Mode composer must be visible. The
  helper briefly brings it to the front to type the refresh message.
- On current VoiceOS builds the composer may not be exposed as a standard
  accessibility text field. The helper falls back to the bottom-center of the
  active VoiceOS window, where the fixed composer sits. Keep the VoiceOS window
  in its normal shape; do not leave a dialog, settings sheet, or search overlay
  open while the watcher is running.
- This is intentionally demo-only. A standalone Countertop app with a direct
  Convex subscription is the production-quality replacement.

## Optional tuning

```sh
# Slower polling and a longer coalescing window.
MISE_POLL_MS=2500 MISE_DEBOUNCE_MS=1800 node mise-countertop-autorefresh.mjs

# If macOS exposes the app under a different process name.
MISE_VOICEOS_APP="VoiceOS" node mise-countertop-autorefresh.mjs
```
