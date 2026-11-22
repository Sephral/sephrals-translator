/**
 * The modules that can be translated: the installed and active ones of Sephral, with their English file, the progress
 * per module and the language files they already ship.
 */

import {coverage, analyzeRow, moduleNeeds, SYSTEM_NAMES} from "./translator-logic.mjs";
import {flatten} from "./translate-checks.mjs";
import {loadDraft} from "./store.mjs";

/** Parsed language files by module and language (null: none). */
const files = new Map();

/**
 * The modules of Sephral that ship an English file: the active ones, and the installed ones that cannot run in this
 * world (made for another game system, or a required module is missing). Those can be translated, not seen.
 * @returns {{id: string, title: string, version: string, manifest: object, needs: {systems: string[], modules: string[]}|null}[]}
 */
export function listModules() {
  const out = [];
  for ( const [id, mod] of game.modules.entries() ) {
    if ( !id.startsWith("sephrals-") ) continue;
    if ( ![...(mod.languages ?? [])].some(l => l.lang === "en") ) continue;
    const needs = needsOf(id);
    if ( !mod.active && !needs ) continue;
    out.push({id, title: mod.title, version: mod.version ?? "", manifest: mod, needs});
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** The answer of unavailableModules, once per session. */
let unavailable = null;

/**
 * Modules of Sephral that are installed but that Foundry leaves out of this world entirely (made for another game
 * system: they are not even in game.modules), each with what it needs. Read through the file browser (GMs and trusted
 * players), else none.
 * @returns {Promise<{id: string, title: string, needs: {systems: string[], modules: string[]}}[]>}
 */
export function unavailableModules() {
  unavailable ??= (async () => {
    const FP = foundry.applications.apps?.FilePicker?.implementation;
    if ( !FP || !game.user.can("FILES_BROWSE") ) return [];
    let dirs = [];
    try {
      dirs = (await FP.browse("data", "modules")).dirs ?? [];
    } catch {
      return [];
    }
    const out = [];
    for ( const dir of dirs ) {
      const id = String(dir).split("/").pop();
      if ( !id.startsWith("sephrals-") || game.modules.has(id) ) continue;
      try {
        const manifest = await (await fetch(`${dir}/module.json`)).json();
        const needs = moduleNeeds(manifest.relationships, {systemId: game.system?.id ?? "", active: mid => !!game.modules.get(mid)?.active});
        if ( !needs.systems.length && !needs.modules.length ) continue;
        if ( !(manifest.languages ?? []).some(l => l.lang === "en") ) continue;
        out.push({id, title: manifest.title ?? id, needs});
      } catch {
        /* a folder without a readable manifest */
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  })();
  return unavailable;
}

/**
 * What a module needs that this world lacks, or null when it can run here.
 * @param {string} moduleId
 * @returns {{systems: string[], modules: string[]}|null}
 */
export function needsOf(moduleId) {
  const mod = game.modules.get(moduleId);
  if ( !mod ) return null;
  const needs = moduleNeeds(mod.relationships, {systemId: game.system?.id ?? "", active: id => !!game.modules.get(id)?.active});
  return (needs.systems.length || needs.modules.length) ? needs : null;
}

/**
 * The needs as words: "the game system Crucible and the module Ember".
 * @param {{systems: string[], modules: string[]}} needs
 * @param {(key: string, data?: object) => string} t
 * @returns {string}
 */
export function needsText(needs, t) {
  const parts = [];
  if ( needs.systems.length ) parts.push(t("STL.Needs.system", {name: needs.systems.map(id => SYSTEM_NAMES[id] ?? (id.charAt(0).toUpperCase() + id.slice(1))).join(" / ")}));
  for ( const id of needs.modules ) parts.push(t("STL.Needs.module", {name: game.modules.get(id)?.title ?? (id.charAt(0).toUpperCase() + id.slice(1))}));
  return parts.join(t("STL.Needs.and"));
}

/**
 * Read one of the language files a module ships (from its manifest list, so no request goes to a missing file).
 * @param {string} moduleId
 * @param {string} lang
 * @returns {Promise<object|null>}
 */
export async function readLangFile(moduleId, lang) {
  const id = `${moduleId}|${lang}`;
  if ( !files.has(id) ) {
    const entry = [...(game.modules.get(moduleId)?.languages ?? [])].find(l => l.lang === lang);
    files.set(id, entry ? fetch(entry.path).then(r => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
  }
  return files.get(id);
}

/** Does the module ship a file for the language? */
export function shipsLang(moduleId, lang) {
  return [...(game.modules.get(moduleId)?.languages ?? [])].some(l => l.lang === lang);
}

/**
 * Progress of a module in a language, in words: from the stored draft, else from the file the module ships.
 * @param {string} moduleId
 * @param {string} lang
 * @returns {Promise<ReturnType<typeof coverage>|null>}
 */
export async function progressOf(moduleId, lang) {
  const enObj = await readLangFile(moduleId, "en");
  if ( !enObj ) return null;
  const en = flatten(enObj);
  let texts = null;
  const draft = loadDraft(moduleId, lang, en);
  if ( draft && Object.keys(draft.texts).length ) texts = draft.texts;
  else if ( shipsLang(moduleId, lang) ) texts = Object.fromEntries(flatten((await readLangFile(moduleId, lang)) ?? {}));
  const rows = [...en].map(([key, value]) => analyzeRow(key, value, texts?.[key] ?? "", draft, lang));
  return coverage(rows);
}
