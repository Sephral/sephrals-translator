/**
 * Pure parts of the review (no Foundry, no DOM). A reviewer opens a submission file of another translator, reads every
 * text in the real windows, marks it OK or Needs change with a suggestion and a comment, and saves a review file. The
 * translator imports that file: the notes appear next to the texts. Everything foreign is hostile input.
 */

import {checkValue} from "./translate-checks.mjs";
import {dict, isSubmission, normalizeLang, LIMITS} from "./translator-logic.mjs";

/** The format of a review file. */
export const REVIEW_FORMAT = "sephrals-translation-review";

/** A verdict per text. */
export const VERDICTS = Object.freeze(["ok", "change"]);

/** Limits of what a reviewer writes. */
export const REVIEW_LIMITS = Object.freeze({comment: 500, name: 60, suggestion: LIMITS.text});

/** The status filters of the review list, in their order. */
export const REVIEW_STATUSES = Object.freeze(["open", "ok", "change"]);

/** The key of a review in the client setting: module, language and the time of the submission. */
export function reviewKey(submission) {
  return `${submission.module}|${submission.lang}|${submission.createdAt ?? ""}`;
}

/**
 * Read a submission file for a review: the texts that have an English text, with their check results.
 * @param {*} data
 * @param {Map<string, string>} enFlat   The English file of the installed module
 * @returns {{ok: boolean, reason?: string, submission?: object, rows?: object[]}}
 */
export function readSubmissionForReview(data, enFlat) {
  if ( !isSubmission(data) ) return {ok: false, reason: "not-submission"};
  const lang = normalizeLang(data.lang);
  if ( !lang || (lang === "en") ) return {ok: false, reason: "bad-language"};
  const rows = [];
  for ( const [key, english] of enFlat ) {
    const text = data.keys[key];
    if ( (typeof text !== "string") || !text.trim() ) continue;
    const result = checkValue(english, text, {lang});
    rows.push({key, en: english, text, errors: result.errors, warnings: result.warnings});
  }
  if ( !rows.length ) return {ok: false, reason: "no-texts"};
  const submission = {module: data.module, moduleVersion: String(data.moduleVersion ?? "").slice(0, 30), lang,
    createdAt: typeof data.createdAt === "string" ? data.createdAt.slice(0, 40) : "",
    translator: typeof data.credit?.name === "string" ? data.credit.name.slice(0, REVIEW_LIMITS.name) : ""};
  return {ok: true, submission, rows};
}

/** An empty review state. */
export function emptyReview() {
  return {items: dict(), reviewer: "", saved: 0};
}

/**
 * A stored review state, reduced to keys of the submission, known verdicts and limited texts.
 * @param {*} raw
 * @param {Set<string>} keys   The keys of the submission
 * @returns {ReturnType<emptyReview>}
 */
export function sanitizeReview(raw, keys) {
  const review = emptyReview();
  if ( !raw || (typeof raw !== "object") ) return review;
  for ( const [key, item] of Object.entries(raw.items ?? {}) ) {
    if ( !keys.has(key) || !item || !VERDICTS.includes(item.verdict) ) continue;
    review.items[key] = {
      verdict: item.verdict,
      suggestion: typeof item.suggestion === "string" ? item.suggestion.slice(0, REVIEW_LIMITS.suggestion) : "",
      comment: typeof item.comment === "string" ? item.comment.slice(0, REVIEW_LIMITS.comment) : ""
    };
  }
  review.reviewer = typeof raw.reviewer === "string" ? raw.reviewer.slice(0, REVIEW_LIMITS.name) : "";
  review.saved = Number.isFinite(raw.saved) ? raw.saved : 0;
  return review;
}

/** The status of a text in the review. */
export const reviewStatus = (review, key) => review.items[key]?.verdict ?? "open";

/**
 * Counts for the filters and the progress.
 * @param {object[]} rows
 * @param {ReturnType<emptyReview>} review
 * @returns {{all: number, open: number, ok: number, change: number, done: number}}
 */
export function reviewCounts(rows, review) {
  const out = {all: rows.length, open: 0, ok: 0, change: 0, done: 0};
  for ( const row of rows ) out[reviewStatus(review, row.key)]++;
  out.done = out.ok + out.change;
  return out;
}

/**
 * Check what the reviewer suggests like any translation (placeholders, tags, the hard rules).
 * @param {string} english
 * @param {string} suggestion
 * @param {string} lang
 * @returns {{errors: object[], warnings: object[]}}
 */
export function checkSuggestion(english, suggestion, lang) {
  if ( !String(suggestion ?? "").trim() ) return {errors: [], warnings: []};
  return checkValue(english, suggestion, {lang});
}

/**
 * The review file the reviewer saves and the translator imports.
 * @param {object} submission   From readSubmissionForReview
 * @param {ReturnType<emptyReview>} review
 * @param {object[]} rows
 * @param {number} [at]
 * @returns {object}
 */
export function buildReviewFile(submission, review, rows, at = Date.now()) {
  const items = {};
  for ( const row of rows ) {
    const item = review.items[row.key];
    if ( !item ) continue;
    items[row.key] = {verdict: item.verdict, ...(item.suggestion.trim() ? {suggestion: item.suggestion.normalize("NFC")} : {}),
      ...(item.comment.trim() ? {comment: item.comment.trim()} : {})};
  }
  const counts = reviewCounts(rows, review);
  return {
    format: REVIEW_FORMAT, v: 1, module: submission.module, moduleVersion: submission.moduleVersion, lang: submission.lang,
    submission: submission.createdAt, translator: submission.translator, reviewer: review.reviewer.trim(),
    createdAt: new Date(at).toISOString(),
    result: (counts.open === 0) && (counts.change === 0) ? "approved" : (counts.open === 0 ? "changes" : "partial"),
    counts: {texts: counts.all, ok: counts.ok, change: counts.change, open: counts.open},
    attest: {byHand: true},
    items
  };
}

/** Is this a review file? */
export function isReviewFile(data) {
  return !!data && (typeof data === "object") && !Array.isArray(data) && (data.format === REVIEW_FORMAT) && (data.v === 1)
    && (typeof data.module === "string") && !!data.items && (typeof data.items === "object") && !Array.isArray(data.items);
}

/**
 * The notes of a review file for the translator's draft: only keys of the module, only known verdicts, suggestions
 * without errors (a broken suggestion keeps its comment).
 * @param {*} data
 * @param {Map<string, string>} enFlat
 * @param {string} moduleId
 * @param {string} lang
 * @returns {{ok: boolean, reason?: string, notes?: Record<string, object>, reviewer?: string, counts?: object}}
 */
export function notesFromReview(data, enFlat, moduleId, lang) {
  if ( !isReviewFile(data) ) return {ok: false, reason: "not-review"};
  if ( data.module !== moduleId ) return {ok: false, reason: "other-module"};
  if ( normalizeLang(data.lang) !== lang ) return {ok: false, reason: "other-language"};
  const reviewer = typeof data.reviewer === "string" ? data.reviewer.slice(0, REVIEW_LIMITS.name) : "";
  const notes = dict();
  for ( const [key, item] of Object.entries(data.items) ) {
    if ( !enFlat.has(key) || !item || !VERDICTS.includes(item.verdict) ) continue;
    let suggestion = typeof item.suggestion === "string" ? item.suggestion.slice(0, REVIEW_LIMITS.suggestion) : "";
    if ( suggestion && checkValue(enFlat.get(key), suggestion, {lang}).errors.length ) suggestion = "";
    const comment = typeof item.comment === "string" ? item.comment.slice(0, REVIEW_LIMITS.comment) : "";
    if ( item.verdict === "ok" && !comment ) continue;
    notes[key] = {verdict: item.verdict, suggestion, comment, reviewer};
  }
  return {ok: true, notes, reviewer, counts: {notes: Object.keys(notes).length, change: Object.values(notes).filter(n => n.verdict === "change").length}};
}

/**
 * The short text for the post in the review queue: result, counts and the first texts that need a change. Discord
 * allows 2000 characters, the full list is in the review file.
 * @param {object} file          From buildReviewFile
 * @param {object} words         Localized parts: head, approved, changes, partial, more, moreOne (optional), file
 * @param {number} [max]
 * @returns {string}
 */
export function reviewMessage(file, words, max = 1800) {
  const lines = [words.head, words[file.result]];
  const changes = Object.entries(file.items).filter(([, item]) => item.verdict === "change");
  let shown = 0;
  for ( const [key, item] of changes ) {
    const line = `• \`${key}\`${item.suggestion ? `: ${item.suggestion}` : ""}${item.comment ? ` (${item.comment})` : ""}`;
    if ( lines.join("\n").length + line.length + 80 > max ) break;
    lines.push(line);
    shown++;
  }
  const rest = changes.length - shown;
  if ( rest > 0 ) lines.push(((rest === 1) && words.moreOne ? words.moreOne : words.more).replace("{count}", String(rest)));
  lines.push(words.file);
  return lines.join("\n");
}
