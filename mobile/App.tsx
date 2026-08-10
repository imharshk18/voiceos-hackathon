import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { ConversationProvider, useConversation } from "@elevenlabs/react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ConvexClientProvider } from "./components/ConvexClientProvider";
import { api } from "./convex/_generated/api";
import { formatTime, parseKitchenIntent, scaledQuantity } from "./lib/kitchen";

const OWNER_ID = "mise-demo-kitchen";
// Demo mode now uses ElevenLabs' full voice conversation: the cook speaks
// naturally, Chef Mise replies aloud, and the same reply remains visible in
// the on-screen conversation. Native iPhone speech recognition is used only
// in quiet text-test mode, preventing two microphone pipelines from colliding.
const TEXT_TEST_MODE = false;
const LEGACY_DEMO_TITLE = "Golden Coconut Curry";

type AppTab = "kitchen" | "recipes";

type ChatMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
};

type ManualRecipeDraft = {
  title: string;
  servings: string;
  ingredients: string;
  steps: string;
  notes: string;
};

const FAST_TURN_FINALIZE_MS = 900;
const LISTENER_RESTART_MS = 180;

function normalizeChatText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatTimerDuration(totalSeconds: number) {
  const seconds = Math.max(1, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const minuteText = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return remainder === 0
    ? minuteText
    : `${minuteText} ${remainder} second${remainder === 1 ? "" : "s"}`;
}

// Kept as an emergency transport fallback while the supported SDK chat path
// runs on-device. The regular app flow uses the SDK below.
type TextSocketEvent = {
  type?: string;
  agent_response_event?: { agent_response?: string; event_id?: number };
  agent_response_correction_event?: { corrected_agent_response?: string };
  text_response_part?: { text?: string; type?: "start" | "delta" | "stop"; event_id?: number };
  client_tool_call?: {
    tool_name?: string;
    tool_call_id?: string;
    parameters?: Record<string, unknown>;
  };
  ping_event?: { event_id?: number };
  error?: { message?: string };
};

type Recipe = NonNullable<ReturnType<typeof useQuery<typeof api.recipes.list>>>[number];
type KitchenTimer = NonNullable<ReturnType<typeof useQuery<typeof api.timers.listRunning>>>[number];
type CookingSession = NonNullable<ReturnType<typeof useQuery<typeof api.sessions.getCurrent>>>;
type CookSnapshot = {
  sessionId: CookingSession["_id"];
  recipe: Recipe;
  servings: number;
  currentStep: number;
};

type RawIngredient =
  | string
  | { name?: unknown; quantity?: unknown; unit?: unknown };
type RawStep =
  | string
  | {
      title?: unknown;
      instruction?: unknown;
      minutes?: unknown;
      heat?: unknown;
      tip?: unknown;
    };

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function MiseKitchen() {
  const recipes = useQuery(api.recipes.list, { ownerId: OWNER_ID });
  const activeSession = useQuery(api.sessions.getCurrent, { ownerId: OWNER_ID });
  const timers = useQuery(
    api.timers.listRunning,
    activeSession ? { sessionId: activeSession._id } : "skip",
  );

  const seedDemo = useMutation(api.recipes.seedDemo);
  const createRecipe = useMutation(api.recipes.create);
  const startSession = useMutation(api.sessions.start);
  const advanceSession = useMutation(api.sessions.advance);
  const pauseSession = useMutation(api.sessions.pause);
  const resumeSession = useMutation(api.sessions.resume);
  const stopSession = useMutation(api.sessions.stop);
  const recordSummary = useMutation(api.sessions.recordSummary);
  const setServings = useMutation(api.sessions.setServings);
  const recordEvent = useMutation(api.sessions.recordEvent);
  const startTimer = useMutation(api.timers.start);
  const completeTimer = useMutation(api.timers.complete);
  const cancelTimer = useMutation(api.timers.cancel);
  const remember = useAction(api.xtrace.remember);
  const recallPreferences = useAction(api.xtrace.recallPreferences);
  const createConversationToken = useAction(api.elevenlabs.createConversationToken);
  const createTextConversationUrl = useAction(api.elevenlabs.createTextConversationUrl);

  const [message, setMessage] = useState("");
  const [typedCommand, setTypedCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentStarting, setAgentStarting] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [agentThinking, setAgentThinking] = useState(false);
  const [streamingAgentText, setStreamingAgentText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [now, setNow] = useState(Date.now());
  const [activeTab, setActiveTab] = useState<AppTab>("kitchen");
  const [isCookMode, setIsCookMode] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [plannedServings, setPlannedServings] = useState<number | null>(null);
  const [alertingTimerIds, setAlertingTimerIds] = useState<Record<string, true>>({});
  const [photoChecking, setPhotoChecking] = useState(false);

  const seededOnce = useRef(false);
  const alertedTimerIds = useRef(new Set<string>());
  const notificationIds = useRef(new Map<string, string>());
  const pendingTimerChoice = useRef<KitchenTimer[] | null>(null);
  const fullChatMessages = useRef<ChatMessage[]>([]);
  const lastCookSnapshot = useRef<CookSnapshot | null>(null);
  const lastFinalTranscript = useRef({ text: "", at: 0 });
  const latestInterimTranscript = useRef("");
  const pendingMicStart = useRef(false);
  const continuousListening = useRef(false);
  const recognizerActive = useRef(false);
  const listeningStartInFlight = useRef(false);
  const listeningRestartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnFinalizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechPermissionGranted = useRef(false);
  const stopRequestedForTurn = useRef(false);
  const hideInitialAgentGreeting = useRef(false);
  const queuedChatMessages = useRef<string[]>([]);
  const pendingKitchenMemory = useRef<string | null>(null);
  const chatMessageSequence = useRef(0);
  const textSocket = useRef<WebSocket | null>(null);
  const textSocketWasClosedDeliberately = useRef(false);
  const streamedAgentMessages = useRef(new Map<number, string>());
  const ignoredAgentStreamIds = useRef(new Set<number>());
  const streamingAgentReplyActive = useRef(false);
  const pendingNonStreamingAgentReply = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localActionEchoUntil = useRef(0);
  const joinedSharedSessionId = useRef<string | null>(null);
  const pendingSharedSession = useRef<{
    recipe: Recipe;
    servings: number;
    stepIndex: number;
  } | null>(null);

  const recipeList = recipes ?? [];
  const displayRecipes = useMemo(() => {
    const curated = recipeList.filter((recipe) => recipe.title !== LEGACY_DEMO_TITLE);
    return curated.length >= 4 ? curated : recipeList;
  }, [recipeList]);
  const selectedRecipe = useMemo(
    () =>
      displayRecipes.find((recipe) => recipe._id === selectedRecipeId) ??
      displayRecipes.find((recipe) => recipe.title === "Weeknight Chicken Curry") ??
      displayRecipes[0],
    [displayRecipes, selectedRecipeId],
  );
  const activeRecipe = useMemo(
    () => recipeList.find((recipe) => recipe._id === activeSession?.recipeId),
    [activeSession?.recipeId, recipeList],
  );
  const currentStep = activeRecipe?.steps[activeSession?.currentStep ?? 0];
  const isCookPaused = activeSession?.status === "paused";

  const conversation = useConversation({
    clientTools: {
      get_current_cooking_context: async () => getCookingContext(),
      start_cooking: async () =>
        "Shared cooks begin in VoiceOS. Wait for VoiceOS to create the session, then immediately guide the live recipe one clear step at a time here on the phone.",
      select_recipe: async ({ recipe_name }: { recipe_name: string }) => selectRecipe(recipe_name),
      advance_recipe_step: async () => moveToNextStep(true),
      set_kitchen_timer: async (
        {
          duration_seconds,
          minutes,
          label,
        }: { duration_seconds?: number; minutes?: number; label?: string } = {},
      ) => {
        const seconds = Number.isFinite(Number(duration_seconds))
          ? Number(duration_seconds)
          : Number(minutes) * 60;
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return "I need an exact timer duration before I can start it.";
        }
        return scheduleKitchenTimer(seconds, true, label);
      },
      stop_kitchen_timer: async ({ label }: { label?: string } = {}) => stopKitchenTimer(label),
      stop_cooking: async () => endCooking(),
      adjust_servings: async ({ servings }: { servings: number }) =>
        changeServings(Math.round(servings), true),
      save_cooking_preference: async ({ preference }: { preference: string }) =>
        rememberPreference(preference, true),
      save_new_recipe: async (
        {
          title,
          servings,
          ingredients,
          steps,
          notes,
        }: {
          title: string;
          servings: number;
          ingredients?: RawIngredient[] | string;
          steps?: RawStep[] | string;
          notes?: string;
        },
      ) => saveNewRecipe({ title, servings, ingredients, steps, notes }),
    },
    onConnect: () => {
      setMessage("Chef Mise is here with you.");
      setTimeout(() => flushDeferredMemory(), 0);
      flushQueuedChatMessages();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onDisconnect: (details) => {
      setAgentThinking(false);
      setStreamingAgentText("");
      if (continuousListening.current && details.reason !== "user") {
        const reason = details?.reason ? ` (${details.reason})` : "";
        setMessage(`Chef Mise’s chat disconnected${reason}. I’ll reconnect when you finish your next sentence.`);
      }
    },
    onError: (error) => {
      setAgentThinking(false);
      setMessage(`Chef Mise’s chat needs another try: ${String(error)}.`);
    },
    onMessage: ({ message: agentMessage, role }) => {
      if (role === "agent") queueNonStreamingAgentReply(agentMessage);
    },
    onAgentResponseCorrection: ({ corrected_agent_response }) => {
      queueNonStreamingAgentReply(corrected_agent_response);
    },
    onAgentChatResponsePart: (part) => {
      if (ignoredAgentStreamIds.current.has(part.event_id)) {
        if (part.type === "stop") ignoredAgentStreamIds.current.delete(part.event_id);
        return;
      }
      if (Date.now() < localActionEchoUntil.current) {
        // A local command (timer, next step, etc.) already produced its one
        // concise Chef bubble. ElevenLabs may still echo that action through
        // its own tool loop; keep that echo out of the conversation.
        ignoredAgentStreamIds.current.add(part.event_id);
        streamedAgentMessages.current.delete(part.event_id);
        setStreamingAgentText("");
        setAgentThinking(false);
        return;
      }
      if (part.type === "start") {
        streamingAgentReplyActive.current = true;
        clearQueuedNonStreamingAgentReply();
      }
      const previous = streamedAgentMessages.current.get(part.event_id) ?? "";
      const next = part.type === "start" ? part.text : `${previous}${part.text}`;
      streamedAgentMessages.current.set(part.event_id, next);
      setAgentThinking(false);
      setStreamingAgentText(next);
      if (part.type === "stop") {
        streamedAgentMessages.current.delete(part.event_id);
        streamingAgentReplyActive.current = false;
        receiveAgentReply(next);
      }
    },
  });

  const agentIsConnected = conversation.status === "connected";
  const agentIsConnecting = conversation.status === "connecting";

  // `onConnect` fires before React has committed the hook's connected state.
  // Starting iOS speech recognition from that callback meant the very first
  // spoken turn could be queued against a not-yet-ready text session and get
  // stranded. Start only after this render sees a fully connected chat.
  useEffect(() => {
    if (!TEXT_TEST_MODE || !agentIsConnected || !pendingMicStart.current || !continuousListening.current) {
      return;
    }

    pendingMicStart.current = false;
    const startDelay = setTimeout(() => void startListening(), 80);
    return () => clearTimeout(startDelay);
  }, [agentIsConnected]);

  function clearTurnFinalizer() {
    if (!turnFinalizeTimer.current) return;
    clearTimeout(turnFinalizeTimer.current);
    turnFinalizeTimer.current = null;
  }

  function scheduleTurnFinalizer(transcript: string) {
    latestInterimTranscript.current = transcript;
    clearTurnFinalizer();
    if (!continuousListening.current || !recognizerActive.current) return;

    turnFinalizeTimer.current = setTimeout(() => {
      turnFinalizeTimer.current = null;
      if (
        !continuousListening.current ||
        !recognizerActive.current ||
        stopRequestedForTurn.current ||
        !latestInterimTranscript.current
      ) {
        return;
      }
      // iOS otherwise waits a long silent beat before producing a final
      // transcript. Stopping after a natural pause makes Mise feel much more
      // conversational while preserving a complete, final turn for the agent.
      stopRequestedForTurn.current = true;
      ExpoSpeechRecognitionModule.stop();
    }, FAST_TURN_FINALIZE_MS);
  }

  function queueListeningRestart(delay = LISTENER_RESTART_MS) {
    if (!continuousListening.current || listeningRestartTimer.current) return;
    listeningRestartTimer.current = setTimeout(() => {
      listeningRestartTimer.current = null;
      if (continuousListening.current) void startListening(true);
    }, delay);
  }

  function cancelListeningRestart() {
    if (!listeningRestartTimer.current) return;
    clearTimeout(listeningRestartTimer.current);
    listeningRestartTimer.current = null;
  }

  useSpeechRecognitionEvent("start", () => {
    recognizerActive.current = true;
    setIsListening(true);
  });

  useSpeechRecognitionEvent("end", () => {
    const waitingForFinalTurn = stopRequestedForTurn.current;
    recognizerActive.current = false;
    setIsListening(false);
    clearTurnFinalizer();
    if (!continuousListening.current) return;
    queueListeningRestart(waitingForFinalTurn ? 320 : LISTENER_RESTART_MS);
  });

  useSpeechRecognitionEvent("result", (event) => {
    // iOS can send an empty final event after a rich interim result. When we
    // intentionally stopped the recognizer, finish the saved interim rather
    // than dropping the cook's sentence.
    const eventTranscript = event.results[0]?.transcript?.trim() ?? "";
    const transcript = eventTranscript || (stopRequestedForTurn.current ? latestInterimTranscript.current : "");
    if (!transcript) return;
    setLiveTranscript(transcript);

    // Continuous iOS recognition can emit several "final-like" results while
    // the cook is still talking. We only dispatch after our pause detector has
    // explicitly closed this turn, preventing duplicate/half-sentence sends.
    if (!stopRequestedForTurn.current) {
      scheduleTurnFinalizer(transcript);
      return;
    }
    if (!event.isFinal) return;

    clearTurnFinalizer();
    stopRequestedForTurn.current = false;
    latestInterimTranscript.current = "";
    const at = Date.now();
    if (lastFinalTranscript.current.text === transcript && at - lastFinalTranscript.current.at < 1600) {
      return;
    }
    lastFinalTranscript.current = { text: transcript, at };
    void handleKitchenCommand(transcript);
  });

  useSpeechRecognitionEvent("error", (event) => {
    if (event.error === "aborted") return;
    recognizerActive.current = false;
    clearTurnFinalizer();
    setIsListening(false);
    if (event.error === "no-speech") {
      // The matching end event owns the restart, preventing the old
      // no-speech/end double-loop.
      return;
    }
    speechPermissionGranted.current = false;
    continuousListening.current = false;
    setMessage("Mise needs Microphone and Speech Recognition access to keep listening.");
  });

  useEffect(() => {
    if (recipes === undefined || seededOnce.current) return;
    seededOnce.current = true;
    void seedDemo({ ownerId: OWNER_ID });
  }, [recipes, seedDemo]);

  // VoiceOS is the starting surface. As soon as it creates a shared Convex
  // session, the phone adopts that exact recipe instead of offering a second
  // start button or creating a duplicate cook.
  useEffect(() => {
    if (!activeSession || !activeRecipe) return;
    if (joinedSharedSessionId.current === activeSession._id) return;

    joinedSharedSessionId.current = activeSession._id;
    setActiveTab("kitchen");
    setIsCookMode(true);
    setSelectedRecipeId(activeRecipe._id);
    setPlannedServings(activeSession.servings);
    setChatMessages([]);
    fullChatMessages.current = [];
    setLiveTranscript("");
    continuousListening.current = TEXT_TEST_MODE;
    pendingMicStart.current = TEXT_TEST_MODE;
    lastCookSnapshot.current = {
      sessionId: activeSession._id,
      recipe: activeRecipe,
      servings: activeSession.servings,
      currentStep: activeSession.currentStep,
    };

    const step = activeRecipe.steps[activeSession.currentStep] ?? activeRecipe.steps[0];
    const immediateAction = step?.instruction
      .replace(/\s+/g, " ")
      .split(/[.!?]+/)[0]
      .replace(/\s+(?:then|and then)\s+.*/i, "")
      .trim();
    const welcome = step
      ? `Step ${activeSession.currentStep + 1}: ${immediateAction}. Tell me when that is done.`
      : `VoiceOS has us cooking ${activeRecipe.title} for ${activeSession.servings}. I’m right here with you, chef.`;
    setMessage(welcome);
    appendChatMessage("agent", welcome);
    pendingSharedSession.current = {
      recipe: activeRecipe,
      servings: activeSession.servings,
      stepIndex: activeSession.currentStep,
    };

    if (conversation.status !== "disconnected") {
      endAgentSession();
    } else {
      // On a cold launch the conversation is already "disconnected", so the
      // status-only effect below has already run before this ref is populated.
      // Start the shared cook immediately instead of waiting for a status
      // transition that will never happen. This is what makes the mic come on
      // without requiring the user to pause and resume first.
      const pending = pendingSharedSession.current;
      pendingSharedSession.current = null;
      void beginMiseConversation(pending);
    }
  }, [activeRecipe, activeSession, conversation.status]);

  // Wait for a previous session to close before opening the quiet text chat
  // for the newly adopted VoiceOS cook.
  useEffect(() => {
    if (conversation.status !== "disconnected") return;
    const pending = pendingSharedSession.current;
    if (!pending) return;
    pendingSharedSession.current = null;
    void beginMiseConversation(pending);
  }, [conversation.status]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!timers) return;
    for (const timer of timers) {
      if (timer.status === "paused" || timer.endsAt > now || alertedTimerIds.current.has(timer._id)) continue;
      alertedTimerIds.current.add(timer._id);
      setAlertingTimerIds((current) => ({ ...current, [timer._id]: true }));
      const answer = `${timer.label} is ready. I’m keeping the alarm active until you say “stop timer.”`;
      announce(answer);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      updateAgentContext(
        `A timer finished: ${timer.label}. Tell the cook immediately that it is ready and that the alarm is still active.`,
      );
    }
  }, [conversation, now, timers]);

  useEffect(() => {
    if (Object.keys(alertingTimerIds).length === 0) return;
    const interval = setInterval(() => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }, 2400);
    return () => clearInterval(interval);
  }, [alertingTimerIds]);

  function appendChatMessage(role: ChatMessage["role"], text: string) {
    const clean = text.trim();
    if (!clean) return;
    const normalized = normalizeChatText(clean);
    const history = fullChatMessages.current;
    const last = history[history.length - 1];
    if (last?.role === role && normalizeChatText(last.text) === normalized) return;
    if (
      role === "agent" &&
      history.slice(-8).some((item) => item.role === "agent" && normalizeChatText(item.text) === normalized)
    ) {
      return;
    }

    chatMessageSequence.current += 1;
    const nextMessage = { id: `${role}-${chatMessageSequence.current}`, role, text: clean } as ChatMessage;
    fullChatMessages.current = [...history, nextMessage].slice(-80);
    setChatMessages(fullChatMessages.current.slice(-15));

    // Convex now keeps both sides of the actual chef conversation. The
    // in-memory history remains longer than the visual feed so the end-of-cook
    // recap can use the real session rather than just the last two bubbles.
    if (role === "agent") {
      void recordEvent({
        ownerId: OWNER_ID,
        ...(activeSession ? { sessionId: activeSession._id } : {}),
        kind: "agent",
        text: clean,
      });
    }
  }

  function announce(text: string) {
    setMessage(text);
    if (TEXT_TEST_MODE) appendChatMessage("agent", text);
  }

  function findRecipe(recipeName?: string) {
    if (!recipeName?.trim()) return selectedRecipe;
    const normalized = recipeName.trim().toLowerCase();
    return (
      recipeList.find((recipe) => recipe.title.toLowerCase().includes(normalized)) ??
      recipeList.find((recipe) => normalized.includes(recipe.title.toLowerCase()))
    );
  }

  function getCookingContext() {
    if (!activeRecipe || !activeSession || !currentStep) {
      const choices = displayRecipes.map((recipe) => recipe.title).join(", ");
      return [
        "No recipe is active yet.",
        `Available saved recipes: ${choices || "recipes are loading"}.`,
        "Ask what the cook wants to make, then ask how many people they are feeding before beginning.",
      ].join(" ");
    }

    return formatRecipeContext(activeRecipe, activeSession.servings, activeSession.currentStep);
  }

  function formatRecipeContext(recipe: Recipe, servings: number, stepIndex = 0) {
    const step = recipe.steps[stepIndex] ?? recipe.steps[0];
    const immediateAction = step.instruction
      .replace(/\s+/g, " ")
      .split(/[.!?]+/)[0]
      .replace(/\s+(?:then|and then)\s+.*/i, "")
      .trim();
    const ingredients = recipe.ingredients
      .map(
        (ingredient) =>
          `${scaledQuantity(ingredient.quantity, recipe.baseServings, servings)} ${ingredient.unit} ${ingredient.name}`,
      )
      .join(", ");
    const timerContext = (timers ?? [])
      .map((timer) => `${timer.label}: ${formatTime(timer.status === "paused" ? timer.remainingSeconds ?? 0 : (timer.endsAt - now) / 1000)} remaining${timer.status === "paused" ? " (paused)" : ""}`)
      .join("; ");
    return [
      `Recipe: ${recipe.title}.`,
      `Servings: ${servings}.`,
      `Current step ${stepIndex + 1} of ${recipe.steps.length}: ${step.title}.`,
      `Immediate action only: ${immediateAction}.`,
      `Step timing: ${step.minutes} minutes on ${step.heat} heat.`,
      `Tip: ${step.tip}`,
      `Scaled ingredients: ${ingredients}.`,
      timerContext ? `Active timers: ${timerContext}.` : "No active timers.",
      "Chef delivery rule: reply in two short sentences maximum (about 25 words total). Give only the immediate physical action above, then ask the cook to tell you when it is done. Never read a stored recipe instruction verbatim or bundle preparation, heating, adding, and timing together.",
    ].join(" ");
  }

  function sendTextSocketEvent(event: Record<string, unknown>) {
    const socket = textSocket.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  }

  function receiveAgentReply(reply: string) {
    if (Date.now() < localActionEchoUntil.current) {
      setStreamingAgentText("");
      setAgentThinking(false);
      return;
    }
    const clean = reply.trim();
    if (!clean) return;
    const isIdleGreeting = /what are we in the mood to make today|what would you like to cook today/i.test(clean);
    if (activeSession && isIdleGreeting) {
      // A live shared cook already has a recipe and a step. Never replace that
      // context with ElevenLabs' default idle greeting after reconnecting.
      hideInitialAgentGreeting.current = false;
      setStreamingAgentText("");
      setAgentThinking(false);
      return;
    }
    if (hideInitialAgentGreeting.current) {
      hideInitialAgentGreeting.current = false;
      setStreamingAgentText("");
      setAgentThinking(false);
      return;
    }
    setMessage(clean);
    setStreamingAgentText("");
    setAgentThinking(false);
    appendChatMessage("agent", clean);
  }

  function clearQueuedNonStreamingAgentReply() {
    if (!pendingNonStreamingAgentReply.current) return;
    clearTimeout(pendingNonStreamingAgentReply.current);
    pendingNonStreamingAgentReply.current = null;
  }

  // ElevenLabs emits a compact normal message and a streamed message for the
  // same turn on some sessions. Delay the non-streamed path just long enough
  // for the stream to announce itself; use it only when streaming never comes.
  function queueNonStreamingAgentReply(reply: string) {
    if (Date.now() < localActionEchoUntil.current) return;
    clearQueuedNonStreamingAgentReply();
    pendingNonStreamingAgentReply.current = setTimeout(() => {
      pendingNonStreamingAgentReply.current = null;
      if (Date.now() < localActionEchoUntil.current) return;
      receiveAgentReply(reply);
    }, 650);
  }

  function suppressLocalActionEcho() {
    // Cleared as soon as the cook asks a new normal question. This only hides
    // the trailing model confirmation for the action we already displayed.
    localActionEchoUntil.current = Date.now() + 8_000;
    clearQueuedNonStreamingAgentReply();
  }

  async function runTextClientTool(toolName: string, parameters: Record<string, unknown> = {}) {
    switch (toolName) {
      case "get_current_cooking_context":
        return getCookingContext();
      case "start_cooking":
        return "Shared cooks begin in VoiceOS. Wait for VoiceOS to create the session, then immediately guide the live recipe one clear step at a time here on the phone.";
      case "select_recipe":
        return selectRecipe(typeof parameters.recipe_name === "string" ? parameters.recipe_name : "");
      case "advance_recipe_step":
        return moveToNextStep(true);
      case "set_kitchen_timer": {
        const exactSeconds = Number(parameters.duration_seconds);
        const minutes = Number(parameters.minutes);
        const seconds = Number.isFinite(exactSeconds) ? exactSeconds : minutes * 60;
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return "I need an exact timer duration before I can start it.";
        }
        return scheduleKitchenTimer(
          seconds,
          true,
          typeof parameters.label === "string" ? parameters.label : undefined,
        );
      }
      case "stop_kitchen_timer":
        return stopKitchenTimer(typeof parameters.label === "string" ? parameters.label : undefined);
      case "stop_cooking":
        return endCooking();
      case "adjust_servings": {
        const servings = Number(parameters.servings);
        if (!Number.isFinite(servings) || servings <= 0) return "I need a positive number of servings.";
        return changeServings(Math.round(servings), true);
      }
      case "save_cooking_preference":
        return rememberPreference(typeof parameters.preference === "string" ? parameters.preference : "");
      case "save_new_recipe": {
        if (typeof parameters.title !== "string") return "I need the recipe title before I can save it.";
        const ingredients =
          typeof parameters.ingredients === "string" || Array.isArray(parameters.ingredients)
            ? (parameters.ingredients as RawIngredient[] | string)
            : undefined;
        const steps =
          typeof parameters.steps === "string" || Array.isArray(parameters.steps)
            ? (parameters.steps as RawStep[] | string)
            : undefined;
        return saveNewRecipe({
          title: parameters.title,
          servings: Number(parameters.servings) || 2,
          ingredients,
          steps,
          notes: typeof parameters.notes === "string" ? parameters.notes : undefined,
        });
      }
      default:
        return `Client tool ${toolName} is not available in Mise.`;
    }
  }

  function handleTextSocketEvent(raw: string) {
    let event: TextSocketEvent;
    try {
      event = JSON.parse(raw) as TextSocketEvent;
    } catch {
      return;
    }

    if (event.type === "conversation_initiation_metadata") {
      setAgentStarting(false);
      setMessage("Chef Mise is here with you.");
      flushQueuedChatMessages();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (TEXT_TEST_MODE && pendingMicStart.current) {
        pendingMicStart.current = false;
        setTimeout(() => void startListening(), 180);
      }
      return;
    }

    if (event.type === "agent_response") {
      receiveAgentReply(event.agent_response_event?.agent_response ?? "");
      return;
    }

    if (event.type === "agent_response_correction") {
      receiveAgentReply(event.agent_response_correction_event?.corrected_agent_response ?? "");
      return;
    }

    if (event.type === "agent_chat_response_part") {
      const part = event.text_response_part;
      if (!part || typeof part.event_id !== "number") return;
      const previous = streamedAgentMessages.current.get(part.event_id) ?? "";
      const next = part.type === "start" ? (part.text ?? "") : `${previous}${part.text ?? ""}`;
      streamedAgentMessages.current.set(part.event_id, next);
      setAgentThinking(false);
      setStreamingAgentText(next);
      if (part.type === "stop") {
        streamedAgentMessages.current.delete(part.event_id);
        receiveAgentReply(next);
      }
      return;
    }

    if (event.type === "client_tool_call") {
      const call = event.client_tool_call;
      if (!call?.tool_call_id || !call.tool_name) return;
      void runTextClientTool(call.tool_name, call.parameters ?? {})
        .then((result) => {
          sendTextSocketEvent({
            type: "client_tool_result",
            tool_call_id: call.tool_call_id,
            result: String(result),
            is_error: false,
          });
        })
        .catch((error: unknown) => {
          sendTextSocketEvent({
            type: "client_tool_result",
            tool_call_id: call.tool_call_id,
            result: error instanceof Error ? error.message : "Chef Mise could not complete that kitchen action.",
            is_error: true,
          });
        });
      return;
    }

    if (event.type === "ping" && typeof event.ping_event?.event_id === "number") {
      sendTextSocketEvent({ type: "pong", event_id: event.ping_event.event_id });
      return;
    }

    if (event.type === "error") {
      setAgentThinking(false);
      setMessage(event.error?.message || "Chef Mise’s chat received an unexpected error. Try your question again.");
    }
  }

  function closeTextChat() {
    const socket = textSocket.current;
    textSocketWasClosedDeliberately.current = true;
    streamedAgentMessages.current.clear();
    setStreamingAgentText("");
    if (socket) socket.close();
    textSocket.current = null;
    setAgentStarting(false);
  }

  function endAgentSession() {
    if (conversation.status !== "disconnected") conversation.endSession();
  }

  function updateAgentContext(change: string) {
    if (conversation.status === "connected") {
      // The complete recipe is supplied when the chat opens. Sending only a
      // state delta here keeps later turns lean; the agent can ask the kitchen
      // context tool when it genuinely needs the full live picture.
      conversation.sendContextualUpdate(change);
    }
  }

  function flushQueuedChatMessages() {
    if (queuedChatMessages.current.length === 0) return;
    const messages = [...queuedChatMessages.current];
    queuedChatMessages.current = [];
    for (const text of messages) {
      conversation.sendUserMessage(text);
    }
  }

  function flushDeferredMemory() {
    const memory = pendingKitchenMemory.current;
    if (!memory || conversation.status !== "connected") return;
    pendingKitchenMemory.current = null;
    conversation.sendContextualUpdate(`Relevant remembered kitchen notes: ${memory}`);
  }

  function queueKitchenMemory(memory: string) {
    const clean = memory.trim();
    if (!clean) return;
    pendingKitchenMemory.current = clean.slice(0, 2400);
    flushDeferredMemory();
  }

  function sendTextMessage(text: string, shouldAppendUserMessage = true) {
    localActionEchoUntil.current = 0;
    if (shouldAppendUserMessage) appendChatMessage("user", text);
    setAgentThinking(true);
    if (conversation.status === "connected") {
      conversation.sendUserMessage(text);
      return;
    }
    queuedChatMessages.current.push(text);
    void beginMiseConversation();
  }

  async function selectRecipe(recipeName: string) {
    const recipe = findRecipe(recipeName);
    if (!recipe) return "I can’t find that recipe yet. Tell me what you want to make and I’ll help you create it.";
    setSelectedRecipeId(recipe._id);
    setPlannedServings(recipe.baseServings);
    const answer = `${recipe.title} is selected. It makes ${recipe.baseServings} servings — tell me if you need a different amount.`;
    setMessage(answer);
    updateAgentContext(`The cook selected ${recipe.title}.`);
    return answer;
  }

  async function startCooking(
    promptAgent = true,
    requestedRecipe?: Recipe,
    listenAfterStarting = false,
  ) {
    const recipe = requestedRecipe ?? selectedRecipe;
    if (!recipe) return "Your recipe box is still loading. Give it a moment, then try again.";
    const servings = plannedServings ?? recipe.baseServings;
    setIsCookMode(true);
    continuousListening.current = TEXT_TEST_MODE;
    setSelectedRecipeId(recipe._id);
    setBusy(true);
    try {
      const started = await startSession({
        ownerId: OWNER_ID,
        recipeId: recipe._id,
        servings,
      });
      lastCookSnapshot.current = {
        sessionId: started.sessionId,
        recipe,
        servings,
        currentStep: 0,
      };
      const answer = `Great choice. ${recipe.title} for ${servings}. Start with this: ${recipe.steps[0].instruction} Let me know when you’re done.`;
      if (promptAgent) {
        setMessage(answer);
      } else {
        announce(answer);
      }
      if (promptAgent && agentIsConnected) {
        updateAgentContext(`The cook started ${recipe.title}. Give only step one, then wait for their response.`);
      }
      if (listenAfterStarting) {
        if (TEXT_TEST_MODE && agentIsConnected) {
          void startListening();
        } else if (!agentIsConnected) {
          if (TEXT_TEST_MODE) pendingMicStart.current = true;
          void beginMiseConversation({ recipe, servings });
        }
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return answer;
    } catch {
      const answer = "I couldn’t start the cook yet. Check that Mise is connected, then try again.";
      announce(answer);
      return answer;
    } finally {
      setBusy(false);
    }
  }

  async function moveToNextStep(promptAgent = true) {
    if (!activeSession || !activeRecipe) {
      const answer = "There isn’t an active recipe to advance. Ask the cook what they’d like to make.";
      announce(answer);
      return answer;
    }
    if (activeSession.status !== "active") {
      const answer = activeSession.status === "paused"
        ? "The cook is paused. Wait for them to resume before moving to the next step."
        : "That cook has already ended.";
      announce(answer);
      return answer;
    }
    setBusy(true);
    try {
      const outcome = await advanceSession({ sessionId: activeSession._id });
      if (lastCookSnapshot.current?.sessionId === activeSession._id) {
        lastCookSnapshot.current = {
          ...lastCookSnapshot.current,
          currentStep: outcome.currentStep,
        };
      }
      const next = activeRecipe.steps[outcome.currentStep];
      const answer =
        outcome.status === "complete"
          ? "You did it. Dinner is ready — taste it once, then serve it proud."
          : `Nice. Next, ${next.title.toLowerCase()}: ${next.instruction} Let me know when that’s done.`;
      announce(answer);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return answer;
    } catch {
      const answer = "I couldn’t move to the next step. Try that once more.";
      announce(answer);
      return answer;
    } finally {
      setBusy(false);
    }
  }

  async function changeServings(servings: number, promptAgent = true) {
    if (!activeSession || !activeRecipe) {
      const recipe = selectedRecipe;
      if (!recipe) return "Pick a recipe first, then I can scale it.";
      const safeServings = Math.max(1, Math.min(12, Math.round(servings)));
      setPlannedServings(safeServings);
      const answer = `${recipe.title} is written for ${recipe.baseServings}; I’ll use ${safeServings} servings when you start.`;
      announce(answer);
      return answer;
    }
    const result = await setServings({ sessionId: activeSession._id, servings });
    if (lastCookSnapshot.current?.sessionId === activeSession._id) {
      lastCookSnapshot.current = { ...lastCookSnapshot.current, servings: result.servings };
    }
    const answer = `Done. ${activeRecipe.title} is now scaled for ${result.servings} servings.`;
    announce(answer);
    return answer;
  }

  function repeatCurrentStep() {
    if (!activeRecipe || !activeSession || !currentStep) {
      const answer = "Tell me what we’re making and I’ll get us oriented.";
      announce(answer);
      return answer;
    }
    const immediateAction = currentStep.instruction
      .replace(/\s+/g, " ")
      .split(/[.!?]+/)[0]
      .replace(/\s+(?:then|and then)\s+.*/i, "")
      .trim();
    const answer = `Step ${activeSession.currentStep + 1}: ${immediateAction}. Tell me when that is done.`;
    announce(answer);
    return answer;
  }

  function handleKitchenRescue(clean: string, fallbackResponse: string) {
    const tofuPivot =
      /\btofu\b/i.test(clean) &&
      /\b(?:swap|instead|replace|use|switch|make)\b/i.test(clean);
    const answer = tofuPivot
      ? "Good pivot. Move the pan off the heat and keep any unburnt sauce away from blackened bits. If you’re switching to tofu, pat it dry, brown it separately for 3 to 4 minutes per side, then let it warm through in clean sauce for 5 to 7 minutes — not the chicken timer."
      : fallbackResponse;
    announce(answer);
    void recordEvent({
      ownerId: OWNER_ID,
      ...(activeSession ? { sessionId: activeSession._id } : {}),
      kind: "rescue",
      text: `${clean} → ${answer}`,
    });
    return answer;
  }

  async function scheduleKitchenTimer(seconds: number, promptAgent = true, customLabel?: string) {
    if (!activeSession) {
      const answer = "Start the dish first, then I can keep an eye on timers for you.";
      announce(answer);
      return answer;
    }
    const label = customLabel?.trim() || (currentStep ? `${currentStep.title} timer` : "Kitchen timer");
    const safeSeconds = Math.max(10, Math.min(7200, Math.round(seconds)));
    try {
      const createdTimer = await startTimer({
        sessionId: activeSession._id,
        label,
        durationSeconds: safeSeconds,
      });
      // A device notification is helpful but should not hold up the agent’s
      // tool result or make a short timer feel sluggish.
      void scheduleLocalNotification(safeSeconds, label).then((notificationId) => {
        if (notificationId) notificationIds.current.set(createdTimer.timerId, notificationId);
      });
      const answer = `Timer started for ${formatTimerDuration(safeSeconds)}: ${label}. I’ll alert you until you stop it.`;
      announce(answer);
      return answer;
    } catch {
      const answer = "I couldn’t start that timer. Please try it again.";
      announce(answer);
      return answer;
    }
  }

  async function dismissTimer(timer: KitchenTimer, wasAlerting = Boolean(alertingTimerIds[timer._id])) {
    try {
      if (wasAlerting) {
        await completeTimer({ timerId: timer._id });
      } else {
        await cancelTimer({ timerId: timer._id });
      }
      const notificationId = notificationIds.current.get(timer._id);
      if (notificationId) {
        await Notifications.cancelScheduledNotificationAsync(notificationId);
        notificationIds.current.delete(timer._id);
      }
      alertedTimerIds.current.delete(timer._id);
      setAlertingTimerIds((current) => {
        const next = { ...current };
        delete next[timer._id];
        return next;
      });
      const answer = wasAlerting ? `${timer.label} alarm stopped.` : `${timer.label} cancelled.`;
      announce(answer);
      pendingTimerChoice.current = null;
      return answer;
    } catch {
      return "I couldn’t stop that timer. Try the button once more.";
    }
  }

  function askWhichTimer(candidates: KitchenTimer[]) {
    pendingTimerChoice.current = candidates;
    const choices = candidates
      .map((timer, index) => `${index === 0 ? "first" : index === 1 ? "second" : `timer ${index + 1}`}, ${timer.label}`)
      .join("; ");
    const answer = `I have ${candidates.length} timers running: ${choices}. Which one should I stop?`;
    announce(answer);
    return answer;
  }

  function choosePendingTimer(clean: string) {
    const candidates = pendingTimerChoice.current;
    if (!candidates?.length) return null;
    const text = clean.toLowerCase();
    const selectedByPosition =
      /\b(?:first|one|1)\b/.test(text)
        ? candidates[0]
        : /\b(?:second|two|2)\b/.test(text)
          ? candidates[1]
          : /\b(?:third|three|3)\b/.test(text)
            ? candidates[2]
            : undefined;
    const selected =
      selectedByPosition ??
      candidates.find((timer) => {
        const label = timer.label.toLowerCase();
        return label.includes(text) || text.includes(label);
      });
    if (!selected) return null;

    pendingTimerChoice.current = null;
    return (timers ?? []).find((timer) => timer._id === selected._id) ?? null;
  }

  async function stopKitchenTimer(label?: string) {
    const candidates = (timers ?? []).filter((timer) =>
      label ? timer.label.toLowerCase().includes(label.toLowerCase()) : true,
    );
    if (candidates.length === 0) return "There isn’t an active kitchen timer to stop.";
    if (candidates.length > 1) return askWhichTimer(candidates);
    return dismissTimer(candidates[0]);
  }

  async function pauseCooking() {
    if (!activeSession) return "There isn’t a cook in progress right now.";
    if (activeSession.status === "paused") return resumeCooking();

    continuousListening.current = false;
    pendingMicStart.current = false;
    cancelListeningRestart();
    clearTurnFinalizer();
    recognizerActive.current = false;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // The recognizer may already be idle.
    }
    setIsListening(false);

    setBusy(true);
    try {
      const result = await pauseSession({ sessionId: activeSession._id });
      if (result.paused) {
        endAgentSession();
        await Promise.all(
          [...notificationIds.current.values()].map((notificationId) =>
            Notifications.cancelScheduledNotificationAsync(notificationId),
          ),
        );
        notificationIds.current.clear();
      }
      const answer = result.paused
        ? "Cook paused. I froze your kitchen timers too, so nothing will finish while you’re away."
        : "That cook could not be paused right now.";
      announce(answer);
      return answer;
    } catch {
      const answer = "I couldn’t pause the cook cleanly. Try that once more.";
      announce(answer);
      return answer;
    } finally {
      setBusy(false);
    }
  }

  async function resumeCooking() {
    if (!activeSession || !activeRecipe) return "There isn’t a paused cook ready to resume.";

    setBusy(true);
    try {
      const result = await resumeSession({ sessionId: activeSession._id });
      if (!result.resumed) return "That cook is already running.";

      // The paused timer records carry their frozen remainder. Re-arm the
      // phone's local reminders using that remainder as the cook resumes.
      for (const timer of timers ?? []) {
        if (timer.status !== "paused") continue;
        const seconds = Math.max(1, Math.round(timer.remainingSeconds ?? 0));
        void scheduleLocalNotification(seconds, timer.label).then((notificationId) => {
          if (notificationId) notificationIds.current.set(timer._id, notificationId);
        });
      }

      const resumedStep = activeRecipe.steps[activeSession.currentStep];
      const answer = resumedStep
        ? `Welcome back. We’re continuing ${activeRecipe.title} at step ${activeSession.currentStep + 1}: ${resumedStep.title}.`
        : `Welcome back. We’re continuing ${activeRecipe.title}.`;
      announce(answer);
      setIsCookMode(true);
      continuousListening.current = TEXT_TEST_MODE;
      if (TEXT_TEST_MODE && agentIsConnected) {
        void startListening();
      } else {
        if (TEXT_TEST_MODE) pendingMicStart.current = true;
        void beginMiseConversation({
          recipe: activeRecipe,
          servings: activeSession.servings,
          stepIndex: activeSession.currentStep,
          resume: true,
        });
      }
      return answer;
    } catch {
      const answer = "I couldn’t resume the cook yet. Try that once more.";
      announce(answer);
      return answer;
    } finally {
      setBusy(false);
    }
  }

  function confirmStopCooking() {
    Alert.alert(
      "Stop this cook?",
      "This ends the cooking session and clears any active timers.",
      [
        { text: "Keep cooking", style: "cancel" },
        { text: "Stop cook", style: "destructive", onPress: () => void endCooking() },
      ],
    );
  }

  function buildCookSummary() {
    const snapshot =
      activeSession && activeRecipe
        ? {
            sessionId: activeSession._id,
            recipe: activeRecipe,
            servings: activeSession.servings,
            currentStep: activeSession.currentStep,
          }
        : lastCookSnapshot.current;
    if (!snapshot) return null;

    const completed = snapshot.currentStep >= snapshot.recipe.steps.length;
    const step = snapshot.recipe.steps[Math.min(snapshot.currentStep, snapshot.recipe.steps.length - 1)];
    const usefulCookNotes = fullChatMessages.current
      .filter(
        (item) =>
          item.role === "user" &&
          /\b(?:like|love|hate|prefer|spic|allerg|substitut|swap|instead|tofu|burn|char|salt|thick|thin|extra|minute|timer|don't have|do not have|didn't have)\b/i.test(
            item.text,
          ),
      )
      .slice(-5)
      .map((item) => item.text.replace(/\s+/g, " ").slice(0, 220));

    const parts = [
      `Cook recap: ${snapshot.recipe.title} for ${snapshot.servings} serving${snapshot.servings === 1 ? "" : "s"}.`,
      completed
        ? "Outcome: completed."
        : `Outcome: stopped before finishing${step ? ` at ${step.title.toLowerCase()}` : ""}.`,
      usefulCookNotes.length > 0
        ? `Useful cook notes: ${usefulCookNotes.join(" | ")}.`
        : "No confirmed substitutions or durable preferences were captured this cook.",
    ];
    return { snapshot, summary: parts.join(" ").slice(0, 2_800) };
  }

  function saveCookSummaryToMemory(sessionId: CookingSession["_id"], summary: string) {
    // Convex is the reliable transcript of record. XTrace receives the same
    // compact recap so the next cook can be personally useful without replaying
    // every line of kitchen chatter.
    void remember({ ownerId: OWNER_ID, conversationId: sessionId, content: summary }).catch(() => undefined);
  }

  async function endCooking() {
    continuousListening.current = false;
    pendingMicStart.current = false;
    cancelListeningRestart();
    clearTurnFinalizer();
    recognizerActive.current = false;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // The recognizer may already be idle.
    }
    setIsListening(false);
    endAgentSession();

    const cookRecap = buildCookSummary();

    if (!activeSession) {
      if (cookRecap) {
        try {
          await recordSummary({
            sessionId: cookRecap.snapshot.sessionId,
            summary: cookRecap.summary,
          });
          saveCookSummaryToMemory(cookRecap.snapshot.sessionId, cookRecap.summary);
        } catch {
          // The session can disappear between the final step and this tap. Its
          // ordinary transcript is still intact, so avoid interrupting the exit.
        }
        lastCookSnapshot.current = null;
      }
      setIsCookMode(false);
      setChatMessages([]);
      fullChatMessages.current = [];
      const answer = cookRecap
        ? "Dinner wrapped. I saved a short recap for next time — come back hungry whenever you’re ready."
        : "Chef Mise is off duty for now. Come back hungry whenever you’re ready.";
      setMessage(answer);
      return answer;
    }
    setBusy(true);
    try {
      const result = await stopSession({
        sessionId: activeSession._id,
        ...(cookRecap ? { summary: cookRecap.summary } : {}),
      });
      if (cookRecap && result.summaryEventId) {
        saveCookSummaryToMemory(cookRecap.snapshot.sessionId, cookRecap.summary);
      }
      for (const notificationId of notificationIds.current.values()) {
        await Notifications.cancelScheduledNotificationAsync(notificationId);
      }
      notificationIds.current.clear();
      alertedTimerIds.current.clear();
      setAlertingTimerIds({});
      const answer = result.stopped
        ? `Cook stopped. I cleared ${result.timersStopped} active timer${result.timersStopped === 1 ? "" : "s"}, and saved a quick recap for next time.`
        : "That cook was already stopped.";
      setMessage(answer);
      lastCookSnapshot.current = null;
      return answer;
    } catch {
      const answer = "I couldn’t stop the cook cleanly. Try that button once more.";
      announce(answer);
      return answer;
    } finally {
      setBusy(false);
    }
  }

  async function rememberPreference(content: string, promptAgent = true) {
    const response = await remember({
      ownerId: OWNER_ID,
      conversationId: activeSession?._id ?? "mise-onboarding",
      content,
    });
    announce(response.message);
    void recordEvent({
      ownerId: OWNER_ID,
      ...(activeSession ? { sessionId: activeSession._id } : {}),
      kind: "memory",
      text: content,
    });
    return response.message;
  }

  async function saveNewRecipe({
    title,
    servings,
    ingredients,
    steps,
    notes,
  }: {
    title: string;
    servings: number;
    ingredients?: RawIngredient[] | string;
    steps?: RawStep[] | string;
    notes?: string;
  }) {
    const cleanTitle = title?.trim();
    const cleanedIngredients = normalizeIngredients(ingredients);
    const cleanedSteps = normalizeSteps(steps);
    if (!cleanTitle || cleanedIngredients.length === 0) {
      return "I need the dish name and at least one measured ingredient before I can save it. Ask the cook for those first.";
    }
    try {
      const safeServings = Math.max(1, Math.min(12, Math.round(servings || 2)));
      const recipeSteps = cleanedSteps.length > 0 ? cleanedSteps : [defaultCustomStep(cleanTitle)];
      const cookMinutes = Math.max(5, recipeSteps.reduce((total, step) => total + step.minutes, 0));
      const result = await createRecipe({
        ownerId: OWNER_ID,
        title: cleanTitle,
        emoji: "🍽️",
        description: `A custom ${cleanTitle} captured in Chef Mise’s kitchen.`,
        cuisine: "Custom",
        baseServings: safeServings,
        prepMinutes: 10,
        cookMinutes,
        ingredients: cleanedIngredients,
        steps: recipeSteps,
        notes: notes?.trim() || "Saved while cooking with Chef Mise.",
      });
      setSelectedRecipeId(result.recipeId);
      const memory = `${cleanTitle}: saved as a custom recipe for ${safeServings} servings. Ingredients: ${cleanedIngredients.map((ingredient) => `${ingredient.quantity} ${ingredient.unit} ${ingredient.name}`).join(", ")}.`;
      void remember({
        ownerId: OWNER_ID,
        conversationId: activeSession?._id ?? "mise-custom-recipes",
        content: memory,
      });
      const answer = activeSession
        ? `${cleanTitle} is saved in your recipe box. I’ll remember it was built for ${safeServings} servings.`
        : `${cleanTitle} is saved in your recipe box for ${safeServings} servings. Start it from VoiceOS when you’re ready, and I’ll take over here.`;
      announce(answer);
      return answer;
    } catch {
      return "I couldn’t save that recipe yet. Keep the ingredient details in this chat and try once more.";
    }
  }

  async function saveManualRecipe(draft: ManualRecipeDraft) {
    const title = draft.title.trim();
    const ingredients = normalizeIngredients(draft.ingredients);
    const steps = normalizeSteps(draft.steps);
    if (!title) return "Give your recipe a name first.";
    if (ingredients.length === 0) return "Add at least one ingredient, one per line.";
    if (steps.length === 0) return "Add at least one preparation step, one per line.";

    const servings = Math.max(1, Math.min(12, Math.round(Number(draft.servings) || 2)));
    try {
      const result = await createRecipe({
        ownerId: OWNER_ID,
        title,
        emoji: "🍽️",
        description: `A personal ${title} recipe saved in Mise.`,
        cuisine: "Custom",
        baseServings: servings,
        prepMinutes: Math.max(5, steps.length * 4),
        cookMinutes: Math.max(5, steps.reduce((total, step) => total + step.minutes, 0)),
        ingredients,
        steps,
        notes: draft.notes.trim() || "Added manually to Mise.",
      });
      setSelectedRecipeId(result.recipeId);
      return `${title} is in your recipe box.`;
    } catch {
      return "I couldn’t save that recipe just yet. Please try again.";
    }
  }

  async function shareKitchenPhoto(source: "camera" | "library") {
    if (conversation.status !== "connected") {
      const answer = "Start or resume Chef Mise first, then I can inspect a photo with you.";
      setMessage(answer);
      return;
    }

    try {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setMessage("Mise needs photo permission to inspect what’s in the pan.");
        return;
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.72 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.72 });
      if (result.canceled || !result.assets[0]) return;

      setPhotoChecking(true);
      setAgentThinking(true);
      setMessage("Chef Mise is taking a close look…");
      const response = await fetch(result.assets[0].uri);
      const photo = await response.blob();
      const uploaded = await conversation.uploadFile(photo);
      const context = currentStep
        ? `Chef, inspect this cooking photo for the current step: ${currentStep.title}. Tell me only what looks right, what to watch for, and the safest next move.`
        : "Chef, inspect this cooking photo. Tell me what you see, what looks right, what to watch for, and the safest next move.";
      appendChatMessage("user", "📷 Showed Chef Mise a cooking photo.");
      conversation.sendMultimodalMessage({ text: context, fileId: uploaded.fileId });
    } catch {
      setAgentThinking(false);
      setMessage("I couldn’t send that photo to Chef Mise. Try one more time with a clear, well-lit shot.");
    } finally {
      setPhotoChecking(false);
    }
  }

  function promptKitchenPhoto() {
    Alert.alert("Show Chef Mise", "Take a clear, well-lit photo of the pan, food, or ingredient.", [
      { text: "Camera", onPress: () => void shareKitchenPhoto("camera") },
      { text: "Choose photo", onPress: () => void shareKitchenPhoto("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function handleKitchenCommand(raw: string) {
    const clean = raw.trim();
    if (!clean) return;
    setLiveTranscript("");

    void recordEvent({
      ownerId: OWNER_ID,
      ...(activeSession ? { sessionId: activeSession._id } : {}),
      kind: "voice",
      text: clean,
    });

    if (
      /\b(?:stop|end|finish|close)\s+(?:the\s+)?(?:cook|cooking|chef|mise|session)\b|\b(?:goodbye|bye)\s+(?:chef|mise)\b|\b(?:we(?:'re| are)|i(?:'m| am))\s+(?:all\s+)?done\s+(?:cooking|here)\b/i.test(
        clean,
      )
    ) {
      appendChatMessage("user", clean);
      return endCooking();
    }

    const chosenPendingTimer = choosePendingTimer(clean);
    if (chosenPendingTimer) {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return dismissTimer(chosenPendingTimer);
    }

    if (/\b(stop|silence|dismiss|cancel)\b.*\b(timer|alarm)\b|\b(timer|alarm)\b.*\b(stop|silence|dismiss|cancel)\b/i.test(clean)) {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      const answer = await stopKitchenTimer();
      return answer;
    }

    const isDonenessQuestion = /\b(do you think|is (?:it|this|that)|does (?:it|this|that)|could (?:it|this|that)|might (?:it|this|that)|maybe|not sure|unsure|how do i know|should (?:it|this|that))\b/i.test(clean);
    const soundsReady = /\b(?:it|this|that|they)\s+(?:looks?|seems?|feels?|is)\s+(?:really\s+)?(?:ready|done|cooked)\b|\b(?:looks?|seems?)\s+(?:really\s+)?(?:ready|done|cooked)\b|\bI(?:'m| am)\s+(?:done|ready)\b/i.test(clean);
    let alreadyAddedUserMessage = false;
    if (!isDonenessQuestion && soundsReady) {
      const ringingTimers = (timers ?? []).filter((timer) => alertingTimerIds[timer._id]);
      const candidates = ringingTimers.length > 0 ? ringingTimers : timers ?? [];
      if (candidates.length === 1) {
        appendChatMessage("user", clean);
        alreadyAddedUserMessage = true;
        await dismissTimer(candidates[0]);
      } else if (candidates.length > 1) {
        appendChatMessage("user", clean);
        return askWhichTimer(candidates);
      }
    }

    const intent = parseKitchenIntent(clean);
    // Fast, unambiguous kitchen commands are handled locally in both text and
    // voice modes. That avoids an extra model/tool round trip for a timer or
    // "I'm done," while real questions still go straight to Chef Mise.
    if (intent.type === "advance" && activeSession) {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return moveToNextStep(false);
    }
    if (intent.type === "next" && activeSession) {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return repeatCurrentStep();
    }
    if (intent.type === "timer") {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return scheduleKitchenTimer(intent.seconds, false);
    }
    if (intent.type === "servings") {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return changeServings(intent.servings, false);
    }
    if (intent.type === "rescue" && activeSession) {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return handleKitchenRescue(clean, intent.response);
    }
    if (intent.type === "remember") {
      suppressLocalActionEcho();
      appendChatMessage("user", clean);
      return rememberPreference(clean, false);
    }

    const placement = /\b(put|placed|set|left|moved|covered)\b[\s\S]{0,50}\b(stove|pan|oven|microwave|fridge|freezer|heat)\b/i.test(clean);
    const expectedTimer = currentStep && currentStep.minutes > 0 ? currentStep.minutes * 60 : 0;
    const alreadyTimingThisStep = (timers ?? []).some(
      (timer) => timer.label.toLowerCase() === `${currentStep?.title ?? ""} timer`.toLowerCase(),
    );
    if (placement && activeSession && expectedTimer && !alreadyTimingThisStep) {
      await scheduleKitchenTimer(expectedTimer, false, `${currentStep?.title ?? "Current step"} timer`);
    }

    sendTextMessage(clean, !alreadyAddedUserMessage);
  }

  async function startListening(restarting = false) {
    if (!TEXT_TEST_MODE || !continuousListening.current || listeningStartInFlight.current || recognizerActive.current) return;
    listeningStartInFlight.current = true;
    try {
      if (!speechPermissionGranted.current) {
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) {
          continuousListening.current = false;
          setMessage("Please allow both Microphone and Speech Recognition for Mise in your iPhone Settings, then try again.");
          return;
        }
        speechPermissionGranted.current = true;
        // iOS needs a short handoff after its first permission sheet closes.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!restarting) {
        lastFinalTranscript.current = { text: "", at: 0 };
        setLiveTranscript("");
      }
      latestInterimTranscript.current = "";
      stopRequestedForTurn.current = false;
      recognizerActive.current = true;
      setIsListening(true);
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        // Mise does its own gentle sentence endpointing below. Continuous mode
        // avoids iOS's long fixed silence timeout between hands-free turns.
        continuous: true,
        maxAlternatives: 1,
        addsPunctuation: true,
        iosTaskHint: "dictation",
        contextualStrings: [
          "Mise",
          "Chef Mise",
          "sous-chef",
          "chicken curry",
          "sushi",
          "egg skillet",
          "vegetarian pasta",
        ],
      });
    } catch {
      recognizerActive.current = false;
      setIsListening(false);
      if (continuousListening.current) {
        queueListeningRestart(700);
      } else {
        setMessage("I couldn’t open the microphone. Check Mise’s microphone access, then start the cook again.");
      }
    } finally {
      listeningStartInFlight.current = false;
    }
  }

  async function beginMiseConversation(initialCook?: {
    recipe: Recipe;
    servings: number;
    stepIndex?: number;
    resume?: boolean;
  }) {
    if (agentStarting || conversation.status !== "disconnected") return;
    setAgentStarting(true);
    setMessage("Opening Chef Mise’s quiet kitchen chat…");
    try {
      const contextRecipe = initialCook?.recipe ?? activeRecipe;
      const contextServings =
        initialCook?.servings ??
        activeSession?.servings ??
        plannedServings ??
        contextRecipe?.baseServings ??
        0;
      const contextStep = initialCook?.recipe.steps[initialCook.stepIndex ?? 0] ?? currentStep;
      const context = initialCook
        ? formatRecipeContext(initialCook.recipe, initialCook.servings, initialCook.stepIndex ?? 0)
        : getCookingContext();
      // Do not blindly discard the first text-chat reply. In Chat Mode the
      // agent may skip its global greeting, making the first reply the cook's
      // real answer. receiveAgentReply already filters the exact idle greeting
      // when there is an active shared cook.
      hideInitialAgentGreeting.current = false;
      const resumeTimerNote = initialCook?.resume
        ? (timers ?? [])
            .map((timer) => `${timer.label} has ${formatTime(timer.status === "paused" ? timer.remainingSeconds ?? 0 : (timer.endsAt - now) / 1000)} left${timer.status === "paused" ? " and is paused" : ""}`)
            .join(". ")
        : "";
      const resumeFirstMessage =
        initialCook?.resume && contextRecipe && contextStep
          ? `Welcome back. We’re continuing ${contextRecipe.title} for ${contextServings}. You’re on step ${(initialCook?.stepIndex ?? 0) + 1}: ${contextStep.title}. ${contextStep.instruction}${resumeTimerNote ? ` Also, ${resumeTimerNote}.` : ""} Tell me when you’re ready for the next move.`
          : undefined;

      if (TEXT_TEST_MODE) {
        // Open the chat as soon as we have its short-lived signed URL. Memory
        // recall is useful context, but it should never make the very first
        // response feel slow.
        const memoryPromise = recallPreferences({
          ownerId: OWNER_ID,
          query: `What food preferences, recipe changes, or cooking habits matter for ${contextRecipe?.title ?? "the next meal"}?`,
        });
        const textSession = await createTextConversationUrl({ userId: OWNER_ID });
        if (!textSession.configured || !textSession.signedUrl) {
          setMessage(textSession.message || "Chef Mise’s private chat is not configured yet.");
          return;
        }

        // The official ElevenLabs client handles the native WebSocket
        // handshake, pings, streamed replies, and client tools for us. With
        // textOnly true it creates TextConversation (not the LiveKit voice
        // transport that caused the earlier disconnect loop).
        conversation.startSession({
          signedUrl: textSession.signedUrl,
          textOnly: true,
          userId: OWNER_ID,
          dynamicVariables: {
            kitchen_context: context,
            recipe_name: contextRecipe?.title ?? "No active recipe",
            current_step: contextStep?.title ?? "No active step",
            servings: contextServings,
            kitchen_memory: "Memory is loading in the background.",
          },
        });
        void memoryPromise
          .then((memory) => {
            if (memory.available && memory.context) queueKitchenMemory(memory.context);
          })
          .catch(() => {
            // The chef can still cook well if a personal-memory lookup is slow.
          });
        return;
      }

      const [agentSession, memory] = await Promise.all([
        createConversationToken({ userId: OWNER_ID }),
        recallPreferences({
          ownerId: OWNER_ID,
          query: `What food preferences, recipe changes, or cooking habits matter for ${contextRecipe?.title ?? "the next meal"}?`,
        }),
      ]);
      if (!agentSession.configured || !agentSession.token) {
        setMessage("Chef Mise’s agent is waiting for its private configuration. The recipe and timer controls still work.");
        return;
      }
      conversation.startSession({
        conversationToken: agentSession.token,
        textOnly: TEXT_TEST_MODE,
        userId: OWNER_ID,
        ...(resumeFirstMessage ? { overrides: { agent: { firstMessage: resumeFirstMessage } } } : {}),
        dynamicVariables: {
          kitchen_context: context,
          recipe_name: contextRecipe?.title ?? "No active recipe",
          current_step: contextStep?.title ?? "No active step",
          servings: contextServings,
          kitchen_memory:
            memory.available && memory.context
              ? memory.context.slice(0, 2400)
              : "No remembered preferences yet.",
        },
      });
    } catch {
      setAgentThinking(false);
      setMessage("Chef Mise couldn’t start the text chat. Check your connection and try again.");
    } finally {
      setAgentStarting(false);
    }
  }

  async function enterCookMode(recipe?: Recipe) {
    setActiveTab("kitchen");
    setIsCookMode(true);
    continuousListening.current = TEXT_TEST_MODE;
    setChatMessages([]);
    fullChatMessages.current = [];
    setLiveTranscript("");

    if (recipe) {
      setSelectedRecipeId(recipe._id);
      setPlannedServings(recipe.baseServings);
      await startCooking(false, recipe, true);
      return;
    }

    if (TEXT_TEST_MODE && agentIsConnected) {
      void startListening();
      return;
    }
    if (TEXT_TEST_MODE) pendingMicStart.current = true;
    void beginMiseConversation();
  }

  const isLoading = recipes === undefined || activeSession === undefined;
  const cookModeActive = isCookMode || Boolean(activeSession);
  const mascotMood = isListening
    ? "listening"
    : agentThinking || agentStarting || agentIsConnecting
      ? "thinking"
      : "ready";

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <LinearGradient colors={["#101B18", "#132824", "#0D1513"]} style={styles.background}>
        <View style={styles.appShell}>
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>YOUR KITCHEN, IN FLOW</Text>
              <Text style={styles.logo}>mise</Text>
            </View>
            {!cookModeActive ? (
              <View style={styles.memoryPill}>
                <Text style={styles.memoryDot}>●</Text>
                <Text style={styles.memoryText}>remembers you</Text>
              </View>
            ) : null}
          </View>

          {isLoading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color="#E7B95A" />
              <Text style={styles.loadingText}>Setting your kitchen up…</Text>
            </View>
          ) : (
            <View style={styles.tabStage}>
              {activeTab === "kitchen" ? (
                cookModeActive ? (
                  <ChefConversation
                    messages={chatMessages}
                    streamingText={streamingAgentText}
                    isListening={isListening}
                    liveTranscript={liveTranscript}
                    isThinking={agentThinking || agentStarting || agentIsConnecting}
                    message={message}
                    mood={mascotMood}
                    isPaused={isCookPaused}
                    busy={busy}
                    photoChecking={photoChecking}
                    onPause={() => void pauseCooking()}
                    onStop={confirmStopCooking}
                    onShowPhoto={promptKitchenPhoto}
                    showVoiceControl={!TEXT_TEST_MODE}
                    isVoiceMuted={conversation.isMuted}
                    onToggleVoiceMute={() => conversation.setMuted(!conversation.isMuted)}
                    typedCommand={typedCommand}
                    onChangeTypedCommand={setTypedCommand}
                    onSendTypedCommand={() => {
                      const command = typedCommand.trim();
                      if (!command) return;
                      setTypedCommand("");
                      void handleKitchenCommand(command);
                    }}
                  />
                ) : (
                  <KitchenWelcome
                    mood={mascotMood}
                  />
                )
              ) : (
                  <RecipeBox
                    recipes={displayRecipes}
                    busy={busy}
                    onSaveRecipe={saveManualRecipe}
                  />
              )}
            </View>
          )}

          <KitchenTabs activeTab={activeTab} onChange={setActiveTab} />
        </View>
      </LinearGradient>
    </SafeAreaView>
  );
}

function ChefMiseMascot({ mood }: { mood: "ready" | "thinking" | "listening" }) {
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: mood === "thinking" ? 900 : 1600, useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: mood === "thinking" ? 900 : 1600, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [bob, mood]);

  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -8] });
  const scale = bob.interpolate({ inputRange: [0, 1], outputRange: [1, mood === "listening" ? 1.025 : 1.012] });
  const status = mood === "listening" ? "listening" : mood === "thinking" ? "thinking" : "ready";
  return (
    <View style={styles.mascotCard}>
      <View style={styles.mascotGlow} />
      <Animated.View style={[styles.mascotImageWrap, { transform: [{ translateY }, { scale }] }]}>
        <Image source={require("./assets/chef-mise.png")} resizeMode="contain" style={styles.mascotImage} />
      </Animated.View>
      <View style={styles.mascotCopy}>
        <Text style={styles.mascotEyebrow}>MEET YOUR SOUS-CHEF</Text>
        <Text style={styles.mascotName}>Chef Mise</Text>
        <View style={styles.mascotStatusRow}>
          <View style={[styles.mascotStatusDot, mood === "listening" && styles.mascotStatusDotListening]} />
          <Text style={styles.mascotStatus}>{status}</Text>
        </View>
      </View>
    </View>
  );
}

function KitchenWelcome({
  mood,
}: {
  mood: "ready" | "thinking" | "listening";
}) {
  return (
    <ScrollView contentContainerStyle={styles.welcomeContent} showsVerticalScrollIndicator={false}>
      <ChefMiseMascot mood={mood} />
      <View style={styles.welcomeCopy}>
        <Text style={styles.welcomeTitle}>Your chef is ready.</Text>
        <Text style={styles.welcomeText}>
          Start your dish in VoiceOS. The moment it creates the shared cook, Chef Mise will load it here and guide you step by step.
        </Text>
      </View>
      <View style={styles.waitingForVoiceOsCard}>
        <Text style={styles.waitingForVoiceOsEyebrow}>WAITING FOR VOICEOS</Text>
        <Text style={styles.waitingForVoiceOsText}>Say “Let’s get cooking” in VoiceOS, then come back here. Chef Mise will automatically join the live cook.</Text>
      </View>
      <Text style={styles.welcomeHint}>Voice replies are on. Chef Mise listens, speaks back, and keeps the conversation visible.</Text>
    </ScrollView>
  );
}

function ChefConversation({
  messages,
  streamingText,
  isListening,
  liveTranscript,
  isThinking,
  message,
  mood,
  isPaused,
  busy,
  photoChecking,
  onPause,
  onStop,
  onShowPhoto,
  showVoiceControl,
  isVoiceMuted,
  onToggleVoiceMute,
  typedCommand,
  onChangeTypedCommand,
  onSendTypedCommand,
}: {
  messages: ChatMessage[];
  streamingText: string;
  isListening: boolean;
  liveTranscript: string;
  isThinking: boolean;
  message: string;
  mood: "ready" | "thinking" | "listening";
  isPaused: boolean;
  busy: boolean;
  photoChecking: boolean;
  onPause: () => void;
  onStop: () => void;
  onShowPhoto: () => void;
  showVoiceControl: boolean;
  isVoiceMuted: boolean;
  onToggleVoiceMute: () => void;
  typedCommand: string;
  onChangeTypedCommand: (value: string) => void;
  onSendTypedCommand: () => void;
}) {
  const recentMessages = messages.slice(-6);
  const status = isPaused ? "Paused" : isListening ? "Listening" : isThinking ? "Thinking" : "Here with you";
  const transcript = isPaused
    ? "Cook paused. Your kitchen timers are still watching the clock."
    : isListening
    ? liveTranscript || "Listening for your next kitchen move…"
    : isThinking
      ? "Chef Mise is thinking…"
      : message || "Chef Mise is ready.";

  return (
    <View style={styles.conversationPage}>
      <View style={styles.conversationChefBar}>
        <View style={[styles.conversationChefAvatar, mood === "listening" && styles.conversationChefAvatarListening]}>
          <Image source={require("./assets/chef-mise.png")} resizeMode="contain" style={styles.conversationChefImage} />
        </View>
        <View style={styles.conversationChefCopy}>
          <Text style={styles.conversationChefName}>Chef Mise</Text>
          <Text style={styles.conversationChefStatus}>● {status}</Text>
        </View>
        {showVoiceControl ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isVoiceMuted ? "Turn Chef Mise microphone on" : "Mute Chef Mise microphone"}
            accessibilityState={{ checked: isVoiceMuted }}
            onPress={onToggleVoiceMute}
            style={({ pressed }) => [
              styles.voiceMuteButton,
              isVoiceMuted && styles.voiceMuteButtonMuted,
              pressed && styles.voiceMuteButtonPressed,
            ]}
          >
            <Text style={[styles.voiceMuteButtonText, isVoiceMuted && styles.voiceMuteButtonTextMuted]}>
              {isVoiceMuted ? "MIC OFF" : "MIC"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.conversationFeed}>
        <ScrollView contentContainerStyle={styles.conversationFeedContent} showsVerticalScrollIndicator={false}>
          {recentMessages.length === 0 ? (
            <View style={[styles.conversationBubble, styles.conversationChefBubble]}>
              <View style={styles.bubbleSpeakerRow}>
                <Text style={styles.bubbleSpeaker}>CHEF MISE</Text>
              </View>
              <Text style={styles.conversationChefText}>I’m right here, chef. What are we making today?</Text>
            </View>
          ) : null}
          {recentMessages.map((chatMessage) => (
            <View
              key={chatMessage.id}
              style={[
                styles.conversationBubble,
                chatMessage.role === "user" ? styles.conversationUserBubble : styles.conversationChefBubble,
              ]}
            >
              <Text style={[styles.bubbleSpeaker, chatMessage.role === "user" ? styles.userBubbleLabel : styles.agentBubbleLabel]}>
                {chatMessage.role === "user" ? "YOU" : "CHEF MISE"}
              </Text>
              <Text style={[styles.conversationBubbleText, chatMessage.role === "user" ? styles.userBubbleText : styles.agentBubbleText]}>
                {chatMessage.text}
              </Text>
            </View>
          ))}
          {streamingText ? (
            <View style={[styles.conversationBubble, styles.conversationChefBubble]}>
              <Text style={[styles.bubbleSpeaker, styles.agentBubbleLabel]}>CHEF MISE</Text>
              <Text style={[styles.conversationBubbleText, styles.agentBubbleText]}>{streamingText}</Text>
            </View>
          ) : isThinking ? (
            <View style={[styles.conversationBubble, styles.conversationChefBubble, styles.thinkingBubble]}>
              <Text style={[styles.bubbleSpeaker, styles.agentBubbleLabel]}>CHEF MISE</Text>
              <Text style={[styles.conversationBubbleText, styles.agentBubbleText]}>Thinking through the next best move…</Text>
            </View>
          ) : null}
        </ScrollView>
      </View>

      <View style={styles.liveTranscriptTray}>
        <View style={[styles.liveTranscriptDot, isListening && styles.liveTranscriptDotListening]} />
        <Text numberOfLines={2} style={styles.liveTranscriptText}>{transcript}</Text>
      </View>

      <View style={styles.commandInputRow}>
        <TextInput
          value={typedCommand}
          onChangeText={onChangeTypedCommand}
          onSubmitEditing={onSendTypedCommand}
          placeholder="Ask Chef Mise anything…"
          placeholderTextColor="#78948A"
          returnKeyType="send"
          style={styles.commandInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message to Chef Mise"
          disabled={!typedCommand.trim() || busy || isPaused}
          onPress={onSendTypedCommand}
          style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed, (!typedCommand.trim() || busy || isPaused) && styles.disabled]}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show Chef Mise a cooking photo"
        disabled={busy || photoChecking || isPaused}
        onPress={onShowPhoto}
        style={({ pressed }) => [
          styles.photoChefButton,
          pressed && styles.primaryButtonPressed,
          (busy || photoChecking || isPaused) && styles.disabled,
        ]}
      >
        <Text style={styles.photoChefIcon}>◉</Text>
        <View style={styles.photoChefCopy}>
          <Text style={styles.photoChefTitle}>{photoChecking ? "Chef Mise is looking…" : "Show Chef Mise"}</Text>
          <Text style={styles.photoChefHint}>Send a photo if you’re unsure how something looks.</Text>
        </View>
        <Text style={styles.photoChefArrow}>›</Text>
      </Pressable>

      <View style={styles.conversationControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isPaused ? "Resume cook" : "Pause cook"}
          disabled={busy}
          onPress={onPause}
          style={({ pressed }) => [styles.pauseCookButton, pressed && styles.stopCookButtonPressed, busy && styles.disabled]}
        >
          <Text style={styles.pauseCookText}>{isPaused ? "Resume cook" : "Pause cook"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop cook"
          disabled={busy}
          onPress={onStop}
          style={({ pressed }) => [styles.conversationStopButton, pressed && styles.stopCookButtonPressed, busy && styles.disabled]}
        >
          <Text style={styles.conversationStopText}>{busy ? "Stopping…" : "Stop cook"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecipeBox({
  recipes,
  busy,
  onSaveRecipe,
}: {
  recipes: Recipe[];
  busy: boolean;
  onSaveRecipe: (draft: ManualRecipeDraft) => Promise<string>;
}) {
  const [openRecipeId, setOpenRecipeId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const [draft, setDraft] = useState<ManualRecipeDraft>({
    title: "",
    servings: "2",
    ingredients: "",
    steps: "",
    notes: "",
  });

  const updateDraft = (field: keyof ManualRecipeDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  async function saveDraft() {
    setSaving(true);
    const result = await onSaveRecipe(draft);
    setFormMessage(result);
    setSaving(false);
    if (result.endsWith("recipe box.")) {
      setDraft({ title: "", servings: "2", ingredients: "", steps: "", notes: "" });
      setIsAdding(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.recipeBoxContent} showsVerticalScrollIndicator={false}>
      <View style={styles.recipeBoxHeading}>
        <View style={styles.recipeBoxHeadingCopy}>
          <Text style={styles.recipeBoxTitle}>Recipe box</Text>
          <Text style={styles.recipeBoxSubtitle}>Tap a dish for its ingredients and prep.</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a recipe"
          onPress={() => {
            setIsAdding((open) => !open);
            setFormMessage("");
          }}
          style={({ pressed }) => [styles.addRecipeButton, pressed && styles.primaryButtonPressed]}
        >
          <Text style={styles.addRecipeButtonText}>{isAdding ? "Close" : "+ Add"}</Text>
        </Pressable>
      </View>

      {isAdding ? (
        <View style={styles.manualRecipeForm}>
          <Text style={styles.manualRecipeTitle}>Add your own recipe</Text>
          <Text style={styles.manualRecipeHint}>Keep it quick—one ingredient and one step per line.</Text>
          <TextInput
            value={draft.title}
            onChangeText={(value) => updateDraft("title", value)}
            placeholder="Recipe name"
            placeholderTextColor="#78948A"
            style={styles.recipeInput}
          />
          <TextInput
            value={draft.servings}
            onChangeText={(value) => updateDraft("servings", value)}
            placeholder="Servings"
            placeholderTextColor="#78948A"
            keyboardType="number-pad"
            style={styles.recipeInput}
          />
          <TextInput
            value={draft.ingredients}
            onChangeText={(value) => updateDraft("ingredients", value)}
            placeholder={'Ingredients, one per line\nExample: 2 cups pasta\n1 tbsp olive oil'}
            placeholderTextColor="#78948A"
            multiline
            textAlignVertical="top"
            style={[styles.recipeInput, styles.recipeTextArea]}
          />
          <TextInput
            value={draft.steps}
            onChangeText={(value) => updateDraft("steps", value)}
            placeholder={'Preparation, one step per line\nBoil the pasta until tender\nToss with the sauce'}
            placeholderTextColor="#78948A"
            multiline
            textAlignVertical="top"
            style={[styles.recipeInput, styles.recipeTextArea]}
          />
          <TextInput
            value={draft.notes}
            onChangeText={(value) => updateDraft("notes", value)}
            placeholder="Optional notes"
            placeholderTextColor="#78948A"
            multiline
            textAlignVertical="top"
            style={[styles.recipeInput, styles.recipeNotesInput]}
          />
          {formMessage ? <Text style={styles.manualRecipeMessage}>{formMessage}</Text> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save recipe"
            disabled={busy || saving}
            onPress={() => void saveDraft()}
            style={({ pressed }) => [styles.manualRecipeSave, pressed && styles.primaryButtonPressed, (busy || saving) && styles.disabled]}
          >
            <Text style={styles.manualRecipeSaveText}>{saving ? "Saving…" : "Save recipe"}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.recipeBoxList}>
        {recipes.map((recipe) => {
          const isOpen = openRecipeId === recipe._id;
          return (
            <View key={recipe._id} style={[styles.recipeBoxCard, isOpen && styles.recipeBoxCardOpen]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${isOpen ? "Hide" : "Show"} details for ${recipe.title}`}
                onPress={() => setOpenRecipeId((current) => (current === recipe._id ? null : recipe._id))}
                style={({ pressed }) => [styles.recipeBoxCardHeader, pressed && styles.recipeBoxCardPressed]}
              >
                <Text style={styles.recipeBoxEmoji}>{recipe.emoji}</Text>
                <View style={styles.recipeBoxCardCopy}>
                  <Text numberOfLines={2} style={styles.recipeBoxCardTitle}>{recipe.title}</Text>
                  <Text numberOfLines={2} style={styles.recipeBoxCardMeta}>
                    {recipe.prepMinutes + recipe.cookMinutes} min · {recipe.baseServings} servings · {isOpen ? "Hide details" : "View details"}
                  </Text>
                </View>
                <Text style={styles.recipeBoxChevron}>{isOpen ? "−" : "+"}</Text>
              </Pressable>

              {isOpen ? (
                <View style={styles.recipeDetail}>
                  <Text style={styles.recipeDetailDescription}>{recipe.description}</Text>
                  <Text style={styles.recipeDetailLabel}>INGREDIENTS · {recipe.baseServings} SERVINGS</Text>
                  {recipe.ingredients.map((ingredient, index) => (
                    <Text key={`${ingredient.name}-${index}`} style={styles.recipeDetailRow}>
                      <Text style={styles.recipeDetailAmount}>{ingredient.quantity} {ingredient.unit}</Text> {ingredient.name}
                    </Text>
                  ))}
                  <Text style={styles.recipeDetailLabel}>PREPARATION</Text>
                  {recipe.steps.map((step, index) => (
                    <View key={`${step.title}-${index}`} style={styles.recipeDetailStep}>
                      <Text style={styles.recipeDetailStepNumber}>{index + 1}</Text>
                      <View style={styles.recipeDetailStepCopy}>
                        <Text style={styles.recipeDetailStepTitle}>{step.title} · {step.minutes} min</Text>
                        <Text style={styles.recipeDetailStepText}>{step.instruction}</Text>
                      </View>
                    </View>
                  ))}
                  {recipe.notes ? <Text style={styles.recipeDetailNotes}>Chef’s note: {recipe.notes}</Text> : null}
                </View>
              ) : null}
              <Text style={styles.recipeBoxVoiceOsHint}>Start this from VoiceOS when you’re ready.</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function KitchenTabs({ activeTab, onChange }: { activeTab: AppTab; onChange: (tab: AppTab) => void }) {
  return (
    <View style={styles.tabBar}>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: activeTab === "kitchen" }}
        onPress={() => onChange("kitchen")}
        style={[styles.tabButton, activeTab === "kitchen" && styles.tabButtonActive]}
      >
        <Text style={[styles.tabIcon, activeTab === "kitchen" && styles.tabTextActive]}>✦</Text>
        <Text style={[styles.tabText, activeTab === "kitchen" && styles.tabTextActive]}>Kitchen</Text>
      </Pressable>
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: activeTab === "recipes" }}
        onPress={() => onChange("recipes")}
        style={[styles.tabButton, activeTab === "recipes" && styles.tabButtonActive]}
      >
        <Text style={[styles.tabIcon, activeTab === "recipes" && styles.tabTextActive]}>☷</Text>
        <Text style={[styles.tabText, activeTab === "recipes" && styles.tabTextActive]}>Recipes</Text>
      </Pressable>
    </View>
  );
}

function StartView({
  recipes,
  selectedRecipe,
  plannedServings,
  busy,
  onSelect,
  onServings,
  onStart,
}: {
  recipes: Recipe[];
  selectedRecipe?: Recipe;
  plannedServings: number;
  busy: boolean;
  onSelect: (recipe: Recipe) => void;
  onServings: (servings: number) => void;
  onStart: () => void;
}) {
  if (!selectedRecipe) return null;
  return (
    <View>
      <View style={styles.sectionHeading}>
        <Text style={styles.commandTitle}>Pick a dish</Text>
        <Text style={styles.transcriptHint}>{recipes.length} saved recipes</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recipePicker}>
        {recipes.map((recipe) => {
          const selected = recipe._id === selectedRecipe._id;
          return (
            <Pressable
              key={recipe._id}
              onPress={() => onSelect(recipe)}
              style={({ pressed }) => [styles.recipeMiniCard, selected && styles.recipeMiniCardSelected, pressed && styles.recipeMiniCardPressed]}
            >
              <Text style={styles.recipeMiniEmoji}>{recipe.emoji}</Text>
              <Text numberOfLines={2} style={styles.recipeMiniTitle}>{recipe.title}</Text>
              <Text style={styles.recipeMiniMeta}>{recipe.prepMinutes + recipe.cookMinutes} min</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.recipeCard}>
        <View style={styles.recipeTopline}>
          <Text style={styles.recipeEmoji}>{selectedRecipe.emoji}</Text>
          <Text style={styles.recipeTag}>{selectedRecipe.cuisine}</Text>
        </View>
        <Text style={styles.recipeTitle}>{selectedRecipe.title}</Text>
        <Text style={styles.recipeDescription}>{selectedRecipe.description}</Text>
        <View style={styles.recipeMeta}>
          <Text style={styles.metaText}>◷ {selectedRecipe.prepMinutes + selectedRecipe.cookMinutes} min</Text>
          <Text style={styles.metaText}>◉ makes {plannedServings} servings</Text>
          <Text style={styles.metaText}>{selectedRecipe.steps.length} steps</Text>
        </View>
        <View style={styles.startServingRow}>
          <Text style={styles.startServingLabel}>HOW MANY ARE WE FEEDING?</Text>
          <View style={styles.startServingControls}>
            <Pressable disabled={plannedServings <= 1} onPress={() => onServings(plannedServings - 1)} style={({ pressed }) => [styles.startServingButton, pressed && styles.scaleButtonPressed, plannedServings <= 1 && styles.disabled]}>
              <Text style={styles.startServingButtonText}>−</Text>
            </Pressable>
            <Text style={styles.startServingValue}>{plannedServings}</Text>
            <Pressable disabled={plannedServings >= 12} onPress={() => onServings(plannedServings + 1)} style={({ pressed }) => [styles.startServingButton, pressed && styles.scaleButtonPressed, plannedServings >= 12 && styles.disabled]}>
              <Text style={styles.startServingButtonText}>+</Text>
            </Pressable>
          </View>
        </View>
        <Pressable
          onPress={onStart}
          disabled={busy}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, busy && styles.disabled]}
        >
          <Text style={styles.primaryButtonText}>{busy ? "Starting…" : "Start cook"}</Text>
          <Text style={styles.primaryButtonArrow}>→</Text>
        </Pressable>
        <Text style={styles.recipeNote}>Tap Start cook and Chef Mise starts listening right away. It will guide one step at a time and keep the replies on screen.</Text>
      </View>
    </View>
  );
}

function CookingView({
  recipe,
  currentStep,
  currentStepIndex,
  servings,
  timers,
  now,
  alertingTimerIds,
  busy,
  onNext,
  onServings,
  onStopTimer,
  onStopCook,
}: {
  recipe: Recipe;
  currentStep: Recipe["steps"][number];
  currentStepIndex: number;
  servings: number;
  timers: KitchenTimer[];
  now: number;
  alertingTimerIds: Record<string, true>;
  busy: boolean;
  onNext: () => void;
  onServings: (servings: number) => void;
  onStopTimer: (timer: KitchenTimer) => void;
  onStopCook: () => void;
}) {
  return (
    <View>
      <View style={styles.progressRow}>
        <Text style={styles.progressLabel}>COOKING NOW</Text>
        <Text style={styles.progressValue}>STEP {currentStepIndex + 1} / {recipe.steps.length}</Text>
      </View>
      <View style={styles.stepCard}>
        <Text style={styles.stepHeat}>{currentStep.heat.toUpperCase()} HEAT</Text>
        <Text style={styles.stepTitle}>{currentStep.title}</Text>
        <Text style={styles.stepInstruction}>{currentStep.instruction}</Text>
        <View style={styles.tipBox}>
          <Text style={styles.tipIcon}>✦</Text>
          <Text style={styles.tipText}>{currentStep.tip}</Text>
        </View>
        {currentStep.minutes > 0 ? (
          <Text style={styles.stepTimerHint}>When this goes on the heat, say “I put it on the stove” and Chef Mise will start the {currentStep.minutes}-minute timer.</Text>
        ) : null}
        <Pressable disabled={busy} onPress={onNext} style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, busy && styles.disabled]}>
          <Text style={styles.primaryButtonText}>Done — next step</Text>
          <Text style={styles.primaryButtonArrow}>→</Text>
        </Pressable>
        <Pressable disabled={busy} onPress={onStopCook} style={({ pressed }) => [styles.stopCookButton, pressed && styles.stopCookButtonPressed, busy && styles.disabled]}>
          <Text style={styles.stopCookButtonText}>Stop cook</Text>
        </Pressable>
      </View>

      <View style={styles.scaleCard}>
        <View>
          <Text style={styles.scaleLabel}>SCALE THE RECIPE</Text>
          <Text style={styles.scaleValue}>{servings} servings</Text>
        </View>
        <View style={styles.scaleButtons}>
          <Pressable disabled={servings <= 1} onPress={() => onServings(servings - 1)} style={({ pressed }) => [styles.scaleButton, pressed && styles.scaleButtonPressed, servings <= 1 && styles.disabled]}>
            <Text style={styles.scaleButtonText}>−</Text>
          </Pressable>
          <Pressable disabled={servings >= 12} onPress={() => onServings(servings + 1)} style={({ pressed }) => [styles.scaleButton, pressed && styles.scaleButtonPressed, servings >= 12 && styles.disabled]}>
            <Text style={styles.scaleButtonText}>+</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.ingredientsSection}>
        <Text style={styles.ingredientsTitle}>INGREDIENTS FOR THIS COOK</Text>
        <View style={styles.ingredientRow}>
          {recipe.ingredients.slice(0, 3).map((ingredient) => (
            <View key={ingredient.name} style={styles.ingredientPill}>
              <Text style={styles.ingredientAmount}>{scaledQuantity(ingredient.quantity, recipe.baseServings, servings)} {ingredient.unit}</Text>
              <Text style={styles.ingredientName}>{ingredient.name}</Text>
            </View>
          ))}
        </View>
        {recipe.ingredients.length > 3 ? <Text style={styles.moreIngredients}>+ {recipe.ingredients.length - 3} more ingredients — ask Chef Mise for the full list</Text> : null}
      </View>

      {timers.length > 0 ? (
        <View style={styles.timers}>
          {timers.map((timer) => {
            const alerting = Boolean(alertingTimerIds[timer._id]);
            const remainingSeconds = timer.status === "paused"
              ? timer.remainingSeconds ?? 0
              : (timer.endsAt - now) / 1000;
            return (
              <View key={timer._id} style={[styles.timerCard, alerting && styles.timerCardAlerting]}>
                <View>
                  <Text style={styles.timerLabel}>{alerting ? "TIMER RINGING · " : timer.status === "paused" ? "TIMER PAUSED · " : ""}{timer.label}</Text>
                  <Text style={styles.timerValue}>{alerting ? "00:00" : formatTime(remainingSeconds)}</Text>
                </View>
                <Pressable onPress={() => onStopTimer(timer)} style={({ pressed }) => [styles.timerStopButton, pressed && styles.timerStopButtonPressed]}>
                  <Text style={styles.timerStopText}>{alerting ? "Stop" : "Cancel"}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function normalizeIngredients(raw?: RawIngredient[] | string) {
  const source = typeof raw === "string" ? raw.split(/[;\n,]+/) : raw ?? [];
  return source
    .map((ingredient) => {
      if (typeof ingredient === "string") {
        const match = ingredient.trim().match(/^([\d.]+)?\s*([^\d\s]+)?\s*(.+)$/);
        return {
          quantity: Number(match?.[1]) || 1,
          unit: match?.[2] || "portion",
          name: match?.[3]?.trim() || ingredient.trim(),
        };
      }
      return {
        name: String(ingredient.name ?? "").trim(),
        quantity: Math.max(0.1, Number(ingredient.quantity) || 1),
        unit: String(ingredient.unit ?? "portion").trim() || "portion",
      };
    })
    .filter((ingredient) => ingredient.name)
    .slice(0, 30);
}

function defaultCustomStep(title: string) {
  return {
    title: "Cook and capture",
    instruction: `Cook ${title} as described with Chef Mise, adding any useful detail to the recipe as you go.`,
    minutes: 15,
    heat: "medium",
    tip: "Tell Chef Mise when the dish changes texture, colour, or timing so it can improve this saved version.",
  };
}

function normalizeSteps(raw?: RawStep[] | string) {
  const source = typeof raw === "string" ? raw.split(/[;\n]+/) : raw ?? [];
  return source
    .map((step, index) => {
      if (typeof step === "string") {
        const instruction = step.trim();
        return {
          title: `Step ${index + 1}`,
          instruction,
          minutes: 5,
          heat: "medium",
          tip: "Adjust the heat if the pan starts catching.",
        };
      }
      const instruction = String(step.instruction ?? "").trim();
      return {
        title: String(step.title ?? `Step ${index + 1}`).trim() || `Step ${index + 1}`,
        instruction,
        minutes: Math.max(0, Math.min(180, Number(step.minutes) || 5)),
        heat: String(step.heat ?? "medium").trim() || "medium",
        tip: String(step.tip ?? "Tell Chef Mise when this step is done.").trim(),
      };
    })
    .filter((step) => step.instruction)
    .slice(0, 20);
}

async function scheduleLocalNotification(seconds: number, label: string) {
  try {
    const current = await Notifications.getPermissionsAsync();
    const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
    if (!permission.granted) return undefined;
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: "Mise timer",
        body: `${label} is ready for you. Open Mise to stop the alarm.`,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(1, seconds),
      },
    });
  } catch {
    return undefined;
  }
}

export default function App() {
  return (
    <ConvexClientProvider>
      <ConversationProvider>
        <MiseKitchen />
      </ConversationProvider>
    </ConvexClientProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#101B18" },
  background: { flex: 1 },
  scrollContent: { padding: 22, paddingBottom: 38 },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 12 },
  eyebrow: { color: "#9DB4AA", fontSize: 10, fontWeight: "700", letterSpacing: 1.7, marginBottom: 4 },
  logo: { color: "#F5F1E7", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 42, letterSpacing: -1.5 },
  memoryPill: { alignItems: "center", backgroundColor: "#1E3D35", borderColor: "#4B786A", borderRadius: 20, borderWidth: 1, flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 7 },
  memoryDot: { color: "#8EDEAF", fontSize: 10 },
  memoryText: { color: "#C5E8D3", fontSize: 11, fontWeight: "700" },
  mascotCard: { backgroundColor: "#18352D", borderColor: "#496F60", borderRadius: 26, borderWidth: 1, height: 210, marginBottom: 20, overflow: "hidden", position: "relative" },
  mascotGlow: { backgroundColor: "#E7B95A", borderRadius: 140, height: 200, opacity: 0.12, position: "absolute", right: -54, top: -72, width: 200 },
  mascotImageWrap: { bottom: -39, height: 250, left: -5, position: "absolute", width: 205 },
  mascotImage: { height: "100%", width: "100%" },
  mascotCopy: { bottom: 23, left: 178, position: "absolute", right: 16 },
  mascotEyebrow: { color: "#AAC3B7", fontSize: 9, fontWeight: "800", letterSpacing: 1.1 },
  mascotName: { color: "#F5F1E7", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 28, marginTop: 6 },
  mascotStatusRow: { alignItems: "center", flexDirection: "row", gap: 6, marginTop: 8 },
  mascotStatusDot: { backgroundColor: "#8EDEAF", borderRadius: 5, height: 8, width: 8 },
  mascotStatusDotListening: { backgroundColor: "#F2C765", shadowColor: "#F2C765", shadowOpacity: 0.9, shadowRadius: 7 },
  mascotStatus: { color: "#CFE1D7", fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  loadingState: { alignItems: "center", minHeight: 270, justifyContent: "center" },
  loadingText: { color: "#C3D3CB", marginTop: 12 },
  sectionHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  recipePicker: { gap: 10, paddingRight: 22 },
  recipeMiniCard: { backgroundColor: "#19352C", borderColor: "#45695D", borderRadius: 17, borderWidth: 1, height: 137, justifyContent: "space-between", padding: 13, width: 122 },
  recipeMiniCardSelected: { backgroundColor: "#2B5144", borderColor: "#E7B95A", borderWidth: 2 },
  recipeMiniCardPressed: { opacity: 0.86, transform: [{ scale: 0.98 }] },
  recipeMiniEmoji: { fontSize: 25 },
  recipeMiniTitle: { color: "#F5F1E7", fontSize: 13, fontWeight: "800", lineHeight: 17, marginTop: 5 },
  recipeMiniMeta: { color: "#B2C7BD", fontSize: 11, fontWeight: "700" },
  recipeCard: { backgroundColor: "#F4E5C5", borderRadius: 28, marginTop: 14, padding: 24 },
  recipeTopline: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  recipeEmoji: { fontSize: 44 },
  recipeTag: { backgroundColor: "#E9C879", borderRadius: 20, color: "#5A3B13", fontSize: 11, fontWeight: "800", overflow: "hidden", paddingHorizontal: 10, paddingVertical: 6, textTransform: "uppercase" },
  recipeTitle: { color: "#19241E", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 32, lineHeight: 37, marginTop: 18 },
  recipeDescription: { color: "#526057", fontSize: 15, lineHeight: 22, marginTop: 8 },
  recipeMeta: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 20 },
  metaText: { color: "#526057", fontSize: 12, fontWeight: "700" },
  startServingRow: { alignItems: "center", backgroundColor: "#EAD7A9", borderRadius: 14, flexDirection: "row", justifyContent: "space-between", marginTop: 17, paddingHorizontal: 12, paddingVertical: 10 },
  startServingLabel: { color: "#685638", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  startServingControls: { alignItems: "center", flexDirection: "row", gap: 10 },
  startServingButton: { alignItems: "center", backgroundColor: "#FFF5DD", borderRadius: 11, height: 28, justifyContent: "center", width: 28 },
  startServingButtonText: { color: "#6C4725", fontSize: 18, fontWeight: "700" },
  startServingValue: { color: "#2D392F", fontSize: 16, fontVariant: ["tabular-nums"], fontWeight: "900", minWidth: 16, textAlign: "center" },
  primaryButton: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 16, flexDirection: "row", justifyContent: "space-between", marginTop: 24, paddingHorizontal: 18, paddingVertical: 16 },
  primaryButtonPressed: { opacity: 0.84, transform: [{ scale: 0.985 }] },
  primaryButtonText: { color: "#FFF9EC", fontSize: 16, fontWeight: "800" },
  primaryButtonArrow: { color: "#FFF9EC", fontSize: 24, fontWeight: "500" },
  disabled: { opacity: 0.55 },
  recipeNote: { color: "#68776D", fontSize: 12, lineHeight: 18, marginTop: 15 },
  progressRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  progressLabel: { color: "#A8C5B9", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  progressValue: { color: "#E6BC64", fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  stepCard: { backgroundColor: "#1D362F", borderColor: "#547D6D", borderRadius: 27, borderWidth: 1, padding: 23 },
  stepHeat: { color: "#E7B95A", fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  stepTitle: { color: "#F6F2E8", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 31, lineHeight: 37, marginTop: 9 },
  stepInstruction: { color: "#D1DED7", fontSize: 16, lineHeight: 24, marginTop: 12 },
  tipBox: { backgroundColor: "#274B40", borderRadius: 14, flexDirection: "row", gap: 8, marginTop: 18, padding: 13 },
  tipIcon: { color: "#E7B95A", fontSize: 13 },
  tipText: { color: "#CBE2D7", flex: 1, fontSize: 13, lineHeight: 18 },
  stepTimerHint: { color: "#AFC8BC", fontSize: 12, lineHeight: 17, marginTop: 15 },
  stopCookButton: { alignItems: "center", borderColor: "#708D81", borderRadius: 14, borderWidth: 1, marginTop: 10, paddingVertical: 12 },
  stopCookButtonPressed: { backgroundColor: "#29473D" },
  stopCookButtonText: { color: "#D7E4DD", fontSize: 14, fontWeight: "800" },
  scaleCard: { alignItems: "center", backgroundColor: "#173029", borderColor: "#45695D", borderRadius: 18, borderWidth: 1, flexDirection: "row", justifyContent: "space-between", marginTop: 16, padding: 16 },
  scaleLabel: { color: "#8EACA1", fontSize: 10, fontWeight: "800", letterSpacing: 1.1 },
  scaleValue: { color: "#F5F1E7", fontSize: 18, fontWeight: "700", marginTop: 4 },
  scaleButtons: { flexDirection: "row", gap: 9 },
  scaleButton: { alignItems: "center", backgroundColor: "#2E5549", borderRadius: 15, height: 42, justifyContent: "center", width: 42 },
  scaleButtonPressed: { backgroundColor: "#3A6B5A" },
  scaleButtonText: { color: "#F5F1E7", fontSize: 22, fontWeight: "500" },
  ingredientsSection: { marginTop: 12 },
  ingredientsTitle: { color: "#9BB5A9", fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 8 },
  ingredientRow: { flexDirection: "row", gap: 8 },
  ingredientPill: { backgroundColor: "#183229", borderColor: "#3D6557", borderRadius: 13, borderWidth: 1, flex: 1, minHeight: 71, padding: 10 },
  ingredientAmount: { color: "#E7B95A", fontSize: 12, fontWeight: "800" },
  ingredientName: { color: "#C7D7CF", fontSize: 11, lineHeight: 15, marginTop: 5 },
  moreIngredients: { color: "#90AA9F", fontSize: 11, marginTop: 8 },
  timers: { gap: 8, marginTop: 12 },
  timerCard: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 14, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  timerCardAlerting: { backgroundColor: "#B54D37", borderColor: "#FFD088", borderWidth: 1 },
  timerLabel: { color: "#FFF6E6", fontSize: 12, fontWeight: "800" },
  timerValue: { color: "#FFF6E6", fontSize: 22, fontVariant: ["tabular-nums"], fontWeight: "800", marginTop: 2 },
  timerStopButton: { backgroundColor: "#FFF4DE", borderRadius: 11, paddingHorizontal: 13, paddingVertical: 9 },
  timerStopButtonPressed: { opacity: 0.76 },
  timerStopText: { color: "#71321F", fontSize: 12, fontWeight: "900" },
  coachCard: { backgroundColor: "#FAF7EE", borderRadius: 19, marginTop: 18, padding: 17 },
  coachHeader: { alignItems: "center", flexDirection: "row", gap: 8 },
  coachAvatar: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 12, height: 25, justifyContent: "center", width: 25 },
  coachAvatarText: { color: "#FFF9EC", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 15, fontWeight: "800" },
  coachLabel: { color: "#A96837", fontSize: 10, fontWeight: "800", letterSpacing: 1.35 },
  coachMessage: { color: "#26352E", fontSize: 15, lineHeight: 22, marginTop: 8 },
  chatButton: { alignItems: "center", backgroundColor: "#1B352D", borderColor: "#527B6B", borderRadius: 19, borderWidth: 1, flexDirection: "row", marginTop: 18, padding: 14 },
  chatButtonPressed: { opacity: 0.83, transform: [{ scale: 0.99 }] },
  chatIcon: { alignItems: "center", backgroundColor: "#315A4C", borderRadius: 16, height: 44, justifyContent: "center", width: 44 },
  chatIconActive: { backgroundColor: "#D57938" },
  chatIconText: { color: "#FFF7E9", fontSize: 21 },
  chatButtonCopy: { flex: 1, marginLeft: 12 },
  chatButtonTitle: { color: "#F4F0E6", fontSize: 15, fontWeight: "800" },
  chatButtonHint: { color: "#AFC6BB", fontSize: 12, marginTop: 3 },
  commandSection: { marginTop: 26 },
  commandTitle: { color: "#9BB5A9", fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginBottom: 10, textTransform: "uppercase" },
  textModePill: { alignSelf: "flex-start", backgroundColor: "#25473C", borderColor: "#5D9B81", borderRadius: 20, borderWidth: 1, marginBottom: 17, paddingHorizontal: 10, paddingVertical: 7 },
  textModePillText: { color: "#BFF0D1", fontSize: 10, fontWeight: "800", letterSpacing: 0.9 },
  transcriptHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  transcriptHint: { color: "#78948A", fontSize: 11, marginBottom: 10 },
  transcriptCard: { backgroundColor: "#122720", borderColor: "#355B4D", borderRadius: 18, borderWidth: 1, gap: 9, maxHeight: 355, padding: 12 },
  chatBubble: { borderRadius: 14, maxWidth: "89%", paddingHorizontal: 12, paddingVertical: 10 },
  agentBubble: { alignSelf: "flex-start", backgroundColor: "#E8E6DB" },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#346B58" },
  thinkingBubble: { opacity: 0.84 },
  chatBubbleLabel: { fontSize: 9, fontWeight: "800", letterSpacing: 1.1, marginBottom: 4 },
  agentBubbleLabel: { color: "#8D6038" },
  userBubbleLabel: { color: "#BDE4CF" },
  chatBubbleText: { fontSize: 14, lineHeight: 19 },
  agentBubbleText: { color: "#24352D" },
  userBubbleText: { color: "#F4FAF5" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: "#1E3A31", borderColor: "#527565", borderRadius: 18, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  chipPressed: { backgroundColor: "#31594C" },
  chipText: { color: "#DBE8E0", fontSize: 12, fontWeight: "700" },
  voiceInputRow: { alignItems: "center", backgroundColor: "#1A3930", borderColor: "#527B6B", borderRadius: 18, borderWidth: 1, flexDirection: "row", marginTop: 15, padding: 10 },
  micButton: { alignItems: "center", backgroundColor: "#D57938", borderColor: "#F3BE75", borderRadius: 25, borderWidth: 2, height: 50, justifyContent: "center", width: 50 },
  micButtonListening: { backgroundColor: "#E9BB5B", borderColor: "#FFF3CD", transform: [{ scale: 1.04 }] },
  micButtonPressed: { opacity: 0.82 },
  micButtonIcon: { color: "#FFF9EC", fontSize: 19 },
  micCopy: { flex: 1, marginLeft: 12 },
  micTitle: { color: "#F3F1E9", fontSize: 14, fontWeight: "800" },
  micHint: { color: "#AAC2B7", fontSize: 11, lineHeight: 16, marginTop: 3 },
  commandInputRow: { alignItems: "center", backgroundColor: "#173029", borderColor: "#4E7566", borderRadius: 15, borderWidth: 1, flexDirection: "row", marginTop: 13, paddingLeft: 14 },
  commandInput: { color: "#F3F0E7", flex: 1, fontSize: 14, paddingVertical: 13 },
  sendButton: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 11, height: 37, justifyContent: "center", marginRight: 5, width: 37 },
  sendButtonPressed: { opacity: 0.8 },
  sendText: { color: "#FFF7EB", fontSize: 24, fontWeight: "500", marginTop: -3 },
  footnote: { color: "#7F9A8E", fontSize: 11, lineHeight: 16, marginTop: 22, textAlign: "center" },
  appShell: { flex: 1, paddingHorizontal: 22, paddingTop: 10 },
  tabStage: { flex: 1, minHeight: 0 },
  welcomeContent: { flexGrow: 1, justifyContent: "center", paddingBottom: 18, paddingTop: 8 },
  welcomeCopy: { marginBottom: 22, marginTop: 2 },
  welcomeTitle: { color: "#F5F1E7", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 31, lineHeight: 36 },
  welcomeText: { color: "#AFC6BB", fontSize: 15, lineHeight: 22, marginTop: 9 },
  waitingForVoiceOsCard: { backgroundColor: "#173229", borderColor: "#4B786A", borderRadius: 19, borderWidth: 1, padding: 17 },
  waitingForVoiceOsEyebrow: { color: "#8EDEAF", fontSize: 10, fontWeight: "900", letterSpacing: 1.25 },
  waitingForVoiceOsText: { color: "#E1EEE7", fontSize: 15, fontWeight: "700", lineHeight: 22, marginTop: 8 },
  startCookButton: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 19, flexDirection: "row", justifyContent: "center", minHeight: 62, paddingHorizontal: 22 },
  startCookButtonText: { color: "#FFF9EC", fontSize: 18, fontWeight: "900" },
  startCookButtonIcon: { color: "#FFF4DD", fontSize: 19, marginLeft: 10 },
  welcomeHint: { color: "#829D91", fontSize: 11, lineHeight: 16, marginHorizontal: 16, marginTop: 13, textAlign: "center" },
  conversationPage: { flex: 1, minHeight: 0, paddingBottom: 10 },
  conversationChefBar: { alignItems: "center", flexDirection: "row", marginBottom: 14, paddingTop: 6 },
  conversationChefAvatar: { alignItems: "center", backgroundColor: "#24483D", borderColor: "#577E6F", borderRadius: 28, borderWidth: 1, height: 52, justifyContent: "center", overflow: "hidden", width: 52 },
  conversationChefAvatarListening: { borderColor: "#E7B95A", shadowColor: "#E7B95A", shadowOpacity: 0.5, shadowRadius: 8 },
  conversationChefImage: { height: 78, marginTop: 22, width: 78 },
  conversationChefCopy: { marginLeft: 11 },
  conversationChefName: { color: "#F4F0E6", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 23 },
  conversationChefStatus: { color: "#A7C9B8", fontSize: 11, fontWeight: "800", letterSpacing: 0.6, marginTop: 3, textTransform: "uppercase" },
  voiceMuteButton: { alignItems: "center", borderColor: "#416657", borderRadius: 13, borderWidth: 1, justifyContent: "center", marginLeft: "auto", minHeight: 32, paddingHorizontal: 10 },
  voiceMuteButtonMuted: { backgroundColor: "#203B33", borderColor: "#587A6C" },
  voiceMuteButtonPressed: { opacity: 0.72 },
  voiceMuteButtonText: { color: "#B8D2C4", fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  voiceMuteButtonTextMuted: { color: "#8FA89C" },
  conversationFeed: { backgroundColor: "#11271F", borderColor: "#385E50", borderRadius: 24, borderWidth: 1, flex: 1, minHeight: 160, overflow: "hidden" },
  conversationFeedContent: { gap: 10, padding: 13 },
  conversationBubble: { borderRadius: 18, maxWidth: "90%", paddingHorizontal: 14, paddingVertical: 12 },
  conversationChefBubble: { alignSelf: "flex-start", backgroundColor: "#F1EEE3" },
  conversationUserBubble: { alignSelf: "flex-end", backgroundColor: "#356F5B" },
  bubbleSpeakerRow: { alignItems: "center", flexDirection: "row" },
  bubbleSpeaker: { fontSize: 9, fontWeight: "900", letterSpacing: 1.25, marginBottom: 5 },
  conversationBubbleText: { fontSize: 15, lineHeight: 21 },
  conversationChefText: { color: "#26382F", fontSize: 16, lineHeight: 23 },
  liveTranscriptTray: { alignItems: "center", backgroundColor: "#18342B", borderColor: "#496F60", borderRadius: 15, borderWidth: 1, flexDirection: "row", marginTop: 12, minHeight: 52, paddingHorizontal: 13, paddingVertical: 9 },
  liveTranscriptDot: { backgroundColor: "#819B8F", borderRadius: 5, height: 8, marginRight: 9, width: 8 },
  liveTranscriptDotListening: { backgroundColor: "#E7B95A", shadowColor: "#E7B95A", shadowOpacity: 0.8, shadowRadius: 6 },
  liveTranscriptText: { color: "#C5D8CF", flex: 1, fontSize: 12, lineHeight: 17 },
  photoChefButton: { alignItems: "center", backgroundColor: "#1A3930", borderColor: "#5C8A78", borderRadius: 16, borderWidth: 1, flexDirection: "row", marginTop: 12, minHeight: 58, paddingHorizontal: 12 },
  photoChefIcon: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 16, color: "#FFF8EC", fontSize: 20, height: 32, justifyContent: "center", overflow: "hidden", textAlign: "center", width: 32 },
  photoChefCopy: { flex: 1, marginLeft: 10 },
  photoChefTitle: { color: "#F4F0E6", fontSize: 14, fontWeight: "900" },
  photoChefHint: { color: "#AFC6BB", fontSize: 11, lineHeight: 15, marginTop: 2 },
  photoChefArrow: { color: "#E7B95A", fontSize: 26, fontWeight: "400", marginLeft: 5 },
  conversationControls: { flexDirection: "row", gap: 10, marginTop: 12 },
  pauseCookButton: { alignItems: "center", backgroundColor: "#2A5547", borderColor: "#5C8A78", borderRadius: 17, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 55 },
  pauseCookText: { color: "#E5EEE9", fontSize: 15, fontWeight: "900" },
  conversationStopButton: { alignItems: "center", borderColor: "#BC8271", borderRadius: 17, borderWidth: 1, flex: 1, justifyContent: "center", minHeight: 55 },
  conversationStopText: { color: "#E5EEE9", fontSize: 16, fontWeight: "900" },
  recipeBoxContent: { paddingBottom: 18, paddingTop: 8 },
  recipeBoxHeading: { alignItems: "flex-start", flexDirection: "row", justifyContent: "space-between" },
  recipeBoxHeadingCopy: { flex: 1, paddingRight: 12 },
  recipeBoxTitle: { color: "#F5F1E7", fontFamily: Platform.select({ ios: "Georgia", default: "serif" }), fontSize: 34 },
  recipeBoxSubtitle: { color: "#9EB8AC", fontSize: 14, lineHeight: 20, marginTop: 7 },
  addRecipeButton: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 13, justifyContent: "center", marginTop: 5, minHeight: 40, paddingHorizontal: 13 },
  addRecipeButtonText: { color: "#FFF8EB", fontSize: 12, fontWeight: "900" },
  manualRecipeForm: { backgroundColor: "#173229", borderColor: "#4B786A", borderRadius: 20, borderWidth: 1, marginTop: 18, padding: 14 },
  manualRecipeTitle: { color: "#F5F1E7", fontSize: 18, fontWeight: "900" },
  manualRecipeHint: { color: "#AFC6BB", fontSize: 12, lineHeight: 17, marginBottom: 12, marginTop: 4 },
  recipeInput: { backgroundColor: "#10241D", borderColor: "#416555", borderRadius: 12, borderWidth: 1, color: "#F5F1E7", fontSize: 13, marginTop: 9, paddingHorizontal: 12, paddingVertical: 11 },
  recipeTextArea: { minHeight: 94 },
  recipeNotesInput: { minHeight: 52 },
  manualRecipeMessage: { color: "#C9E2D5", fontSize: 12, lineHeight: 17, marginTop: 10 },
  manualRecipeSave: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 13, justifyContent: "center", marginTop: 13, minHeight: 46 },
  manualRecipeSaveText: { color: "#FFF8EB", fontSize: 14, fontWeight: "900" },
  recipeBoxList: { gap: 11, marginTop: 20 },
  recipeBoxCard: { backgroundColor: "#19352C", borderColor: "#45695D", borderRadius: 19, borderWidth: 1, padding: 13 },
  recipeBoxCardOpen: { borderColor: "#D9A95B" },
  recipeBoxVoiceOsHint: { color: "#9DB9AC", fontSize: 11, fontWeight: "700", marginTop: 12, textAlign: "center" },
  recipeBoxCardHeader: { alignItems: "center", flexDirection: "row" },
  recipeBoxCardPressed: { opacity: 0.82 },
  recipeBoxEmoji: { fontSize: 30, marginRight: 10 },
  recipeBoxCardCopy: { flex: 1, paddingRight: 8 },
  recipeBoxCardTitle: { color: "#F5F1E7", fontSize: 15, fontWeight: "900", lineHeight: 19 },
  recipeBoxCardMeta: { color: "#9FB8AD", fontSize: 11, fontWeight: "700", marginTop: 4 },
  recipeBoxChevron: { color: "#E7B95A", fontSize: 24, fontWeight: "500", marginLeft: 4, paddingHorizontal: 4 },
  recipeDetail: { borderTopColor: "#365D4F", borderTopWidth: 1, marginTop: 13, paddingTop: 13 },
  recipeDetailDescription: { color: "#C6D7CF", fontSize: 13, lineHeight: 19, marginBottom: 15 },
  recipeDetailLabel: { color: "#E7B95A", fontSize: 10, fontWeight: "900", letterSpacing: 1.15, marginBottom: 7, marginTop: 10 },
  recipeDetailRow: { color: "#D5E2DB", fontSize: 13, lineHeight: 20, paddingLeft: 2 },
  recipeDetailAmount: { color: "#F0C66C", fontWeight: "900" },
  recipeDetailStep: { flexDirection: "row", marginTop: 9 },
  recipeDetailStepNumber: { alignItems: "center", backgroundColor: "#315A4C", borderRadius: 10, color: "#EAF5EE", fontSize: 11, fontWeight: "900", height: 20, justifyContent: "center", marginRight: 9, overflow: "hidden", textAlign: "center", width: 20 },
  recipeDetailStepCopy: { flex: 1 },
  recipeDetailStepTitle: { color: "#E6F0EA", fontSize: 13, fontWeight: "900", lineHeight: 18 },
  recipeDetailStepText: { color: "#B7CCC1", fontSize: 12, lineHeight: 18, marginTop: 2 },
  recipeDetailNotes: { backgroundColor: "#284B40", borderRadius: 10, color: "#D0E2D8", fontSize: 12, lineHeight: 17, marginTop: 13, padding: 10 },
  recipeBoxStart: { alignItems: "center", backgroundColor: "#D57938", borderRadius: 12, justifyContent: "center", marginTop: 13, minHeight: 42, paddingHorizontal: 11 },
  recipeBoxStartText: { color: "#FFF7E9", fontSize: 11, fontWeight: "900" },
  tabBar: { backgroundColor: "#132D25", borderColor: "#345849", borderRadius: 19, borderWidth: 1, flexDirection: "row", gap: 8, marginBottom: 10, marginTop: 10, padding: 5 },
  tabButton: { alignItems: "center", borderRadius: 14, flex: 1, flexDirection: "row", justifyContent: "center", minHeight: 45 },
  tabButtonActive: { backgroundColor: "#2A5547" },
  tabIcon: { color: "#89A79B", fontSize: 17, marginRight: 7 },
  tabText: { color: "#9FB8AD", fontSize: 13, fontWeight: "800" },
  tabTextActive: { color: "#F4F0E6" },
});
