/**
 * A translation in use outside the translator window: in this browser (client setting "use", the stored draft) or for
 * everybody in the world (world setting "shared", a copy a GM wrote). The texts go into Foundry's translations of this
 * browser as soon as Foundry has loaded its own (i18nInit), so the first window drawn already shows them. Only texts
 * without errors are used, checked against the English text Foundry loaded.
 *
 * A user who picked a fixed language for a module (its "Module language" setting) keeps it: a shared translation is not
 * used there. The user's own choice wins over it, and is put back at ready and after a change of that setting, because
 * the module loads its language file a moment later.
 */

import {runtime, trace} from "./debug.mjs";
import {readDrafts, readShared, readUse} from "./store.mjs";
import {safeMergeTranslations} from "./translate-checks.mjs";
import {REFRESH_HOOK, dict, draftKey, pickUse, refreshPayload, usableTexts} from "./translator-logic.mjs";

/** Per module: the choice that was applied, the texts written and what Foundry showed before them. */
const state = new Map();

/** English texts as Foundry loaded them, by key, read before anything is written. */
const englishCache = new Map();

/**
 * The English text of a key as Foundry loaded it.
 * @param {string} key
 * @returns {string|undefined}
 */
function englishOf(key) {
  if ( englishCache.has(key) ) return englishCache.get(key);
  const source = (game.i18n.lang === "en") ? game.i18n.translations : game.i18n._fallback;
  const value = foundry.utils.getProperty(source ?? {}, key);
  if ( typeof value !== "string" ) return undefined;
  englishCache.set(key, value);
  return value;
}

/**
 * Did the user pick a fixed language for this module? Every Sephral module has the client setting "uiLanguage", whose
 * value "default" follows Foundry.
 * @param {string} moduleId
 * @returns {boolean}
 */
function fixedLanguage(moduleId) {
  try {
    const value = game.settings.get(moduleId, "uiLanguage");
    return !!value && (value !== "default");
  } catch {
    return false;
  }
}

/** Is the module open in the translator window? Then the window decides, and hands over when it closes. */
const inWindow = moduleId => !!runtime.translator?.preview?.mods?.has(moduleId);

/**
 * The texts a module should show outside the window.
 * @param {string} moduleId
 * @param {Map<string, string>|null} [english]   The English file, when known (the window); else Foundry's English
 * @returns {{pick: {lang: string, source: string}|null, texts: Map<string, string>}}
 */
export function wantedTexts(moduleId, english = null) {
  const shared = readShared();
  const pick = game.modules.get(moduleId)?.active
    ? pickUse(moduleId, {use: readUse(), shared, forced: fixedLanguage(moduleId)}) : null;
  if ( !pick ) return {pick: null, texts: new Map()};
  let raw = dict();
  if ( pick.source === "world" ) raw = shared[moduleId]?.texts ?? raw;
  else {
    const stored = readDrafts()[draftKey(moduleId, pick.lang)]?.texts;
    if ( stored && (typeof stored === "object") ) for ( const [key, text] of Object.entries(stored) ) if ( typeof text === "string" ) raw[key] = text;
  }
  const en = english ?? new Map(Object.keys(raw).map(key => [key, englishOf(key)]));
  return {pick, texts: usableTexts(raw, en, pick.lang)};
}

/**
 * Bring a module's strings in this browser to the wanted texts. Keys that were used before and are no longer get back
 * what Foundry showed before them.
 * @param {string} moduleId
 * @returns {string[]}   The keys written
 */
export function applyModule(moduleId) {
  const {pick, texts} = wantedTexts(moduleId);
  const previous = state.get(moduleId);
  const originals = previous?.originals ?? new Map();
  const write = new Map();
  for ( const key of previous?.texts.keys() ?? [] ) {
    if ( texts.has(key) ) continue;
    const back = originals.get(key) ?? englishOf(key);
    if ( typeof back === "string" ) write.set(key, back);
  }
  for ( const [key, text] of texts ) {
    const shown = foundry.utils.getProperty(game.i18n.translations, key);
    if ( !originals.has(key) ) originals.set(key, typeof shown === "string" ? shown : englishOf(key));
    if ( shown !== text ) write.set(key, text);
  }
  const roots = [...new Set([...write.keys()].map(key => key.split(".")[0]))];
  const written = write.size ? safeMergeTranslations(game.i18n.translations, roots, write) : [];
  if ( texts.size || originals.size ) state.set(moduleId, {pick, texts, originals});
  return written;
}

/**
 * Apply every module that has a translation in use, or had one.
 * @returns {Map<string, string[]>}   Module id to the keys written
 */
export function applyAll() {
  const ids = new Set([...Object.keys(readUse()), ...Object.keys(readShared()), ...state.keys()]);
  const out = new Map();
  for ( const id of ids ) {
    if ( inWindow(id) ) continue;
    const written = applyModule(id);
    if ( written.length ) out.set(id, written);
  }
  return out;
}

/**
 * Tell a module that texts it cached or drew on the canvas changed.
 * @param {string} moduleId
 * @param {string[]} keys
 */
function refresh(moduleId, keys) {
  if ( !keys.length ) return;
  const roots = [...new Set(keys.map(key => key.split(".")[0]))];
  try {
    Hooks.callAll(REFRESH_HOOK, refreshPayload(moduleId, roots, keys, keys));
  } catch(err) {
    console.warn("sephrals-translator | refresh hook failed", err);
  }
}

/**
 * The window lets go of a module: the texts that stay in memory. The texts in use, and for keys that were in use before
 * and no longer are, what Foundry showed before them.
 * @param {string} moduleId
 * @param {Map<string, string>} english   The English file
 * @param {Map<string, string>} clean     What Foundry showed when the window took the module
 * @returns {Map<string, string>}
 */
export function restingTexts(moduleId, english, clean) {
  const {pick, texts} = wantedTexts(moduleId, english);
  const previous = state.get(moduleId);
  const originals = previous?.originals ?? new Map();
  const out = new Map(texts);
  for ( const key of previous?.texts.keys() ?? [] ) {
    if ( !texts.has(key) ) out.set(key, originals.get(key) ?? english.get(key));
  }
  for ( const key of texts.keys() ) if ( !originals.has(key) ) originals.set(key, clean.get(key) ?? english.get(key));
  if ( texts.size || originals.size ) state.set(moduleId, {pick, texts, originals});
  return out;
}

/** What is in use in this browser, for the self test, the debug file and the tests (counts only). */
export function describeUse() {
  return [...state].map(([id, s]) => ({module: id, lang: s.pick?.lang ?? null, source: s.pick?.source ?? null, keys: s.texts.size}));
}

/** The GM changed the shared translations: follow in this browser. */
export function onSharedChanged() {
  for ( const [id, keys] of applyAll() ) refresh(id, keys);
}

/** Apply at i18nInit, check again at ready, follow a change of a module language. Call at the top of the entry file. */
export function registerUse() {
  Hooks.once("i18nInit", () => {
    const written = applyAll();
    if ( written.size ) trace.add("use", {modules: written.size, keys: [...written.values()].reduce((n, k) => n + k.length, 0)});
  });
  Hooks.once("ready", () => setTimeout(() => {
    for ( const [id, s] of state ) {
      if ( inWindow(id) ) continue;
      const lost = [...s.texts].some(([key, text]) => foundry.utils.getProperty(game.i18n.translations, key) !== text);
      if ( lost ) refresh(id, applyModule(id));
    }
  }, 0));
  Hooks.on("clientSettingChanged", key => {
    const match = (typeof key === "string") ? key.match(/^(sephrals-[a-z0-9-]+)\.uiLanguage$/) : null;
    if ( !match || (match[1] === "sephrals-translator") ) return;
    for ( const delay of [300, 1500] ) {
      setTimeout(() => {
        if ( !inWindow(match[1]) ) refresh(match[1], applyModule(match[1]));
      }, delay);
    }
  });
}
