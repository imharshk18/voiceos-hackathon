export type KitchenIntent =
  | { type: "advance" }
  | { type: "timer"; seconds: number }
  | { type: "servings"; servings: number }
  | { type: "rescue"; response: string }
  | { type: "remember" }
  | { type: "next" }
  | { type: "unknown" };

export function parseKitchenIntent(raw: string): KitchenIntent {
  const text = raw.toLowerCase().trim();

  // Completion always wins over a request for orientation. "I'm done —
  // what's next?" means advance the recipe, not repeat the current step.
  if (/\b(next|done|move on|keep going)\b/.test(text)) {
    return { type: "advance" };
  }

  if (/what(?:'s| is) next|next step|where am i|remind me what i(?:'m| am) doing/.test(text)) {
    return { type: "next" };
  }

  const time = text.match(/(\d+)\s*(seconds?|secs?|minutes?|mins?)/);
  if (/\b(timer|time it|remind me)\b/.test(text) && time) {
    const amount = Number(time[1]);
    const seconds = /sec/.test(time[2]) ? amount : amount * 60;
    return { type: "timer", seconds };
  }

  const servings = text.match(/\b(?:serve|serves|serving|for)\s+(\d+)\b/);
  if (servings) {
    return { type: "servings", servings: Number(servings[1]) };
  }

  if (/too salty|salty/.test(text)) {
    return {
      type: "rescue",
      response:
        "Take it off the heat. Add a little acid or unsalted liquid, then taste again. With curry, try lime and a splash of coconut milk.",
    };
  }

  if (/too thick|thick|dry/.test(text)) {
    return {
      type: "rescue",
      response:
        "Lower the heat and stir in a splash of stock or water at a time. Wait thirty seconds before deciding if it needs more.",
    };
  }

  if (/burning|burnt|burned|charred|scorched|blackened|smok(?:e|ing)|on fire/.test(text)) {
    return {
      type: "rescue",
      response:
        "Good catch — move the pan off the heat now. Don’t scrape blackened bits into the food; transfer any unburnt food to a clean pan, then tell me how much is still salvageable.",
    };
  }

  if (/remember|i hate|i love|allergic|don't like|do not like/.test(text)) {
    return { type: "remember" };
  }

  return { type: "unknown" };
}

export function formatTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function scaledQuantity(quantity: number, baseServings: number, servings: number) {
  const amount = (quantity / baseServings) * servings;
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1).replace(/\.0$/, "");
}
