#!/usr/bin/env node

/**
 * Hackathon-only bridge for Mise Countertop.
 *
 * The VoiceOS glance card is static once an Agent Mode tool call has finished.
 * This helper watches the shared Convex cook and uses macOS Accessibility to
 * submit one small VoiceOS Agent Mode refresh prompt after a real state change.
 * It deliberately does not call ElevenLabs or interact with the phone app.
 *
 * Start it from this folder:
 *   node mise-countertop-autorefresh.mjs
 *
 * First dry run (no VoiceOS UI automation):
 *   MISE_DRY_RUN=1 node mise-countertop-autorefresh.mjs
 *
 * Stop it with Ctrl-C.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE_URL = process.env.MISE_CONVEX_URL ?? "https://wooden-swordfish-255.convex.cloud";
const SESSION_PATH = process.env.MISE_SESSION_PATH ?? "countertop:getActiveCookingSession";
const POLL_MS = positiveInt(process.env.MISE_POLL_MS, 1_500);
// Phone speech and agent events often arrive in a short burst. Wait until the
// burst is quiet, then render only the final shared state rather than queuing
// a separate VoiceOS turn for each intermediate write.
const DEBOUNCE_MS = positiveInt(process.env.MISE_DEBOUNCE_MS, 4_000);
const COOLDOWN_MS = positiveInt(process.env.MISE_COOLDOWN_MS, 15_000);
const FAILURE_BACKOFF_MS = positiveInt(process.env.MISE_FAILURE_BACKOFF_MS, 30_000);
const APP_NAME = process.env.MISE_VOICEOS_APP ?? "VoiceOS";
const DRY_RUN = process.env.MISE_DRY_RUN === "1";
const ONCE = process.argv.includes("--once");
const WATCHER_VERSION = "1.1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APPLESCRIPT = join(SCRIPT_DIR, "mise-countertop-submit.applescript");

// The VoiceOS integration explicitly routes this sentinel to Step guidance.
// A single unobtrusive symbol is much less distracting than an exposed system
// instruction in the Agent Mode transcript.
const REFRESH_PROMPT = "↻";

let lastFingerprint = null;
let pendingFingerprint = null;
let pendingTimer = null;
let lastSubmitAt = 0;
let blockedUntil = 0;
let inFlight = false;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unwrap(body) {
  return body && Object.prototype.hasOwnProperty.call(body, "value") ? body.value : body;
}

/**
 * The session response includes a ticking remaining-seconds field. Excluding it
 * is key: it lets the glance card's own JavaScript count down, while this helper
 * wakes VoiceOS only for actual mutations such as a timer being created or ended.
 */
function stableSnapshot(value) {
  const ignored = new Set([
    "remainingSeconds",
    "secondsRemaining",
    "remaining",
    "now",
    "serverNow",
    "queriedAt",
    "_creationTime",
  ]);

  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key]) => !ignored.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, scrub(entry)]),
    );
  };

  return JSON.stringify(scrub(value));
}

function fingerprint(value) {
  return createHash("sha256").update(stableSnapshot(value)).digest("hex");
}

async function readSession() {
  const response = await fetch(`${BASE_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: SESSION_PATH, args: {}, format: "json" }),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Convex returned invalid JSON (${response.status}).`);
  }
  if (!response.ok || body?.status === "error" || body?.error || body?.errorMessage) {
    throw new Error(String(body?.errorMessage ?? body?.error ?? `Convex request failed (${response.status})`));
  }
  return unwrap(body);
}

function labelFrom(session) {
  const active = session?.session ?? session?.activeSession ?? session;
  if (!active) return "cook ended";
  const title = active.recipeTitle ?? active.recipe?.title ?? active.title ?? "current cook";
  const step = active.stepNumber ?? active.currentStep?.stepNumber ?? active.currentStepIndex + 1;
  const status = active.status ?? (active.paused ? "paused" : "active");
  return `${title} · step ${step ?? "?"} · ${status}`;
}

function requestRefresh(nextFingerprint, label) {
  pendingFingerprint = nextFingerprint;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => void flushRefresh(label), DEBOUNCE_MS);
}

async function flushRefresh(label) {
  const currentFingerprint = pendingFingerprint;
  pendingFingerprint = null;
  if (!currentFingerprint || inFlight) return;

  if (Date.now() < blockedUntil) return;

  const waitForCooldown = Math.max(0, COOLDOWN_MS - (Date.now() - lastSubmitAt));
  if (waitForCooldown > 0) {
    pendingFingerprint = currentFingerprint;
    pendingTimer = setTimeout(() => void flushRefresh(label), waitForCooldown);
    return;
  }

  if (DRY_RUN) {
    lastSubmitAt = Date.now();
    console.log(`[dry run] Would refresh VoiceOS: ${label}`);
    return;
  }

  inFlight = true;
  try {
    await submitToVoiceOS();
    lastSubmitAt = Date.now();
    blockedUntil = 0;
    console.log(`↻ Countertop refreshed: ${label}`);
  } catch (error) {
    // Accessibility permission is a user-controlled macOS setting. Avoid
    // hammering the terminal while it is unresolved; the next real change
    // after the short backoff will try again automatically.
    blockedUntil = Date.now() + FAILURE_BACKOFF_MS;
    console.error(`VoiceOS refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`Keep VoiceOS open in Agent Mode and grant this terminal Accessibility access in System Settings → Privacy & Security → Accessibility. Retrying after ${Math.round(FAILURE_BACKOFF_MS / 1000)} seconds on a new change.`);
  } finally {
    inFlight = false;
  }
}

function submitToVoiceOS() {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", [APPLESCRIPT, APP_NAME, REFRESH_PROMPT], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
    });
  });
}

async function poll() {
  try {
    const session = await readSession();
    const nextFingerprint = fingerprint(session);
    const label = labelFrom(session);

    // Seed the baseline. The card that created the session is already current;
    // only later phone/Convex changes should cause an automatic refresh.
    if (lastFingerprint === null) {
      lastFingerprint = nextFingerprint;
      console.log(`Watching Mise Countertop (${label}).`);
      return;
    }

    if (nextFingerprint !== lastFingerprint) {
      lastFingerprint = nextFingerprint;
      requestRefresh(nextFingerprint, label);
    }
  } catch (error) {
    console.error(`Convex watch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`Mise Countertop auto-refresh v${WATCHER_VERSION} is ${DRY_RUN ? "in dry-run mode" : "watching"}.`);
console.log(`Polling ${BASE_URL} every ${POLL_MS}ms; coalescing updates for ${DEBOUNCE_MS / 1000}s; signal: ${REFRESH_PROMPT}. Press Ctrl-C to stop.`);
await poll();
if (!ONCE) setInterval(() => void poll(), POLL_MS);
