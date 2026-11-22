import assert from "node:assert/strict";
import test from "node:test";
import {REVIEW_FORMAT, buildReviewFile, checkSuggestion, emptyReview, isReviewFile, notesFromReview, readSubmissionForReview,
  reviewCounts, reviewKey, reviewMessage, reviewStatus, sanitizeReview} from "../scripts/review-logic.mjs";
import {analyzeRow, buildSubmission, emptyDraft, sanitizeDraft} from "../scripts/translator-logic.mjs";

const flatEn = new Map([["SRR.Title", "Roll requests"], ["SRR.Window.Send.Button", "Send request to {count} players"],
  ["SRR.Window.Close", "Close"], ["SRR.Hint", "Click <b>send</b>"]]);
const rowOf = (key, text) => analyzeRow(key, flatEn.get(key), text, null, "xx");
const submission = () => buildSubmission({module: "sephrals-roll-requests", moduleVersion: "1.0.6", lang: "xx", name: "Tina",
  at: Date.UTC(2026, 10, 22, 10), rows: [rowOf("SRR.Title", "«Würfe»"), rowOf("SRR.Window.Send.Button", "«An {count} senden»"),
    rowOf("SRR.Window.Close", "«Zu»")]});

test("a submission file is read for a review: texts of the module with their checks", () => {
  const read = readSubmissionForReview(submission(), flatEn);
  assert.ok(read.ok);
  assert.deepEqual(read.rows.map(r => r.key), ["SRR.Title", "SRR.Window.Send.Button", "SRR.Window.Close"]);
  assert.equal(read.submission.translator, "Tina");
  assert.equal(read.submission.createdAt, "2026-11-22T10:00:00.000Z");
  assert.equal(reviewKey(read.submission), "sephrals-roll-requests|xx|2026-11-22T10:00:00.000Z");
  // a text with an error is shown with it, the review decides
  const broken = submission();
  broken.keys["SRR.Window.Send.Button"] = "«Senden»";
  const withError = readSubmissionForReview(broken, flatEn).rows.find(r => r.key === "SRR.Window.Send.Button");
  assert.ok(withError.errors.length > 0);
  for ( const [bad, reason] of [[{}, "not-submission"], [{...submission(), lang: "en"}, "bad-language"], [{...submission(), keys: {"X.y": "z"}}, "no-texts"]] ) {
    assert.equal(readSubmissionForReview(bad, flatEn).reason, reason);
  }
});

test("the review state is read back defensively", () => {
  const keys = new Set(["SRR.Title", "SRR.Window.Close"]);
  const review = sanitizeReview({reviewer: "Rita".repeat(30), saved: 5, items: {
    "SRR.Title": {verdict: "ok"}, "SRR.Window.Close": {verdict: "change", suggestion: "«Schließen»", comment: "x".repeat(900)},
    "Other.key": {verdict: "ok"}, "__proto__": {verdict: "ok"}, "SRR.Hint": {verdict: "maybe"}}}, keys);
  assert.deepEqual(Object.keys(review.items), ["SRR.Title", "SRR.Window.Close"]);
  assert.equal(review.items["SRR.Window.Close"].comment.length, 500);
  assert.equal(review.reviewer.length, 60);
  assert.equal(reviewStatus(review, "SRR.Title"), "ok");
  assert.equal(reviewStatus(review, "SRR.Hint"), "open");
  for ( const junk of [null, 5, "x"] ) assert.deepEqual(Object.keys(sanitizeReview(junk, keys).items), []);
});

test("counts, suggestion checks and the review file", () => {
  const read = readSubmissionForReview(submission(), flatEn);
  const review = emptyReview();
  assert.deepEqual(reviewCounts(read.rows, review), {all: 3, open: 3, ok: 0, change: 0, done: 0});
  review.items["SRR.Title"] = {verdict: "ok", suggestion: "", comment: ""};
  review.items["SRR.Window.Close"] = {verdict: "change", suggestion: "«Schließen»", comment: "zu kurz"};
  review.reviewer = " Rita ";
  assert.deepEqual(reviewCounts(read.rows, review), {all: 3, open: 1, ok: 1, change: 1, done: 2});
  assert.equal(checkSuggestion("Send request to {count} players", "«Senden»", "xx").errors.length > 0, true);
  assert.equal(checkSuggestion("Close", "", "xx").errors.length, 0);
  const file = buildReviewFile(read.submission, review, read.rows, Date.UTC(2026, 10, 23));
  assert.equal(file.format, REVIEW_FORMAT);
  assert.equal(file.result, "partial");
  assert.equal(file.reviewer, "Rita");
  assert.deepEqual(file.counts, {texts: 3, ok: 1, change: 1, open: 1});
  assert.deepEqual(file.items["SRR.Window.Close"], {verdict: "change", suggestion: "«Schließen»", comment: "zu kurz"});
  assert.deepEqual(file.items["SRR.Title"], {verdict: "ok"});
  assert.ok(isReviewFile(file));
  review.items["SRR.Window.Send.Button"] = {verdict: "ok", suggestion: "", comment: ""};
  assert.equal(buildReviewFile(read.submission, review, read.rows).result, "changes");
  delete review.items["SRR.Window.Close"];
  review.items["SRR.Window.Close"] = {verdict: "ok", suggestion: "", comment: ""};
  assert.equal(buildReviewFile(read.submission, review, read.rows).result, "approved");
});

test("the translator takes the notes of a review file, only for this module and language, broken suggestions dropped", () => {
  const file = {format: REVIEW_FORMAT, v: 1, module: "sephrals-roll-requests", lang: "xx", reviewer: "Rita", items: {
    "SRR.Window.Close": {verdict: "change", suggestion: "«Schließen»", comment: "zu kurz"},
    "SRR.Window.Send.Button": {verdict: "change", suggestion: "«Senden»", comment: "Platzhalter fehlt"},
    "SRR.Title": {verdict: "ok"}, "SRR.Hint": {verdict: "ok", comment: "schön"}, "Other.key": {verdict: "change", comment: "x"}}};
  const result = notesFromReview(file, flatEn, "sephrals-roll-requests", "xx");
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.notes).sort(), ["SRR.Hint", "SRR.Window.Close", "SRR.Window.Send.Button"]);
  assert.equal(result.notes["SRR.Window.Send.Button"].suggestion, "");
  assert.equal(result.notes["SRR.Window.Send.Button"].comment, "Platzhalter fehlt");
  assert.equal(result.notes["SRR.Window.Close"].reviewer, "Rita");
  assert.deepEqual(result.counts, {notes: 3, change: 2});
  assert.equal(notesFromReview(file, flatEn, "sephrals-tavern-games", "xx").reason, "other-module");
  assert.equal(notesFromReview(file, flatEn, "sephrals-roll-requests", "ru").reason, "other-language");
  assert.equal(notesFromReview({format: "x"}, flatEn, "m", "xx").reason, "not-review");
  // the notes survive in the draft
  const draft = emptyDraft();
  draft.notes = result.notes;
  const back = sanitizeDraft(JSON.parse(JSON.stringify({...draft, notes: {...draft.notes, "Nope.key": {verdict: "ok"}, "SRR.Title": {verdict: "bad"}}})), flatEn);
  assert.deepEqual(Object.keys(back.notes).sort(), ["SRR.Hint", "SRR.Window.Close", "SRR.Window.Send.Button"]);
});

test("the text for the post stays below the Discord limit and points to the file", () => {
  const items = {};
  for ( let i = 0; i < 80; i++ ) items[`SRR.Key.k${i}`] = {verdict: "change", suggestion: "x".repeat(40), comment: "y".repeat(20)};
  const words = {head: "HEAD", approved: "OK", changes: "CHANGES", partial: "PARTIAL", more: "{count} MORE", file: "FILE"};
  const text = reviewMessage({result: "changes", items}, words);
  assert.ok(text.length <= 1800);
  assert.match(text, /^HEAD\nCHANGES\n/);
  assert.match(text, /\d+ MORE\nFILE$/);
  assert.equal(reviewMessage({result: "approved", items: {"a.b": {verdict: "ok"}}}, words), "HEAD\nOK\nFILE");
});

test("one text left over gets the singular wording", () => {
  const items = {};
  for ( let i = 0; i < 30; i++ ) items[`SRR.Key.k${i}`] = {verdict: "change", suggestion: "x".repeat(40), comment: "y".repeat(20)};
  const words = {head: "HEAD", approved: "OK", changes: "CHANGES", partial: "PARTIAL", more: "{count} MORE", moreOne: "ONE MORE", file: "FILE"};
  const full = reviewMessage({result: "changes", items}, words, 100000);
  const cuts = [];
  for ( let max = full.length - 1; max > 200; max -= 7 ) cuts.push(reviewMessage({result: "changes", items}, words, max));
  assert.ok(cuts.some(text => /\nONE MORE\nFILE$/.test(text)));
  assert.ok(cuts.some(text => /\n\d+ MORE\nFILE$/.test(text)));
  assert.ok(!cuts.some(text => /\n1 MORE\n/.test(text)));
});
