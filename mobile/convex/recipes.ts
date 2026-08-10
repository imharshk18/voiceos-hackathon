import { mutation, query } from "./_generated/server";
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

const recipeResult = v.object({
  _id: v.id("recipes"),
  _creationTime: v.number(),
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
});

const starterRecipes = [
  {
    title: "Weeknight Chicken Curry",
    emoji: "🍛",
    description: "A bright, cosy chicken curry with a silky tomato-coconut sauce.",
    cuisine: "Indian-inspired",
    baseServings: 2,
    prepMinutes: 12,
    cookMinutes: 28,
    ingredients: [
      { name: "boneless chicken thighs, bite-size", quantity: 450, unit: "g" },
      { name: "neutral oil", quantity: 1, unit: "tbsp" },
      { name: "yellow onion, finely diced", quantity: 1, unit: "whole" },
      { name: "garlic, minced", quantity: 3, unit: "cloves" },
      { name: "ginger, grated", quantity: 1, unit: "tbsp" },
      { name: "curry powder", quantity: 1.5, unit: "tsp" },
      { name: "crushed tomatoes", quantity: 1, unit: "cup" },
      { name: "coconut milk", quantity: 0.75, unit: "cup" },
      { name: "baby spinach", quantity: 2, unit: "cups" },
      { name: "lime", quantity: 0.5, unit: "whole" },
    ],
    steps: [
      {
        title: "Build your aromatics",
        instruction: "Heat the oil in a wide pan over medium heat. Add onion with a pinch of salt and cook until soft and glossy.",
        minutes: 5,
        heat: "medium",
        tip: "Keep the onion pale and sweet; lower the heat if it starts catching.",
      },
      {
        title: "Bloom the flavour",
        instruction: "Stir in garlic, ginger, and curry powder for 45 seconds, just until fragrant.",
        minutes: 1,
        heat: "medium",
        tip: "Have the tomatoes ready so the spices never scorch.",
      },
      {
        title: "Simmer the chicken",
        instruction: "Add chicken and tomatoes. Stir to coat, then simmer gently until the chicken is cooked through.",
        minutes: 14,
        heat: "medium-low",
        tip: "Once the pan is simmering, tell Mise it is on the stove and it will set the timer.",
      },
      {
        title: "Make it silky",
        instruction: "Stir in coconut milk and spinach. Cook until the spinach wilts and the sauce lightly coats a spoon.",
        minutes: 5,
        heat: "low",
        tip: "Keep this at a lazy bubble so the coconut milk stays smooth.",
      },
      {
        title: "Taste and finish",
        instruction: "Turn off the heat. Add lime, then taste for salt and brightness before serving.",
        minutes: 1,
        heat: "off",
        tip: "A final squeeze of lime wakes the whole curry up.",
      },
    ],
    notes: "Great with rice, naan, or a spoon straight from the pan.",
  },
  {
    title: "Hand-Roll Sushi Night",
    emoji: "🍣",
    description: "A relaxed hand-roll set with seasoned rice, crisp veg, and your favourite fillings.",
    cuisine: "Japanese-inspired",
    baseServings: 2,
    prepMinutes: 25,
    cookMinutes: 18,
    ingredients: [
      { name: "sushi rice", quantity: 1, unit: "cup" },
      { name: "water", quantity: 1.25, unit: "cups" },
      { name: "rice vinegar", quantity: 2, unit: "tbsp" },
      { name: "sugar", quantity: 1, unit: "tsp" },
      { name: "salt", quantity: 0.5, unit: "tsp" },
      { name: "nori sheets", quantity: 4, unit: "sheets" },
      { name: "cucumber, matchsticks", quantity: 0.5, unit: "whole" },
      { name: "avocado, sliced", quantity: 1, unit: "whole" },
      { name: "cooked salmon or tofu", quantity: 200, unit: "g" },
      { name: "soy sauce", quantity: 2, unit: "tbsp" },
    ],
    steps: [
      {
        title: "Rinse the rice",
        instruction: "Rinse the sushi rice in cold water until the water is mostly clear, then drain it well.",
        minutes: 4,
        heat: "off",
        tip: "Gentle rubbing releases surface starch without breaking the grains.",
      },
      {
        title: "Cook the rice",
        instruction: "Add rice and water to a small pot. Bring to a boil, cover, then cook on low until tender.",
        minutes: 15,
        heat: "low",
        tip: "Once you cover it, say it is on the stove so Mise can start your rice timer.",
      },
      {
        title: "Season and cool",
        instruction: "Mix vinegar, sugar, and salt. Fold it through the warm rice, then spread the rice out to cool slightly.",
        minutes: 5,
        heat: "off",
        tip: "Fan or gently turn the rice; do not mash it.",
      },
      {
        title: "Set up your filling bar",
        instruction: "Slice cucumber and avocado. Arrange the fillings, nori, rice, and soy sauce within reach.",
        minutes: 6,
        heat: "off",
        tip: "This is a good parallel moment while the rice cools.",
      },
      {
        title: "Roll and eat",
        instruction: "Add a small layer of rice and fillings to half a nori sheet. Roll into a loose cone and eat right away.",
        minutes: 4,
        heat: "off",
        tip: "Less filling makes a cleaner hand roll.",
      },
    ],
    notes: "Use cooked seafood or tofu for an easy at-home sushi night.",
  },
  {
    title: "Jammy Egg Skillet",
    emoji: "🍳",
    description: "Soft eggs in a garlicky tomato skillet, built for toast and busy mornings.",
    cuisine: "Breakfast",
    baseServings: 2,
    prepMinutes: 8,
    cookMinutes: 14,
    ingredients: [
      { name: "eggs", quantity: 4, unit: "whole" },
      { name: "olive oil", quantity: 1, unit: "tbsp" },
      { name: "shallot, sliced", quantity: 1, unit: "whole" },
      { name: "garlic, sliced", quantity: 2, unit: "cloves" },
      { name: "cherry tomatoes", quantity: 2, unit: "cups" },
      { name: "feta, crumbled", quantity: 0.25, unit: "cup" },
      { name: "baby spinach", quantity: 1, unit: "cup" },
      { name: "toast", quantity: 4, unit: "slices" },
    ],
    steps: [
      {
        title: "Soften the shallot",
        instruction: "Warm olive oil in a skillet. Add shallot and a pinch of salt until soft and translucent.",
        minutes: 3,
        heat: "medium",
        tip: "A little salt helps the shallot soften instead of colour.",
      },
      {
        title: "Burst the tomatoes",
        instruction: "Add garlic and tomatoes. Stir until the tomatoes soften and become saucy.",
        minutes: 5,
        heat: "medium",
        tip: "Press a few tomatoes with the back of your spoon for an instant sauce.",
      },
      {
        title: "Nest the eggs",
        instruction: "Make four small wells, crack in the eggs, then scatter feta and spinach around them.",
        minutes: 1,
        heat: "low",
        tip: "Keep the yolks intact; they are your built-in sauce.",
      },
      {
        title: "Steam until jammy",
        instruction: "Cover the skillet and cook until whites are set but yolks still wobble. Toast bread at the same time.",
        minutes: 5,
        heat: "low",
        tip: "Tell Mise when the lid is on and it will watch the timing.",
      },
      {
        title: "Serve straight away",
        instruction: "Take the pan off heat and serve with the toast while the eggs are still warm.",
        minutes: 1,
        heat: "off",
        tip: "A pinch of chilli flakes is lovely here if you want heat.",
      },
    ],
    notes: "Swap feta for parmesan or goat cheese if that is what you have.",
  },
  {
    title: "Creamy Garden Veg Pasta",
    emoji: "🍝",
    description: "A fast vegetarian pasta with green veg, lemon, and a glossy parmesan sauce.",
    cuisine: "Vegetarian",
    baseServings: 2,
    prepMinutes: 12,
    cookMinutes: 18,
    ingredients: [
      { name: "short pasta", quantity: 180, unit: "g" },
      { name: "olive oil", quantity: 1, unit: "tbsp" },
      { name: "zucchini, half-moons", quantity: 1, unit: "whole" },
      { name: "broccoli florets", quantity: 1.5, unit: "cups" },
      { name: "garlic, minced", quantity: 2, unit: "cloves" },
      { name: "cooking cream", quantity: 0.5, unit: "cup" },
      { name: "parmesan, finely grated", quantity: 0.5, unit: "cup" },
      { name: "lemon", quantity: 0.5, unit: "whole" },
      { name: "basil or parsley", quantity: 0.25, unit: "cup" },
    ],
    steps: [
      {
        title: "Salt the pasta water",
        instruction: "Bring a large pot of well-salted water to a boil. Add pasta and cook until just shy of tender.",
        minutes: 10,
        heat: "high",
        tip: "Start chopping the vegetables while the water comes to a boil.",
      },
      {
        title: "Sauté the vegetables",
        instruction: "Meanwhile, heat olive oil in a large pan. Cook zucchini and broccoli until bright and lightly golden.",
        minutes: 6,
        heat: "medium-high",
        tip: "Give the veg room in the pan so it browns instead of steams.",
      },
      {
        title: "Build the sauce",
        instruction: "Lower the heat. Add garlic for 30 seconds, then stir in cream and a splash of pasta water.",
        minutes: 2,
        heat: "low",
        tip: "The starchy pasta water is what makes the sauce cling.",
      },
      {
        title: "Toss it glossy",
        instruction: "Move the pasta into the pan. Toss with parmesan and more pasta water until the sauce coats every piece.",
        minutes: 2,
        heat: "low",
        tip: "Keep tossing rather than boiling hard; the sauce should look shiny, not heavy.",
      },
      {
        title: "Finish with lemon",
        instruction: "Turn off the heat. Add lemon and herbs, then taste before serving.",
        minutes: 1,
        heat: "off",
        tip: "Lemon balances the richness without needing lots of salt.",
      },
    ],
    notes: "Use whatever green vegetables need using up in the fridge.",
  },
] as const;

export const list = query({
  args: { ownerId: v.string() },
  returns: v.array(recipeResult),
  handler: async (ctx, args) =>
    await ctx.db
      .query("recipes")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(20),
});

export const seedDemo = mutation({
  args: { ownerId: v.string() },
  returns: v.object({ recipeIds: v.array(v.id("recipes")), created: v.number() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("recipes")
      .withIndex("by_owner_id", (q) => q.eq("ownerId", args.ownerId))
      .take(30);
    const existingTitles = new Set(existing.map((recipe) => recipe.title));
    const recipeIds = existing.map((recipe) => recipe._id);
    let created = 0;

    const now = Date.now();
    for (const starter of starterRecipes) {
      if (existingTitles.has(starter.title)) continue;
      const recipeId = await ctx.db.insert("recipes", {
        ownerId: args.ownerId,
        ...starter,
        ingredients: [...starter.ingredients],
        steps: [...starter.steps],
        createdAt: now,
        updatedAt: now,
      });
      recipeIds.push(recipeId);
      created += 1;
    }

    return { recipeIds, created };
  },
});

export const create = mutation({
  args: {
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
  },
  returns: v.object({ recipeId: v.id("recipes") }),
  handler: async (ctx, args) => {
    const title = args.title.trim().slice(0, 80);
    if (!title) {
      throw new Error("A recipe needs a name before it can be saved.");
    }
    if (args.ingredients.length === 0 || args.steps.length === 0) {
      throw new Error("Add at least one ingredient and one cooking step before saving.");
    }

    const now = Date.now();
    const recipeId = await ctx.db.insert("recipes", {
      ...args,
      title,
      emoji: args.emoji.trim() || "🍽️",
      description: args.description.trim().slice(0, 240),
      cuisine: args.cuisine.trim().slice(0, 60) || "Custom",
      baseServings: Math.max(1, Math.min(12, Math.round(args.baseServings))),
      prepMinutes: Math.max(0, Math.min(240, Math.round(args.prepMinutes))),
      cookMinutes: Math.max(0, Math.min(480, Math.round(args.cookMinutes))),
      ingredients: args.ingredients.slice(0, 30),
      steps: args.steps.slice(0, 20),
      notes: args.notes.trim().slice(0, 600),
      createdAt: now,
      updatedAt: now,
    });
    return { recipeId };
  },
});
