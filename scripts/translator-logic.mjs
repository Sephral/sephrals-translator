/**
 * Pure parts of the translator: language codes, the rows of the editor and their status, drafts, export, import and the
 * payload of a submission. No Foundry, no DOM, so node can test all of it. Every foreign text (a file the translator
 * imports, a draft read back from the browser) is treated as hostile input.
 */

import {CODES, FORBIDDEN_KEYS, checkValue, flatten, placeholders, sourceHash, unflatten, wordCount} from "./translate-checks.mjs";

/**
 * Where translations are handed in: Sephral's Discord server (the channel named here) or an issue on GitHub. The module
 * itself sends nothing anywhere, it saves a file that the translator attaches there (decision of 2026-11-22).
 */
export const DISCORD_URL = "https://discord.gg/7BjCgDYaBP";
export const DISCORD_CHANNEL = "translations";

/** The ways a translation is handed in. */
export const SUBMIT_VIA = Object.freeze(["discord", "github"]);

/** The version of the consent text the dialog shows (field "consent" of the submission file). */
export const CONSENT_VERSION = "t1";

/** Limits: name and note in the file, imported files, one text, the text put into a new GitHub issue. */
export const LIMITS = Object.freeze({name: 60, note: 500, file: 2_000_000, text: 2000, issueBody: 6000});

/** The statuses of a row, in the order of the filter. */
export const STATUSES = Object.freeze(["ok", "open", "check", "changed", "warning", "error"]);

/** Errors for which the preview keeps the English text, because the text could act as markup in some place. */
export const PREVIEW_BLOCKERS = new Set([CODES.TAG, CODES.TAG_ATTRIBUTES, CODES.ANGLE, CODES.ENTITY,
  CODES.HANDLEBARS, CODES.ENRICHER, CODES.CONTROL, CODES.BIDI, CODES.ZERO_WIDTH,
  CODES.URL, CODES.TOO_LONG, CODES.NOT_STRING]);

/** A dictionary without prototype, so a key like "__proto__" is only a key. */
export function dict(entries = null) {
  const out = Object.create(null);
  if ( entries ) for ( const [key, value] of Object.entries(entries) ) if ( !FORBIDDEN_KEYS.includes(key) ) out[key] = value;
  return out;
}

/* -------------------------------------------- */
/*  Languages                                   */
/* -------------------------------------------- */

/**
 * Check a language code (letters, optionally a region like pt-BR) and bring it to the usual spelling.
 * @param {*} input
 * @returns {string|null}   The normalized code, or null when it is not a language code
 */
export function normalizeLang(input) {
  if ( typeof input !== "string" ) return null;
  const match = input.trim().replace("_", "-").match(/^([A-Za-z]{2,3})(?:-([A-Za-z]{2}|[0-9]{3}))?$/);
  if ( !match ) return null;
  return match[1].toLowerCase() + (match[2] ? `-${match[2].toUpperCase()}` : "");
}

/**
 * Languages the picker always offers: the ones Foundry communities translate into most, with the codes Foundry modules
 * use (`cn` for simplified Chinese, `zh-TW` for traditional). Anything else is typed under "Other language".
 */
export const LANGUAGES = Object.freeze(["ar", "bg", "ca", "cn", "cs", "da", "de", "el", "es", "et", "fa", "fi", "fr", "he", "hi",
  "hr", "hu", "id", "it", "ja", "ko", "lt", "lv", "nb", "nl", "pl", "pt", "pt-BR", "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr",
  "uk", "vi", "zh-TW"]);

/** The value of the "Other language" entry of the picker. */
export const OTHER_LANGUAGE = "__other";

/**
 * The choices of the language picker: the list above, more codes (Foundry's languages, the module's files) and the
 * current language, never English. Each is named in the interface language and in itself, sorted by the first name.
 * @param {object} options
 * @param {string[]} [options.extra]
 * @param {string|null} [options.current]
 * @param {string[]} [options.shipped]   languages the module ships (marked)
 * @param {(code: string) => {local?: string, native?: string}} options.nameOf
 * @returns {{code: string, label: string, shipped: boolean}[]}
 */
export function languageChoices({extra = [], current = null, shipped = [], nameOf}) {
  const codes = new Set();
  for ( const raw of [...LANGUAGES, ...extra, ...(current ? [current] : [])] ) {
    const code = normalizeLang(raw);
    if ( code && (code !== "en") ) codes.add(code);
  }
  const have = new Set(shipped.map(normalizeLang).filter(Boolean));
  return [...codes].map(code => {
    const {local = "", native = ""} = nameOf?.(code) ?? {};
    const names = [...new Set([local, native].filter(n => n && (n.toLowerCase() !== code.toLowerCase())))];
    return {code, shipped: have.has(code), label: names.length ? `${names.join(" · ")} (${code})` : code};
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/* -------------------------------------------- */
/*  Keys, groups, rows                          */
/* -------------------------------------------- */

/**
 * The group of a key: its second part (SRR.Window.Send.Button is in "Window"), keys with two parts are in "".
 * @param {string} key
 * @returns {string}
 */
export function groupOf(key) {
  const parts = String(key).split(".");
  return parts.length > 2 ? parts[1] : "";
}

/**
 * The placeholder names of a text that make a count, for which a plural hint helps.
 * @param {string} english
 * @returns {string[]}
 */
export function countPlaceholders(english) {
  return placeholders(english).map(p => String(p).replace(/[{}]/g, "")).filter(name => /^(count|n|total|num|number|amount)$/i.test(name));
}

/**
 * One row of the editor.
 * @param {string} key
 * @param {string} english
 * @param {string} text            What the translator typed (may be empty)
 * @param {{src?: object, review?: object}} meta   The stored source hashes and review marks
 * @param {string} lang
 * @returns {{key: string, group: string, en: string, text: string, status: string, errors: object[], warnings: object[],
 *   words: number, translated: boolean, blocked: boolean}}
 */
export function analyzeRow(key, english, text, meta, lang) {
  const blank = String(text ?? "").trim() === "";
  const result = blank ? {errors: [], warnings: []} : checkValue(english, text, {lang});
  const changed = !blank && !!meta?.src?.[key] && (meta.src[key] !== sourceHash(english));
  let status = "ok";
  if ( blank ) status = "open";
  else if ( result.errors.length ) status = "error";
  else if ( changed ) status = "changed";
  else if ( meta?.review?.[key] ) status = "check";
  else if ( result.warnings.length ) status = "warning";
  const identical = result.warnings.some(w => w.code === CODES.IDENTICAL);
  return {
    key, group: groupOf(key), en: english, text: text ?? "", status,
    errors: result.errors, warnings: result.warnings,
    words: wordCount(english),
    translated: !blank && !result.errors.length && !identical,
    blocked: result.errors.some(e => PREVIEW_BLOCKERS.has(e.code))
  };
}

/**
 * Words and keys translated.
 * @param {object[]} rows
 * @returns {{keys: number, translatedKeys: number, words: number, translatedWords: number, percent: number}}
 */
export function coverage(rows) {
  const out = {keys: rows.length, translatedKeys: 0, words: 0, translatedWords: 0, percent: 0};
  for ( const row of rows ) {
    out.words += row.words;
    if ( row.translated ) {
      out.translatedKeys++;
      out.translatedWords += row.words;
    }
  }
  out.percent = out.words ? Math.round((out.translatedWords / out.words) * 100) : 0;
  return out;
}

/**
 * How many rows there are per status.
 * @param {object[]} rows
 * @returns {Record<string, number>}
 */
export function statusCounts(rows) {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  counts.all = rows.length;
  for ( const row of rows ) counts[row.status]++;
  return counts;
}

/**
 * Rows for a filter: a status, a group, a search in keys and texts.
 * @param {object[]} rows
 * @param {{status?: string, group?: string, query?: string, de?: Map<string, string>}} filter
 * @returns {object[]}
 */
export function filterRows(rows, {status = "all", group = "", query = "", de = null} = {}) {
  const q = String(query).trim().toLowerCase();
  return rows.filter(row => {
    if ( status !== "all" && row.status !== status ) return false;
    if ( group && row.group !== group ) return false;
    if ( !q ) return true;
    return row.key.toLowerCase().includes(q) || row.en.toLowerCase().includes(q) || row.text.toLowerCase().includes(q)
      || String(de?.get(row.key) ?? "").toLowerCase().includes(q);
  });
}

/**
 * The text the preview shows for a row: the translation, or the English text when there is none or when the text could
 * act as markup in the interface (ui.notifications inserts HTML).
 * @param {object} row
 * @returns {string}
 */
export function previewText(row) {
  return (!row.text.trim() || row.blocked) ? row.en : row.text;
}

/**
 * Put a placeholder into a text at the cursor.
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {string} insert
 * @returns {{value: string, cursor: number}}
 */
export function insertAt(value, start, end, insert) {
  const a = Math.max(0, Math.min(Number(start) || 0, value.length));
  const b = Math.max(a, Math.min(Number(end) || a, value.length));
  return {value: value.slice(0, a) + insert + value.slice(b), cursor: a + insert.length};
}

/**
 * A recommended length from the English text, and how the translation compares.
 * @param {string} english
 * @param {string} text
 * @returns {{recommended: number, length: number, ratio: number}}
 */
export function lengthInfo(english, text) {
  const length = [...String(text ?? "")].length;
  const recommended = [...english].length;
  return {recommended, length, ratio: recommended ? Math.round((length / recommended) * 10) / 10 : 0};
}

/* -------------------------------------------- */
/*  Drafts                                      */
/* -------------------------------------------- */

/**
 * notes: what a reviewer wrote about texts of this translation (imported from a review file), key to
 * {verdict, suggestion, comment, reviewer}.
 * @returns {{texts: object, src: object, base: object, review: object, saved: number, history: object[], notes: object}}
 */
export function emptyDraft() {
  return {texts: dict(), src: dict(), base: dict(), review: dict(), saved: 0, history: [], notes: dict()};
}

/** The key of a draft in the client setting. */
export function draftKey(moduleId, lang) {
  return `${moduleId}|${lang}`;
}

/**
 * A draft read back from storage, reduced to what is valid: keys of the English file, texts, 8 hex hashes. Everything
 * else is dropped.
 * @param {*} raw
 * @param {Map<string, string>} enFlat
 * @returns {ReturnType<emptyDraft>}
 */
export function sanitizeDraft(raw, enFlat) {
  const draft = emptyDraft();
  if ( !raw || (typeof raw !== "object") ) return draft;
  for ( const [key, value] of Object.entries(raw.texts ?? {}) ) {
    if ( !enFlat.has(key) || (typeof value !== "string") || (value.length > LIMITS.text * 5) ) continue;
    draft.texts[key] = value;
    const hash = raw.src?.[key];
    if ( (typeof hash === "string") && /^[0-9a-f]{8}$/.test(hash) ) draft.src[key] = hash;
    const base = raw.base?.[key];
    if ( (typeof base === "string") && (base.length <= LIMITS.text * 5) ) draft.base[key] = base;
    if ( raw.review?.[key] === true ) draft.review[key] = true;
  }
  draft.saved = Number.isFinite(raw.saved) ? raw.saved : 0;
  draft.history = sanitizeHistory(raw, enFlat);
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  for ( const [key, note] of Object.entries(raw.notes ?? {}) ) {
    if ( !enFlat.has(key) || !note || !["ok", "change"].includes(note.verdict) ) continue;
    draft.notes[key] = {verdict: note.verdict, suggestion: text(note.suggestion, LIMITS.text), comment: text(note.comment, 500),
      reviewer: text(note.reviewer, 60)};
  }
  return draft;
}

/* -------------------------------------------- */
/*  Earlier submissions                         */
/* -------------------------------------------- */

/** How many submissions a draft remembers, and for how many of the newest it keeps the texts that were handed in. */
export const HISTORY_MAX = 10;
export const HISTORY_TEXTS = 3;

/**
 * The submissions of a stored draft, reduced to what is valid: time, module version, the way (Discord or GitHub), the
 * number of texts and, for the newest, the texts themselves.
 * @param {object} raw
 * @param {Map<string, string>} enFlat
 * @returns {object[]}
 */
function sanitizeHistory(raw, enFlat) {
  const list = Array.isArray(raw.history) ? raw.history : [];
  const out = [];
  for ( const entry of list ) {
    if ( !entry || (typeof entry !== "object") || (out.length >= HISTORY_MAX) ) continue;
    if ( !SUBMIT_VIA.includes(entry.via) || !Number.isFinite(entry.at) ) continue;
    let texts = null;
    if ( entry.texts && (typeof entry.texts === "object") && (out.length < HISTORY_TEXTS) ) {
      texts = dict();
      for ( const [key, value] of Object.entries(entry.texts) ) {
        if ( enFlat.has(key) && (typeof value === "string") && value.trim() && (value.length <= LIMITS.text * 5) ) texts[key] = value;
      }
    }
    out.push({
      at: entry.at,
      version: String(entry.version ?? "").replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 30),
      via: entry.via,
      count: Math.max(0, Math.floor(Number(entry.count) || 0)),
      texts
    });
  }
  return out;
}

/**
 * Remember a submission, newest first. Only the newest entries keep their texts.
 * @param {ReturnType<emptyDraft>} draft
 * @param {{at: number, version?: string, via: string, texts: object}} entry
 * @returns {object}   The new entry
 */
export function addHistory(draft, {at, version = "", via, texts}) {
  const copy = dict();
  for ( const [key, value] of Object.entries(texts ?? {}) ) if ( typeof value === "string" ) copy[key] = value;
  const entry = {at, version: String(version ?? ""), via: SUBMIT_VIA.includes(via) ? via : "discord", count: Object.keys(copy).length, texts: copy};
  draft.history = [entry, ...(draft.history ?? [])].slice(0, HISTORY_MAX);
  draft.history.forEach((e, i) => {
    if ( i >= HISTORY_TEXTS ) e.texts = null;
  });
  return entry;
}

/**
 * The newest submission whose texts are kept: what the translator compares with.
 * @param {ReturnType<emptyDraft>} draft
 * @returns {object|null}
 */
export function lastSent(draft) {
  return (draft.history ?? []).find(e => e.texts) ?? null;
}

/**
 * The texts that would be sent now: the translated rows.
 * @param {object[]} rows
 * @returns {Record<string, string>}
 */
/** Kinds of places the translator can show as an example: a notification, a chat message, a question. */
export const SIMULATED = Object.freeze(["notify", "chat", "dialog"]);

/**
 * What a module needs that this world lacks: the game systems it is made for (when none of them runs here) and the
 * modules it requires that are not active.
 * @param {{systems?: {id: string}[], requires?: {id: string, type?: string}[]}|null} relationships   of the manifest
 * @param {{systemId: string, active: (id: string) => boolean}} world
 * @returns {{systems: string[], modules: string[]}}   ids; both empty when the module can run here
 */
export function moduleNeeds(relationships, {systemId, active}) {
  const systems = [...(relationships?.systems ?? [])].map(s => s?.id).filter(Boolean);
  const modules = [...(relationships?.requires ?? [])].filter(r => r?.id && ((r.type ?? "module") === "module") && !active(r.id)).map(r => r.id);
  return {systems: (systems.length && !systems.includes(systemId)) ? systems : [], modules};
}

/** Names of game systems that may not be installed here (for the notice). */
export const SYSTEM_NAMES = Object.freeze({crucible: "Crucible", dnd5e: "D&D 5e", pf2e: "Pathfinder 2e", sf2e: "Starfinder 2e", swade: "Savage Worlds",
  daggerheart: "Daggerheart", tormenta20: "Tormenta20"});

/** Sample values for placeholders, so an example reads like the real text. */
const SAMPLES = [
  [/^(count|n|number|total|done|amount|seconds|minutes|hours|round|turn|max|min|value|answers|online|votes|avg|left|size|level)$/i, "3"],
  [/(name|player|actor|user|reviewer|translator|speaker|target|who|owner|character)/i, "Ada"]
];

/**
 * A text with sample values in its placeholders ({count} 3, {name} Ada, {module} the module), others stay visible.
 * @param {string} text
 * @param {{module?: string}} [options]
 * @returns {string}
 */
export function sampleText(text, {module = ""} = {}) {
  return String(text ?? "").replace(/\{([A-Za-z0-9_.]+)\}/g, (match, name) => {
    if ( /^module$/i.test(name) ) return module || match;
    for ( const [rx, value] of SAMPLES ) if ( rx.test(name) ) return value;
    return match;
  });
}

/** Statuses that still want work: the next-text key skips the others. */
export const TODO_STATUSES = Object.freeze(["open", "error", "changed", "check"]);

/**
 * The next key that still wants work, in the order of the list, after the current one (wraps around).
 * @param {string[]} order                    keys in list order
 * @param {Map<string, {status: string}>} rows
 * @param {string|null} current
 * @param {number} [dir]                      1 forward, -1 backward
 * @returns {string|null}
 */
export function nextTodoKey(order, rows, current, dir = 1) {
  const n = order.length;
  if ( !n ) return null;
  const at = order.indexOf(current);
  for ( let step = 1; step <= n; step++ ) {
    const key = order[(((at < 0 ? (dir > 0 ? -1 : 0) : at) + (dir * step)) % n + n) % n];
    if ( (key !== current) && TODO_STATUSES.includes(rows.get(key)?.status) ) return key;
  }
  return null;
}

/** An English text as the memory compares it: trimmed, spaces folded, case kept. */
export function memoryKey(english) {
  return String(english ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Translations people already made for the same English text: other texts of this module, drafts of other modules
 * and the files modules ship in the language. Distinct texts, the most used first.
 * @param {Map<string, {text: string, where: string}[]>} memory   memoryKey(english) to translations
 * @param {string} english
 * @param {{own?: string}} [options]   own: the current translation, left out
 * @returns {{text: string, where: string[], count: number}[]}
 */
export function memoryFor(memory, english, {own = ""} = {}) {
  const found = new Map();
  for ( const item of memory.get(memoryKey(english)) ?? [] ) {
    const text = String(item.text ?? "");
    if ( !text.trim() || (text === own) ) continue;
    const entry = found.get(text) ?? {text, where: [], count: 0};
    entry.count++;
    if ( !entry.where.includes(item.where) ) entry.where.push(item.where);
    found.set(text, entry);
  }
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, 3);
}

/**
 * Other texts of the module with the same English that have no translation yet.
 * @param {Map<string, {en: string, status: string}>} rows
 * @param {string} key
 * @returns {string[]}
 */
export function sameEnglishOpen(rows, key) {
  const english = memoryKey(rows.get(key)?.en);
  if ( !english ) return [];
  return [...rows.entries()].filter(([k, row]) => (k !== key) && (row.status === "open") && (memoryKey(row.en) === english)).map(([k]) => k);
}

/**
 * The detail of a check in the UI language: the lang key and its values, or null when the label says it all.
 * The checks library words its messages in English and hands the parts over as data.
 * @param {{code: string, data?: object}} item
 * @param {string} [none]   shown for an empty list
 * @returns {{key: string, data: Record<string, string>}|null}
 */
export function checkDetail(item, none = "-") {
  const data = item?.data;
  if ( !data || (typeof data !== "object") ) return null;
  const value = v => ((typeof v === "number") ? String(v) : ((typeof v === "string") && v) ? v : none);
  return {key: `STL.CheckDetail.${item.code}`, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, value(v)]))};
}

export function sendableTexts(rows) {
  const out = dict();
  for ( const row of rows ) if ( row.translated ) out[row.key] = row.text.normalize("NFC");
  return out;
}

/**
 * Keys whose text differs from a submission: changed, added or no longer translated.
 * @param {object|null} entry
 * @param {object[]} rows
 * @returns {Set<string>}
 */
export function changedSince(entry, rows) {
  const out = new Set();
  if ( !entry?.texts ) return out;
  const now = sendableTexts(rows);
  for ( const row of rows ) if ( (now[row.key] ?? "") !== (entry.texts[row.key] ?? "") ) out.add(row.key);
  return out;
}

/**
 * Would a submission now send exactly what the newest submission sent?
 * @param {ReturnType<emptyDraft>} draft
 * @param {object[]} rows
 * @returns {boolean}
 */
export function unchangedSinceLast(draft, rows) {
  const entry = lastSent(draft);
  return !!entry && !changedSince(entry, rows).size;
}

/**
 * The file name of the copy a translator keeps of a submission: module, language, local date and time.
 * @param {string} moduleId
 * @param {string} lang
 * @param {number} at
 * @returns {string}
 */
export function copyFileName(moduleId, lang, at) {
  const d = new Date(at);
  const two = n => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  return `${String(moduleId).replace(/[^a-z0-9-]/g, "")}-${normalizeLang(lang) ?? "xx"}-${stamp}.json`;
}

/**
 * The copy of a submission as a language file (nesting and order of the English file), which Import takes back.
 * @param {object} enObj
 * @param {Record<string, string>} texts
 * @returns {string}
 */
export function copyFileText(enObj, texts) {
  return `${JSON.stringify(unflatten(new Map(Object.entries(texts ?? {})), enObj), null, 2)}\n`;
}

/* -------------------------------------------- */
/*  Using a translation                         */
/* -------------------------------------------- */

/** preview: only while the window is open, me: always in this browser, world: for everybody in the world (GM). */
export const USE_MODES = Object.freeze(["preview", "me", "world"]);

const MODULE_ID_PATTERN = /^sephrals-[a-z0-9-]{1,60}$/;

/**
 * The namespace of a Sephral module: a short prefix like SRR, FOLIO or scbr, never one of Foundry's long words like
 * SETTINGS or DOCUMENT. The client setting is the user's own data and only a GM can write the world setting, so this is
 * a guard against mistakes. The key must also have an English text, so nothing new is ever added.
 */
const ROOT_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,5}$/;

/** Parse a setting text into a plain object, or null. */
function parseObject(json, max) {
  try {
    const data = (typeof json === "string") && (json.length < max) ? JSON.parse(json) : null;
    return data && (typeof data === "object") && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * The client setting "use": module id to the language this browser uses.
 * @param {*} json
 * @returns {Record<string, string>}
 */
export function parseUse(json) {
  const out = dict();
  for ( const [id, lang] of Object.entries(parseObject(json, 20_000) ?? {}) ) {
    const code = normalizeLang(lang);
    if ( MODULE_ID_PATTERN.test(id) && code && (code !== "en") ) out[id] = code;
  }
  return out;
}

/**
 * The world setting "shared": module id to {lang, texts, at}, written by a GM. Read like a hostile input.
 * @param {*} json
 * @returns {Record<string, {lang: string, texts: Record<string, string>, at: number}>}
 */
export function parseShared(json) {
  const out = dict();
  for ( const [id, entry] of Object.entries(parseObject(json, 8_000_000) ?? {}) ) {
    const lang = normalizeLang(entry?.lang);
    if ( !MODULE_ID_PATTERN.test(id) || !lang || (lang === "en") || !entry.texts || (typeof entry.texts !== "object") ) continue;
    const texts = dict();
    for ( const [key, value] of Object.entries(entry.texts) ) {
      if ( usableKey(key) && (typeof value === "string") && value.trim() && (value.length <= LIMITS.text * 5) ) texts[key] = value;
    }
    out[id] = {lang, texts, at: Number.isFinite(entry.at) ? entry.at : 0};
  }
  return out;
}

/**
 * May a used translation write this key into Foundry's translations? Only keys under a module prefix.
 * @param {string} key
 * @returns {boolean}
 */
export function usableKey(key) {
  if ( (typeof key !== "string") || (key.length > 200) ) return false;
  const parts = key.split(".");
  return (parts.length >= 2) && ROOT_PATTERN.test(parts[0]) && !parts.some(part => !part || FORBIDDEN_KEYS.includes(part));
}

/**
 * The mode of a module and language in the translator window.
 * @param {string} moduleId
 * @param {string} lang
 * @param {Record<string, string>} use
 * @param {Record<string, object>} shared
 * @returns {"preview"|"me"|"world"}
 */
export function useModeOf(moduleId, lang, use, shared) {
  if ( use[moduleId] === lang ) return "me";
  if ( shared[moduleId]?.lang === lang ) return "world";
  return "preview";
}

/**
 * Which translation a browser uses for a module: its own choice first, else the one the GM shared, unless the user
 * picked a fixed language for that module.
 * @param {string} moduleId
 * @param {{use: Record<string, string>, shared: Record<string, object>, forced?: boolean}} state
 * @returns {{lang: string, source: "me"|"world"}|null}
 */
export function pickUse(moduleId, {use, shared, forced = false}) {
  if ( use[moduleId] ) return {lang: use[moduleId], source: "me"};
  if ( shared[moduleId] && !forced ) return {lang: shared[moduleId].lang, source: "world"};
  return null;
}

/**
 * The texts of a translation that may go into Foundry's translations: a key with an English text, under a module
 * prefix, a text without any error of the checks.
 * @param {Record<string, string>} texts
 * @param {Map<string, string>} english
 * @param {string} lang
 * @returns {Map<string, string>}
 */
export function usableTexts(texts, english, lang) {
  const out = new Map();
  for ( const [key, text] of Object.entries(texts ?? {}) ) {
    const en = english.get(key);
    if ( (typeof en !== "string") || (typeof text !== "string") || !text.trim() || !usableKey(key) ) continue;
    if ( checkValue(en, text, {lang}).errors.length ) continue;
    out.set(key, text.normalize("NFC"));
  }
  return out;
}

/**
 * Read the drafts of all modules out of the setting string.
 * @param {*} json
 * @returns {Record<string, object>}
 */
export function parseDrafts(json) {
  const out = dict();
  if ( (typeof json !== "string") || !json || (json.length > 8_000_000) ) return out;
  try {
    const data = JSON.parse(json);
    if ( data && (typeof data === "object") ) {
      for ( const [key, value] of Object.entries(data) ) if ( /^[a-z0-9_-]+\|[A-Za-z-]+$/.test(key) ) out[key] = value;
    }
  } catch {
    /* a broken setting is the same as no drafts */
  }
  return out;
}

/**
 * Set the text of a key in a draft, together with the hash of the English text it was written for.
 * @param {ReturnType<emptyDraft>} draft
 * @param {string} key
 * @param {string} english
 * @param {string} text
 */
export function setDraftText(draft, key, english, text) {
  if ( FORBIDDEN_KEYS.includes(key) ) return;
  if ( String(text).trim() === "" ) {
    delete draft.texts[key];
    delete draft.src[key];
    delete draft.base[key];
    delete draft.review[key];
    return;
  }
  draft.texts[key] = text;
  draft.src[key] = sourceHash(english);
  draft.base[key] = english;
}

/**
 * The translator read the new English text and keeps the translation: store the new hash and text.
 * @param {ReturnType<emptyDraft>} draft
 * @param {string} key
 * @param {string} english
 */
export function acceptEnglish(draft, key, english) {
  if ( !(key in draft.texts) ) return;
  draft.src[key] = sourceHash(english);
  draft.base[key] = english;
}

/**
 * Keys whose English text changed since the translation was written: the new hash differs from the stored one.
 * @param {ReturnType<emptyDraft>} draft
 * @param {Map<string, string>} enFlat
 * @returns {string[]}
 */
export function changedKeys(draft, enFlat) {
  return Object.keys(draft.texts).filter(key => draft.src[key] && enFlat.has(key) && (draft.src[key] !== sourceHash(enFlat.get(key))));
}

/* -------------------------------------------- */
/*  Export and import                           */
/* -------------------------------------------- */

/**
 * The file lang/<code>.json: nesting and order of the English file, only translated keys.
 * @param {object} enObj
 * @param {object[]} rows
 * @returns {{text: string, keys: number, skipped: string[]}}   skipped: keys left out because of errors
 */
export function exportFile(enObj, rows) {
  const entries = new Map();
  const skipped = [];
  for ( const row of rows ) {
    if ( !row.text.trim() ) continue;
    if ( row.errors.length ) skipped.push(row.key);
    else entries.set(row.key, row.text);
  }
  return {text: `${JSON.stringify(unflatten(entries, enObj), null, 2)}\n`, keys: entries.size, skipped};
}

/**
 * Check a file the translator brought in, like a hostile input. Texts with errors are rejected one by one, the rest is
 * accepted. A file that is not a JSON object, too big or not parseable is rejected as a whole.
 * A language file and a submission file of the translator are both taken.
 * @param {*} text
 * @param {object} enObj
 * @param {string} lang
 * @param {string} [module]   The module open in the window: a submission file of another module is refused
 * @returns {{ok: boolean, reason?: string, accepted: Map<string, string>, rejected: {key: string, codes: string[]}[],
 *   unknown: string[], nonStrings: string[], skipped: string[]}}
 */
export function parseImport(text, enObj, lang, module = null) {
  const out = {ok: false, accepted: new Map(), rejected: [], unknown: [], nonStrings: [], skipped: []};
  if ( typeof text !== "string" ) return {...out, reason: "not-text"};
  if ( text.length > LIMITS.file ) return {...out, reason: "too-big"};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {...out, reason: "bad-json"};
  }
  // A submission file of the translator (its own copy) carries the texts flat under "keys"
  if ( isSubmission(data) ) {
    if ( (typeof module === "string") && module && (data.module !== module) ) return {...out, reason: "other-module"};
    data = data.keys;
  }
  const report = {};
  const flat = flatten(data, {report});
  if ( report.notObject ) return {...out, reason: "not-object"};
  const en = flatten(enObj);
  for ( const [key, value] of flat ) {
    if ( !en.has(key) ) {
      out.unknown.push(key);
      continue;
    }
    const result = checkValue(en.get(key), value, {lang});
    if ( result.errors.length ) out.rejected.push({key, codes: result.errors.map(e => e.code)});
    else if ( value.trim() ) out.accepted.set(key, value);
  }
  out.nonStrings = report.nonStrings ?? [];
  out.skipped = [...(report.skipped ?? []), ...(report.collisions ?? [])];
  out.ok = true;
  return out;
}

/* -------------------------------------------- */
/*  Submission                                  */
/* -------------------------------------------- */

/**
 * Check the optional fields of the submit dialog (no line break, no web address, a length limit).
 * @param {{name?: string, note?: string}} fields
 * @returns {Record<string, string>}   field to error code, empty when fine
 */
export function validateSubmitFields({name = "", note = ""} = {}) {
  const errors = {};
  const url = /(https?:|www\.)/i;
  for ( const [field, value, max] of [["name", name, LIMITS.name], ["note", note, LIMITS.note]] ) {
    if ( [...value].length > max ) errors[field] = "too-long";
    else if ( /[\r\n]/.test(value) ) errors[field] = "line-break";
    else if ( url.test(value) ) errors[field] = "url";
  }
  return errors;
}

/** Is this a submission file of the translator (format 1)? */
export function isSubmission(data) {
  return !!data && (typeof data === "object") && !Array.isArray(data) && (data.format === "sephrals-translation") && (data.v === 1)
    && !!data.keys && (typeof data.keys === "object") && !Array.isArray(data.keys) && (typeof data.module === "string");
}

/**
 * The file a translator hands in on Discord or GitHub: the translated texts flat, with the hash of the English text
 * each was written for, so the review sees which ones went stale. The review tool reads it as a submission.
 * @param {object} data
 * @param {string} data.module
 * @param {string} data.moduleVersion
 * @param {string} data.lang
 * @param {object[]} data.rows         The rows of the editor, only translated ones go in
 * @param {string} [data.name]         Name for the credits
 * @param {string} [data.note]
 * @param {number} [data.at]
 * @returns {object}   attest.machine is always "none": translations are made by hand only (No AI rule)
 */
export function buildSubmission({module, moduleVersion, lang, rows, name = "", note = "", at = Date.now()}) {
  const keys = {};
  const src = {};
  for ( const row of rows ) {
    if ( !row.translated ) continue;
    keys[row.key] = row.text.normalize("NFC");
    src[row.key] = sourceHash(row.en);
  }
  return {
    format: "sephrals-translation", v: 1, module, moduleVersion: String(moduleVersion ?? ""), lang,
    createdAt: new Date(at).toISOString(),
    credit: name.trim() ? {name: name.trim()} : {},
    attest: {reviewed: true, license: true, machine: "none"},
    consent: CONSENT_VERSION,
    note: note.trim(),
    keys, src
  };
}

/**
 * A link to a new issue with title and text filled in. The text is cut to stay within the length GitHub accepts in a
 * link, the file with the translation is attached by the translator.
 * @param {string} base    From issueUrl
 * @param {string} title
 * @param {string} body
 * @returns {string|null}
 */
export function issueLink(base, title, body) {
  if ( !base ) return null;
  const url = new URL(base);
  url.searchParams.set("title", String(title).slice(0, 200));
  url.searchParams.set("body", String(body).slice(0, LIMITS.issueBody));
  return url.toString();
}

/**
 * The page where a translator can open an issue for a module and attach the exported file.
 * @param {{bugs?: *, url?: string}} manifest
 * @returns {string|null}
 */
export function issueUrl(manifest) {
  const bugs = typeof manifest?.bugs === "string" ? manifest.bugs : manifest?.bugs?.url;
  let base = bugs || manifest?.url;
  if ( typeof base !== "string" ) return null;
  base = base.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if ( !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/issues)?$/.test(base) ) return null;
  return base.endsWith("/issues") ? `${base}/new` : `${base}/issues/new`;
}

/**
 * The title of a new issue, without the translator's texts.
 * @param {string} moduleTitle
 * @param {string} lang
 * @returns {string}
 */
export function issueTitle(moduleTitle, lang) {
  return `Translation: ${String(moduleTitle).slice(0, 80)} (${lang})`;
}

/**
 * The words of the chat command "/translate [module] [language]": a module by id, short id (roll-requests) or a part of
 * its title, a language by code. Both are optional and may come in either order.
 * @param {string} text
 * @param {{id: string, title: string}[]} modules
 * @returns {{module: string|null, lang: string|null}|null}   null when the text is not the command
 */
export function parseTranslateCommand(text, modules) {
  const match = plainChatText(text).match(/^\/translate(?:\s+(.*))?$/i);
  if ( !match ) return null;
  const out = {module: null, lang: null};
  for ( const word of (match[1] ?? "").split(/\s+/).filter(Boolean).slice(0, 4) ) {
    const lower = word.toLowerCase();
    const found = modules.find(m => m.id === lower || m.id === `sephrals-${lower}`) ?? (lower.length >= 4
      ? modules.find(m => m.title.toLowerCase().includes(lower) || m.id.includes(lower)) : null);
    if ( found && !out.module ) out.module = found.id;
    else if ( !out.lang && normalizeLang(word) ) out.lang = normalizeLang(word);
  }
  return out;
}

/**
 * The text of a chat input: Foundry 14 hands over the HTML of its editor ("<p>/translate x</p>"), Foundry 13 plain text.
 * @param {string} message
 * @returns {string}
 */
export function plainChatText(message) {
  return String(message ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The hook that tells a module that listens to redraw texts no render reaches (canvas labels). */
export const REFRESH_HOOK = "sephrals-translator.refresh";

/**
 * The payload of the refresh hook. `keys` is always a list of full keys: the changed ones, or every key of the module
 * after a restore (keys null).
 * @param {string} moduleId
 * @param {string[]} roots           Namespaces of the module (the first is its own)
 * @param {Iterable<string>|null} keys
 * @param {Iterable<string>} allKeys  Every key of the module
 * @returns {{module: string, moduleId: string, namespace: string, roots: string[], keys: string[]}}
 */
export function refreshPayload(moduleId, roots, keys, allKeys) {
  return {module: moduleId, moduleId, namespace: roots[0], roots: [...roots], keys: keys ? [...keys] : [...allKeys]};
}

/**
 * Does a module announce that it redraws its own canvas texts on the refresh hook? (`api.translatorRefresh = true`)
 * @param {object|null|undefined} api
 * @returns {boolean}
 */
export function listensToRefresh(api) {
  return !!api && (typeof api === "object") && (api.translatorRefresh === true);
}

/**
 * Does a listening module draw this key on the canvas? (`api.translatorRefreshKeys(key)` returns true)
 * @param {object} api
 * @param {string} key
 * @returns {boolean}
 */
export function drawsOnCanvas(api, key) {
  if ( !listensToRefresh(api) || (typeof api.translatorRefreshKeys !== "function") ) return false;
  try {
    return api.translatorRefreshKeys(key) === true;
  } catch {
    return false;
  }
}
