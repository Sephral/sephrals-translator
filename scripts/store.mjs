/**
 * Storage of the translator. One client setting holds the drafts of all modules and languages, with the earlier
 * submissions of each. Browser storage can be empty or blocked, so every access is in try/catch and the window works
 * without it. The reliable backup is the export, and the copy saved as a file with every submission.
 *
 * Two more settings say where a translation is used outside the window: "use" (client, this browser) and "shared"
 * (world, written by a GM, for everybody).
 */

import {MODULE_ID} from "./config.mjs";
import {dict, draftKey, parseDrafts, parseShared, parseUse, sanitizeDraft, emptyDraft} from "./translator-logic.mjs";

/**
 * All stored drafts, raw.
 * @returns {Record<string, object>}
 */
export function readDrafts() {
  try {
    return parseDrafts(game.settings.get(MODULE_ID, "drafts"));
  } catch {
    return dict();
  }
}

/**
 * The stored draft of a module and language, reduced to valid keys; null when there is none.
 * @param {string} moduleId
 * @param {string} lang
 * @param {Map<string, string>} enFlat
 * @returns {ReturnType<typeof emptyDraft>|null}
 */
export function loadDraft(moduleId, lang, enFlat) {
  const raw = readDrafts()[draftKey(moduleId, lang)];
  return raw ? sanitizeDraft(raw, enFlat) : null;
}

/**
 * Store a draft. Returns false when the browser refused.
 * @param {string} moduleId
 * @param {string} lang
 * @param {ReturnType<typeof emptyDraft>} draft
 * @returns {Promise<boolean>}
 */
export async function saveDraft(moduleId, lang, draft) {
  try {
    const all = readDrafts();
    draft.saved = Date.now();
    if ( !Object.keys(draft.texts).length && !draft.history.length && !Object.keys(draft.notes ?? {}).length ) delete all[draftKey(moduleId, lang)];
    else all[draftKey(moduleId, lang)] = draft;
    await game.settings.set(MODULE_ID, "drafts", JSON.stringify(all));
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | The draft could not be saved`, err);
    return false;
  }
}

/**
 * The languages this browser uses outside the window, by module id.
 * @returns {Record<string, string>}
 */
export function readUse() {
  try {
    return parseUse(game.settings.get(MODULE_ID, "use"));
  } catch {
    return dict();
  }
}

/**
 * Store the languages this browser uses.
 * @param {Record<string, string>} use
 * @returns {Promise<boolean>}
 */
export async function saveUse(use) {
  try {
    await game.settings.set(MODULE_ID, "use", JSON.stringify(use));
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | The choice could not be saved`, err);
    return false;
  }
}

/**
 * The translations a GM shared with the world, by module id.
 * @returns {Record<string, {lang: string, texts: Record<string, string>, at: number}>}
 */
export function readShared() {
  try {
    return parseShared(game.settings.get(MODULE_ID, "shared"));
  } catch {
    return dict();
  }
}

/**
 * Store the shared translations (GM only).
 * @param {Record<string, object>} shared
 * @returns {Promise<boolean>}
 */
export async function saveShared(shared) {
  try {
    await game.settings.set(MODULE_ID, "shared", JSON.stringify(shared));
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | The shared translation could not be saved`, err);
    return false;
  }
}

/**
 * The reviews this browser works on, by module, language and the time of the submission (see review-logic).
 * @returns {Record<string, object>}
 */
export function readReviews() {
  try {
    const data = JSON.parse(game.settings.get(MODULE_ID, "reviews") || "{}");
    return data && (typeof data === "object") && !Array.isArray(data) ? data : dict();
  } catch {
    return dict();
  }
}

/**
 * Store the state of one review (at most 20 reviews are kept, the oldest go first).
 * @param {string} key
 * @param {object} review
 * @returns {Promise<boolean>}
 */
export async function saveReview(key, review) {
  try {
    const all = readReviews();
    all[key] = review;
    const keep = Object.entries(all).sort((a, b) => (b[1]?.saved ?? 0) - (a[1]?.saved ?? 0)).slice(0, 20);
    await game.settings.set(MODULE_ID, "reviews", JSON.stringify(Object.fromEntries(keep)));
    return true;
  } catch(err) {
    console.warn(`${MODULE_ID} | The review could not be saved`, err);
    return false;
  }
}
