# Mise Hackathon

Mise is a hands-free cooking companion: talk to Chef Mise on iPhone while the VoiceOS Countertop acts as a shared visual display for the current step, timers, ingredient cues, and what-good-looks-like guidance.

## Project layout

- `mobile/` — Expo / React Native iPhone application, Convex backend, ElevenLabs conversational chef.
- `voiceos-countertop/` — VoiceOS Countertop refresh helper and setup notes for the shared cooking display.

## Quick start

### Mobile app

1. Open `mobile/`.
2. Create `mobile/.env.local` from your own Convex deployment configuration. Never commit it.
3. Install dependencies with `npm install`.
4. Start Convex and Expo using the project’s local development instructions in `mobile/README.md`.

### VoiceOS Countertop

1. Install or open the Mise Countertop custom app in VoiceOS.
2. Follow `voiceos-countertop/README-mise-countertop-autorefresh.md` to connect it to the same Convex deployment as the phone app.
3. The Countertop reads the shared cooking session; it does not store a separate recipe state.

## Security note

This is a hackathon prototype. Keep all API keys and Convex deployment credentials in local environment files or deployment secrets—not in GitHub.
