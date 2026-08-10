/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as countertop from "../countertop.js";
import type * as elevenlabs from "../elevenlabs.js";
import type * as recipes from "../recipes.js";
import type * as sessions from "../sessions.js";
import type * as timers from "../timers.js";
import type * as xtrace from "../xtrace.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  countertop: typeof countertop;
  elevenlabs: typeof elevenlabs;
  recipes: typeof recipes;
  sessions: typeof sessions;
  timers: typeof timers;
  xtrace: typeof xtrace;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
