/**
 * Translation checks, the single source of rules for everything that touches community translations
 * (translator module, review tool, i18n-kit, CI). Pure ES module: no Foundry, no Node, no DOM.
 * It runs in browsers and in Node and has no imports.
 *
 * Copies of this file live as scripts/translate-checks.mjs in the modules that carry it (see _tools/sync-shared.mjs).
 * Change only this source.
 *
 * Message codes are stable strings (CODES). The human messages are short English, a UI may localize by code.
 * Messages repeat parts of the checked text, so they are escaped (control and invisible characters shown as \uXXXX)
 * and shortened. Show messages as text, never as HTML.
 */

/** Raise on every behavior change of a check (see README). */
export const CHECKS_LIB_VERSION = 1;

/** Longest text checkValue looks at. Longer texts are an error and nothing else is run (hostile input guard). */
export const MAX_VALUE_LENGTH = 10000;

/** Path segments that never enter a merge or an unflatten (prototype pollution). */
export const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);
const FORBIDDEN = new Set(FORBIDDEN_KEYS);
const MAX_DEPTH = 32;

export const CODES = Object.freeze({
  // hard errors
  NOT_STRING: "not-string",
  TOO_LONG: "too-long",
  PLACEHOLDER: "placeholder-mismatch",
  TAG: "tag-mismatch",
  TAG_ATTRIBUTES: "tag-attributes",
  ANGLE: "angle-brackets",
  ENTITY: "entity-mismatch",
  HANDLEBARS: "handlebars-mismatch",
  ENRICHER: "enricher-mismatch",
  URL: "url-not-in-english",
  CONTROL: "control-char",
  BIDI: "bidi-override",
  ZERO_WIDTH: "zero-width-char",
  UNKNOWN_KEY: "unknown-key",
  NOT_OBJECT: "not-object",
  // warnings
  EMPTY: "empty",
  IDENTICAL: "identical-to-english",
  LENGTH_LONG: "length-long",
  LENGTH_SHORT: "length-short",
  EDGE_SPACE: "edge-space",
  SCRIPT: "script-mismatch",
  PUNCTUATION: "punctuation",
  NOT_NFC: "not-nfc"
});

/* -------------------------------------------- */
/*  Extractors                                  */
/* -------------------------------------------- */

// All patterns are written so that a hostile text cannot make them quadratic: a class never runs over the character
// that starts the next attempt.
const RE_PLACEHOLDER = /\{\{[^{}]+\}\}|\{[A-Za-z0-9_.]+\}|%[sd]/g;
const RE_TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^<>]*)?)\/?>/g;
const RE_ENTITY = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{1,7}|#[xX][0-9A-Fa-f]{1,6});/g;
const RE_ENRICHER = /@[A-Za-z]+\[[^\[\]]*\]|\[\[[^\[\]]*\]\]/g;
const RE_URL = /(?:https?:\/\/|ftp:\/\/|www\.|javascript:|vbscript:|file:|data:)[^\s<>"]+/gi;
const RE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g;
const RE_BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const RE_ZERO_WIDTH = /[\u200B\u2060-\u2064\u180E\uFEFF\u{E0000}-\u{E007F}]/gu;
const RE_JOINERS = /[\u200C\u200D]/g;
// Languages that need ZWNJ and ZWJ in normal text.
const JOINER_LANGS = new Set(["fa", "ur", "ar", "ps", "ku", "ckb", "hi", "bn", "ta", "te", "ml", "kn", "si", "my", "km", "mr", "gu", "pa", "ne", "or", "as", "th"]);

const count = (text, re) => (text.match(re) ?? []).length;

/** Placeholders of a Foundry text: {name}, {{handlebars}}, printf style %s %d. Sorted and unique. */
export function placeholders(text) {
  return [...new Set(String(text).match(RE_PLACEHOLDER) ?? [])].sort();
}

/** HTML tags as "<b>", "</b>", "<br>", attributes ignored. Sorted (duplicates kept). */
export function htmlTags(text) {
  const found = [];
  for ( const m of String(text).matchAll(RE_TAG) ) found.push(`<${m[1]}${m[2].toLowerCase()}>`);
  return found.sort();
}

/** HTML tags in text order, normalized (lower case name, attributes kept with single spaces, no self closing slash). */
export function tagSequence(text) {
  const found = [];
  for ( const m of String(text).matchAll(RE_TAG) ) {
    const attrs = m[3].replace(/\/\s*$/, "").trim().replace(/\s+/g, " ");
    found.push(`<${m[1]}${m[2].toLowerCase()}${attrs ? ` ${attrs}` : ""}>`);
  }
  return found;
}

/** Enrichers and entities that must survive a translation: @UUID[...], [[/roll ...]], &nbsp;. Sorted. */
export function tokens(text) {
  const s = String(text);
  return [...(s.match(RE_ENRICHER) ?? []), ...(s.match(RE_ENTITY) ?? [])].sort();
}

/** Punctuation the public text rules forbid: a semicolon, an em or en dash, a spaced hyphen. Entities are ignored. */
export function punctuationProblems(text) {
  const plain = String(text).replace(/&[a-z#0-9]+;/gi, "");
  const found = [];
  if ( plain.includes(";") ) found.push(";");
  if ( /[–—]/.test(plain) ) found.push("dash");
  if ( / - /.test(plain) ) found.push("spaced hyphen");
  return found;
}

/** A text identical to English that is long enough to be an untranslated sentence. */
export function looksUntranslated(en, text) {
  return text === en && en.length >= 15 && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(en);
}

/** Multiset difference: what `expected` has and `actual` lacks, and the rest of `actual`. */
export function diffList(expected, actual) {
  const rest = [...actual];
  const missing = [];
  for ( const item of expected ) {
    const index = rest.indexOf(item);
    if ( index < 0 ) missing.push(item);
    else rest.splice(index, 1);
  }
  return { missing, extra: rest };
}

/** Words of a text (split at white space). Used for the progress numbers. */
export function wordCount(text) {
  const trimmed = String(text).trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/* -------------------------------------------- */
/*  Hash                                        */
/* -------------------------------------------- */

/**
 * First 8 hex characters of the 32 bit FNV-1a hash of the NFC normalized text as UTF-8. NOT SHA-256 (the concept said
 * SHA-256, WebCrypto is missing on plain http Foundry pages). It only detects that an English text changed, it is not
 * a security feature. Synchronous, same result in every browser and in Node.
 */
export function sourceHash(text) {
  const s = String(text).normalize("NFC");
  let hash = 0x811c9dc5;
  const feed = byte => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for ( let i = 0; i < s.length; i++ ) {
    let cp = s.charCodeAt(i);
    if ( cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.length ) {
      const next = s.charCodeAt(i + 1);
      if ( next >= 0xDC00 && next <= 0xDFFF ) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (next - 0xDC00);
        i++;
      }
    }
    if ( cp >= 0xD800 && cp <= 0xDFFF ) cp = 0xFFFD; // lone surrogate
    if ( cp < 0x80 ) feed(cp);
    else if ( cp < 0x800 ) { feed(0xC0 | (cp >> 6)); feed(0x80 | (cp & 63)); }
    else if ( cp < 0x10000 ) { feed(0xE0 | (cp >> 12)); feed(0x80 | ((cp >> 6) & 63)); feed(0x80 | (cp & 63)); }
    else { feed(0xF0 | (cp >> 18)); feed(0x80 | ((cp >> 12) & 63)); feed(0x80 | ((cp >> 6) & 63)); feed(0x80 | (cp & 63)); }
  }
  return hash.toString(16).padStart(8, "0");
}

/* -------------------------------------------- */
/*  Flatten and unflatten                       */
/* -------------------------------------------- */

const isPlainObject = value => (value !== null) && (typeof value === "object") && !Array.isArray(value);

function define(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Nested lang object to a Map of dotted key to string. Keys are not rewritten: a literal key "A.B" and a nested
 * A: {B} give the same dotted key.
 * Skipped: path segments __proto__, constructor, prototype, nesting deeper than 32 levels, and with skipDraft (default)
 * top level keys that start with "_DRAFT". Values that are not strings (numbers, null, arrays) are not entries.
 * Pass `report` to learn about them: {nonStrings:[keys], skipped:[keys], collisions:[keys], notObject:boolean}.
 * @param {object} object
 * @param {{report?:object, skipDraft?:boolean, coerce?:boolean}} [options] coerce turns numbers and booleans into strings
 * @returns {Map<string,string>}
 */
export function flatten(object, { report = null, skipDraft = true, coerce = false } = {}) {
  const out = new Map();
  if ( report ) {
    report.nonStrings ??= [];
    report.skipped ??= [];
    report.collisions ??= [];
    report.notObject = false;
  }
  if ( !isPlainObject(object) ) {
    if ( report ) report.notObject = true;
    return out;
  }
  const walk = (node, prefix, depth) => {
    for ( const key of Object.keys(node) ) {
      const full = prefix ? `${prefix}.${key}` : key;
      if ( !prefix && skipDraft && key.startsWith("_DRAFT") ) continue;
      if ( key.split(".").some(part => FORBIDDEN.has(part)) ) { report?.skipped.push(full); continue; }
      const value = node[key];
      if ( isPlainObject(value) ) {
        if ( depth >= MAX_DEPTH ) { report?.skipped.push(full); continue; }
        walk(value, full, depth + 1);
      }
      else if ( typeof value === "string" || (coerce && (typeof value === "number" || typeof value === "boolean")) ) {
        if ( out.has(full) ) report?.collisions.push(full);
        else out.set(full, String(value));
      }
      else report?.nonStrings.push(full);
    }
  };
  walk(object, "", 0);
  return out;
}

function toEntries(entries) {
  if ( entries instanceof Map ) return [...entries];
  if ( Array.isArray(entries) ) return entries.filter(item => Array.isArray(item) && item.length >= 2);
  if ( isPlainObject(entries) ) return Object.entries(entries);
  return [];
}

/**
 * Dotted entries back to a nested object with the structure and key order of `orderFrom` (the English object).
 * Only entries that exist in orderFrom's structure are placed there. Entries that are not in it come last, in their
 * own order, as literal dotted keys at the top level (Foundry expands them). Non strings and forbidden keys are dropped.
 * @param {Map|Array|object} entries dotted key to string
 * @param {object} orderFrom the English lang object
 * @returns {object}
 */
export function unflatten(entries, orderFrom) {
  const flat = new Map();
  for ( const [key, value] of toEntries(entries) ) {
    if ( typeof key !== "string" || typeof value !== "string" || !key ) continue;
    if ( key.split(".").some(part => !part || FORBIDDEN.has(part)) ) continue;
    flat.set(key, value);
  }
  const used = new Set();
  const walk = (node, prefix, depth) => {
    const out = {};
    for ( const key of Object.keys(node) ) {
      const full = prefix ? `${prefix}.${key}` : key;
      if ( !prefix && key.startsWith("_DRAFT") ) continue;
      if ( key.split(".").some(part => FORBIDDEN.has(part)) ) continue;
      const value = node[key];
      if ( isPlainObject(value) ) {
        if ( depth >= MAX_DEPTH ) continue;
        const child = walk(value, full, depth + 1);
        if ( Object.keys(child).length ) define(out, key, child);
      }
      else if ( typeof value === "string" && flat.has(full) ) {
        define(out, key, flat.get(full));
        used.add(full);
      }
    }
    return out;
  };
  const result = isPlainObject(orderFrom) ? walk(orderFrom, "", 0) : {};
  for ( const [key, value] of flat ) if ( !used.has(key) ) define(result, key, value);
  return result;
}

/* -------------------------------------------- */
/*  checkValue                                  */
/* -------------------------------------------- */

/** Text for messages: invisible and control characters as \uXXXX, shortened. */
function safe(value, max = 48) {
  let out = "";
  for ( const ch of String(value) ) {
    const c = ch.codePointAt(0);
    const hidden = (c < 32) || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
      || (c >= 0x2060 && c <= 0x2069) || (c === 0x180e) || (c === 0xfeff) || (c >= 0xe0000 && c <= 0xe007f);
    out += hidden ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
    if ( out.length >= max ) return `${out}...`;
  }
  return out;
}

function list(items, max = 4) {
  const shown = items.slice(0, max).map(item => safe(item, 32)).join(" ");
  return items.length > max ? `${shown} (+${items.length - max})` : shown;
}

function baseLang(lang) {
  return String(lang ?? "").toLowerCase().split(/[-_]/)[0];
}

/** Script rule of a language: [regex of the expected letters, label], or null when no rule applies. */
function scriptRule(lang) {
  const raw = String(lang ?? "").toLowerCase();
  const base = baseLang(raw);
  if ( ["ru", "uk", "be", "bg", "mk"].includes(base) ) return [/\p{Script=Cyrillic}/gu, "Cyrillic"];
  if ( base === "sr" ) return /latn/.test(raw) ? null : [/\p{Script=Cyrillic}/gu, "Cyrillic"];
  if ( base === "el" ) return [/\p{Script=Greek}/gu, "Greek"];
  if ( base === "ja" ) return [/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, "Japanese"];
  if ( base === "zh" ) return [/\p{Script=Han}/gu, "Han"];
  if ( base === "ko" ) return [/[\p{Script=Hangul}\p{Script=Han}]/gu, "Korean"];
  return null;
}

function withoutMarkup(text) {
  return text.replace(RE_TAG, " ").replace(RE_URL, " ").replace(RE_ENRICHER, " ").replace(RE_ENTITY, " ")
    .replace(RE_PLACEHOLDER, " ");
}

/**
 * Check one translated text against its English text. Hard errors block submitting and accepting, warnings do not.
 * @param {string} english
 * @param {string} translated
 * @param {{lang?:string}} [options]
 * @returns {{errors:{code:string,message:string}[], warnings:{code:string,message:string}[]}}
 */
export function checkValue(english, translated, { lang = "" } = {}) {
  const errors = [];
  const warnings = [];
  // data: the parts of the message as plain values, so a UI can word the detail in its own language
  const err = (code, message, data) => errors.push(data ? { code, message, data } : { code, message });
  const warn = (code, message, data) => warnings.push(data ? { code, message, data } : { code, message });
  const result = { errors, warnings };

  if ( typeof translated !== "string" ) { err(CODES.NOT_STRING, "The value is not a text."); return result; }
  const en = typeof english === "string" ? english : "";
  if ( (translated.length > MAX_VALUE_LENGTH) || (en.length > MAX_VALUE_LENGTH) ) {
    err(CODES.TOO_LONG, `The text is longer than ${MAX_VALUE_LENGTH} characters.`, { max: MAX_VALUE_LENGTH });
    return result;
  }
  if ( translated.trim() === "" ) {
    if ( en.trim() !== "" ) warn(CODES.EMPTY, "Not translated yet (empty).");
    return result;
  }

  // Placeholders
  const ph = diffList(placeholders(en), placeholders(translated));
  if ( ph.missing.length || ph.extra.length ) {
    err(CODES.PLACEHOLDER, `Placeholders differ. Missing: ${list(ph.missing) || "none"}. Unknown: ${list(ph.extra) || "none"}.`,
      { missing: list(ph.missing), extra: list(ph.extra) });
  }

  // Tags
  const enTags = tagSequence(en);
  const trTags = tagSequence(translated);
  if ( enTags.length || trTags.length ) {
    const names = tags => tags.map(tag => tag.replace(/^<(\/?[a-z0-9-]+).*>$/, "<$1>"));
    const sameNames = JSON.stringify(names(enTags)) === JSON.stringify(names(trTags));
    if ( !sameNames ) err(CODES.TAG, `HTML tags differ from English (same tags in the same order needed). English: ${list(enTags) || "none"}. Translation: ${list(trTags) || "none"}.`,
      { english: list(enTags), translation: list(trTags) });
    else if ( JSON.stringify(enTags) !== JSON.stringify(trTags) ) err(CODES.TAG_ATTRIBUTES, "HTML tag attributes differ from English.");
  }
  // Loose angle brackets (after the tags are cut out) must match English too; without tags there must be none.
  const loose = text => text.replace(RE_TAG, "");
  const enLoose = loose(en);
  const trLoose = loose(translated);
  if ( (count(enLoose, /</g) !== count(trLoose, /</g)) || (count(enLoose, />/g) !== count(trLoose, />/g)) ) {
    err(CODES.ANGLE, enTags.length ? "Loose < or > outside of the tags." : "The English text has no HTML tag, so < and > are not allowed.");
  }

  // Entities
  const ent = diffList(en.match(RE_ENTITY) ?? [], translated.match(RE_ENTITY) ?? []);
  if ( ent.missing.length || ent.extra.length ) {
    err(CODES.ENTITY, `HTML entities differ. Missing: ${list(ent.missing) || "none"}. Unknown: ${list(ent.extra) || "none"}.`,
      { missing: list(ent.missing), extra: list(ent.extra) });
  }

  // Handlebars and curly braces left over after the placeholders are cut out
  const braces = raw => {
    const text = raw.replace(RE_PLACEHOLDER, "");
    return [count(text, /\{\{/g), count(text, /\}\}/g), count(text, /\{\{\{/g), count(text, /\{/g), count(text, /\}/g)];
  };
  if ( JSON.stringify(braces(en)) !== JSON.stringify(braces(translated)) ) {
    err(CODES.HANDLEBARS, "Curly braces or Handlebars expressions differ from English.");
  }

  // Enrichers
  const enr = diffList(en.match(RE_ENRICHER) ?? [], translated.match(RE_ENRICHER) ?? []);
  const openers = text => [count(text, /@[A-Za-z]+\[/g), count(text, /\[\[/g)];
  if ( enr.missing.length || enr.extra.length || JSON.stringify(openers(en)) !== JSON.stringify(openers(translated)) ) {
    err(CODES.ENRICHER, `Foundry enrichers differ. Missing: ${list(enr.missing) || "none"}. Unknown: ${list(enr.extra) || "none"}.`,
      { missing: list(enr.missing), extra: list(enr.extra) });
  }

  // URLs
  const known = new Set(en.match(RE_URL) ?? []);
  const foreign = [...new Set(translated.match(RE_URL) ?? [])].filter(url => !known.has(url));
  if ( foreign.length ) err(CODES.URL, `Web address not in the English text: ${list(foreign, 2)}.`, { found: list(foreign, 2) });

  // Control, bidi and invisible characters
  if ( count(translated, RE_CONTROL) > count(en, RE_CONTROL) ) err(CODES.CONTROL, "Control characters are not allowed.");
  if ( count(translated, RE_BIDI) > count(en, RE_BIDI) ) err(CODES.BIDI, "Text direction overrides are not allowed.");
  let invisible = count(translated, RE_ZERO_WIDTH) - count(en, RE_ZERO_WIDTH);
  if ( !JOINER_LANGS.has(baseLang(lang)) ) invisible += count(translated, RE_JOINERS) - count(en, RE_JOINERS);
  if ( invisible > 0 ) err(CODES.ZERO_WIDTH, "Zero width or invisible characters are not allowed.");

  // Warnings
  const isEnglish = baseLang(lang) === "en";
  if ( !isEnglish && looksUntranslated(en, translated) ) warn(CODES.IDENTICAL, "Identical to the English text.");
  const a = en.length;
  const b = translated.length;
  if ( a > 0 ) {
    const cjk = ["ja", "zh", "ko"].includes(baseLang(lang));
    if ( a < 20 ) {
      if ( b - a > 30 ) warn(CODES.LENGTH_LONG, `Much longer than English (${b} characters, English ${a}).`);
    }
    else if ( b / a > 1.6 ) warn(CODES.LENGTH_LONG, `Much longer than English (${b} characters, English ${a}, factor ${(b / a).toFixed(1)}).`);
    else if ( !cjk && b / a < 0.3 ) warn(CODES.LENGTH_SHORT, `Much shorter than English (${b} characters, English ${a}).`);
  }
  const lead = text => text.match(/^\s*/)[0];
  const trail = text => text.match(/\s*$/)[0];
  if ( (lead(en) !== lead(translated)) || (trail(en) !== trail(translated)) ) {
    warn(CODES.EDGE_SPACE, "Leading or trailing space differs from English.");
  }
  const rule = isEnglish ? null : scriptRule(lang);
  if ( rule ) {
    const plain = withoutMarkup(translated);
    const letters = count(plain, /\p{L}/gu);
    if ( letters >= 4 && count(plain, rule[0]) / letters < 0.5 ) {
      warn(CODES.SCRIPT, `Less than half of the letters are ${rule[1]}, check the language.`);
    }
  }
  const pu = punctuationProblems(translated);
  if ( pu.length && !punctuationProblems(en).length ) warn(CODES.PUNCTUATION, `Punctuation to avoid: ${pu.join(", ")}.`, { found: pu.join(", ") });
  if ( translated !== translated.normalize("NFC") ) warn(CODES.NOT_NFC, "The text is not Unicode normalized (NFC).");
  return result;
}

/* -------------------------------------------- */
/*  checkFile                                   */
/* -------------------------------------------- */

/**
 * Check a whole translation against the English file (both nested lang objects).
 * Words are counted from the English texts. A key counts as translated when it is a non empty text without hard error
 * that is not flagged "identical to English".
 * @param {object} englishObj
 * @param {object} translatedObj
 * @param {{lang?:string}} [options]
 * @returns {{perKey:Object<string,{errors:object[],warnings:object[]}>, unknownKeys:string[], nonStrings:string[],
 *   skippedKeys:string[], errors:{key:string,code:string,message:string}[], warnings:{key:string,code:string,message:string}[],
 *   coverage:{keys:number,translatedKeys:number,words:number,translatedWords:number}}}
 */
export function checkFile(englishObj, translatedObj, { lang = "" } = {}) {
  const enReport = {};
  const trReport = {};
  const en = flatten(englishObj, { report: enReport });
  const tr = flatten(translatedObj, { report: trReport });
  const perKey = {};
  const errors = [];
  const warnings = [];
  const unknownKeys = [];
  const coverage = { keys: en.size, translatedKeys: 0, words: 0, translatedWords: 0 };
  if ( trReport.notObject ) errors.push({ key: "", code: CODES.NOT_OBJECT, message: "The file is not a JSON object." });
  for ( const text of en.values() ) coverage.words += wordCount(text);
  for ( const [key, value] of tr ) {
    if ( !en.has(key) ) {
      unknownKeys.push(key);
      errors.push({ key, code: CODES.UNKNOWN_KEY, message: "This key is not in the English file." });
      continue;
    }
    const result = checkValue(en.get(key), value, { lang });
    define(perKey, key, result);
    for ( const item of result.errors ) errors.push({ key, ...item });
    for ( const item of result.warnings ) warnings.push({ key, ...item });
    const blank = value.trim() === "";
    const identical = result.warnings.some(item => item.code === CODES.IDENTICAL);
    if ( !blank && !result.errors.length && !identical ) {
      coverage.translatedKeys++;
      coverage.translatedWords += wordCount(en.get(key));
    }
  }
  for ( const key of trReport.nonStrings ) {
    errors.push({ key, code: CODES.NOT_STRING, message: "The value is not a text." });
  }
  return {
    perKey, unknownKeys, nonStrings: trReport.nonStrings, skippedKeys: [...trReport.skipped, ...trReport.collisions],
    errors, warnings, coverage
  };
}

/* -------------------------------------------- */
/*  Merge                                       */
/* -------------------------------------------- */

/**
 * Put checked texts into a live translations object (game.i18n.translations). Hardened: only keys that lie under one
 * of the roots (key equals root + "." + more), no prototype keys, only string values, own properties only, no
 * recursive merge of foreign data. An existing object is never replaced by a text and an existing text never becomes an
 * object. Missing path objects are created.
 * @param {object} target nested translations object
 * @param {string[]} moduleNamespaceRoots first path parts the module owns, for example ["SRR"]
 * @param {Map|Array|object} flatEntries dotted key to string
 * @param {{onSkip?:(key:string, reason:string)=>void}} [options]
 * @returns {string[]} the keys that were applied
 */
export function safeMergeTranslations(target, moduleNamespaceRoots, flatEntries, { onSkip = null } = {}) {
  const applied = [];
  if ( (target === null) || (typeof target !== "object") ) return applied;
  const roots = (Array.isArray(moduleNamespaceRoots) ? moduleNamespaceRoots : [])
    .filter(root => (typeof root === "string") && root && !root.split(".").some(part => !part || FORBIDDEN.has(part)));
  const skip = (key, reason) => { try { onSkip?.(key, reason); } catch { /* a broken callback must not stop the merge */ } };
  for ( const [key, value] of toEntries(flatEntries) ) {
    if ( typeof key !== "string" || typeof value !== "string" ) { skip(String(key), "not-string"); continue; }
    const parts = key.split(".");
    if ( parts.some(part => !part || FORBIDDEN.has(part)) || parts.length < 2 || parts.length > MAX_DEPTH ) { skip(key, "bad-key"); continue; }
    if ( !roots.some(root => key.startsWith(`${root}.`)) ) { skip(key, "outside-namespace"); continue; }
    let node = target;
    let ok = true;
    for ( let i = 0; i < parts.length - 1; i++ ) {
      const part = parts[i];
      if ( !Object.hasOwn(node, part) ) define(node, part, {});
      const next = node[part];
      if ( !isPlainObject(next) ) { ok = false; break; }
      node = next;
    }
    const last = parts.at(-1);
    if ( ok && Object.hasOwn(node, last) && (typeof node[last] !== "string") ) ok = false;
    if ( !ok ) { skip(key, "conflict"); continue; }
    define(node, last, value);
    applied.push(key);
  }
  return applied;
}
