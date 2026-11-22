import assert from "node:assert/strict";
import test from "node:test";
import {checkValue, sourceHash} from "../scripts/translate-checks.mjs";
import {CONSENT_VERSION, DISCORD_CHANNEL, DISCORD_URL, LIMITS, SUBMIT_VIA, acceptEnglish, analyzeRow, buildSubmission, checkDetail, languageChoices, LANGUAGES, memoryFor, memoryKey, nextTodoKey, sameEnglishOpen, sampleText, changedKeys,
  countPlaceholders, coverage, draftKey, emptyDraft, exportFile, filterRows, groupOf, insertAt, isSubmission, issueLink, issueTitle,
  issueUrl, lengthInfo, normalizeLang, parseDrafts, parseImport, parseTranslateCommand, previewText, sanitizeDraft,
  setDraftText, statusCounts, validateSubmitFields, REFRESH_HOOK, drawsOnCanvas, listensToRefresh, refreshPayload,
  HISTORY_MAX, HISTORY_TEXTS, addHistory, changedSince, copyFileName, copyFileText, lastSent, parseShared, parseUse, pickUse,
  sendableTexts, unchangedSinceLast, usableKey, usableTexts, useModeOf, moduleNeeds} from "../scripts/translator-logic.mjs";

const EN = {
  SRR: {
    Title: "Roll requests",
    Window: {
      Send: {Button: "Send request to {count} players", Hint: "Click <b>send</b> to start"},
      Close: "Close"
    }
  },
  Other: {Note: "A note"}
};
const flatEn = new Map([["SRR.Title", "Roll requests"], ["SRR.Window.Send.Button", "Send request to {count} players"],
  ["SRR.Window.Send.Hint", "Click <b>send</b> to start"], ["SRR.Window.Close", "Close"], ["Other.Note", "A note"]]);
const rowOf = (key, text, meta = null) => analyzeRow(key, flatEn.get(key), text, meta, "xx");

test("translations are handed in on Discord or GitHub, there is no server", () => {
  assert.match(DISCORD_URL, /^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
  assert.equal(DISCORD_CHANNEL, "translations");
  assert.deepEqual([...SUBMIT_VIA], ["discord", "github"]);
});

test("language codes are validated and normalized", () => {
  assert.equal(normalizeLang("pt-br"), "pt-BR");
  assert.equal(normalizeLang(" PT_br "), "pt-BR");
  assert.equal(normalizeLang("ru"), "ru");
  assert.equal(normalizeLang("fil"), "fil");
  assert.equal(normalizeLang("es-419"), "es-419");
  for ( const bad of ["", "r", "toolong", "../etc", "de;rm", "en-", "pt-BRA", "de de", null, undefined, 5, {}] ) assert.equal(normalizeLang(bad), null, String(bad));
});

test("status of a row", () => {
  assert.equal(rowOf("SRR.Title", "").status, "open");
  assert.equal(rowOf("SRR.Title", "   ").status, "open");
  assert.equal(rowOf("SRR.Title", "Wuerfelanfragen").status, "ok");
  assert.equal(rowOf("SRR.Window.Send.Button", "Sende an {count} Spieler").status, "ok");
  assert.equal(rowOf("SRR.Window.Send.Button", "Sende an Spieler").status, "error");
  assert.equal(rowOf("SRR.Window.Send.Button", "Sende an {total} Spieler").status, "error");
  assert.equal(rowOf("SRR.Window.Send.Button", "Send request to {count} players").status, "warning");
  assert.equal(rowOf("SRR.Title", "Wuerfelanfragen", {review: {"SRR.Title": true}}).status, "check");
  assert.equal(rowOf("SRR.Title", "Wuerfelanfragen", {src: {"SRR.Title": "00000000"}}).status, "changed");
  assert.equal(rowOf("SRR.Title", "Wuerfelanfragen", {src: {"SRR.Title": sourceHash("Roll requests")}}).status, "ok");
  // an error wins over a change mark
  assert.equal(rowOf("SRR.Window.Send.Button", "ohne", {src: {"SRR.Window.Send.Button": "00000000"}}).status, "error");
});

test("HTML in a translation is an error at once and stays out of the preview", () => {
  const bad = rowOf("SRR.Title", "<img src=x onerror=alert(1)>Titel");
  assert.equal(bad.status, "error");
  assert.ok(bad.blocked);
  assert.equal(previewText(bad), "Roll requests");
  const good = rowOf("SRR.Window.Send.Hint", "Klicke <b>senden</b> zum Start");
  assert.equal(good.status, "ok");
  assert.equal(previewText(good), "Klicke <b>senden</b> zum Start");
  const wrongTag = rowOf("SRR.Window.Send.Hint", "Klicke <i>senden</i> zum Start");
  assert.ok(wrongTag.blocked);
  // a missing placeholder is an error but still visible, so the translator sees "undefined" right away
  const hole = rowOf("SRR.Window.Send.Button", "Sende");
  assert.ok(!hole.blocked);
  assert.equal(previewText(hole), "Sende");
  assert.equal(previewText(rowOf("SRR.Title", "")), "Roll requests");
});

test("bidi and invisible characters are blocked from the preview", () => {
  assert.ok(rowOf("SRR.Title", "Titel‮abc").blocked);
  assert.ok(rowOf("SRR.Title", "Ti​tel").blocked);
  assert.ok(rowOf("SRR.Title", "Titel\u0007").blocked);
});

test("coverage counts words of translated rows only", () => {
  const rows = [rowOf("SRR.Title", "Titel"), rowOf("SRR.Window.Close", ""), rowOf("SRR.Window.Send.Button", "ohne"),
    rowOf("SRR.Window.Send.Hint", "Click <i>send</i> to start")];
  const c = coverage(rows);
  assert.equal(c.keys, 4);
  assert.equal(c.translatedKeys, 1);
  assert.equal(c.translatedWords, 2);
  assert.equal(c.words, 2 + 1 + 5 + 4);
  assert.equal(c.percent, Math.round((2 / 12) * 100));
  assert.equal(coverage([]).percent, 0);
});

test("counts, groups and filters", () => {
  const rows = [...flatEn].map(([key, en]) => rowOf(key, key === "SRR.Title" ? "Titel" : ""));
  const counts = statusCounts(rows);
  assert.equal(counts.all, 5);
  assert.equal(counts.ok, 1);
  assert.equal(counts.open, 4);
  assert.equal(groupOf("SRR.Window.Send.Button"), "Window");
  assert.equal(groupOf("SRR.Title"), "");
  assert.equal(filterRows(rows, {status: "ok"}).length, 1);
  assert.equal(filterRows(rows, {group: "Window"}).length, 3);
  assert.equal(filterRows(rows, {query: "send"}).length, 2);
  assert.equal(filterRows(rows, {query: "TITEL"}).length, 1);
  const de = new Map([["SRR.Window.Close", "Schliessen"]]);
  assert.equal(filterRows(rows, {query: "schliessen", de}).length, 1);
});

test("placeholder chips insert at the cursor and replace a selection", () => {
  assert.deepEqual(insertAt("Sende an  Spieler", 9, 9, "{count}"), {value: "Sende an {count} Spieler", cursor: 16});
  assert.deepEqual(insertAt("abcdef", 2, 4, "{x}"), {value: "ab{x}ef", cursor: 5});
  assert.deepEqual(insertAt("ab", 99, 120, "{x}"), {value: "ab{x}", cursor: 5});
  assert.deepEqual(insertAt("ab", -5, undefined, "{x}"), {value: "{x}ab", cursor: 3});
});

test("plural and length hints", () => {
  assert.deepEqual(countPlaceholders("Send to {count} players"), ["count"]);
  assert.deepEqual(countPlaceholders("{n} items, {total} gold"), ["n", "total"]);
  assert.deepEqual(countPlaceholders("Hello {name}"), []);
  assert.deepEqual(lengthInfo("12345", "1234567890"), {recommended: 5, length: 10, ratio: 2});
});

test("a draft keeps only valid keys, texts and hashes", () => {
  const raw = JSON.parse(`{"texts": {"SRR.Title": "Titel", "Unknown.key": "x", "SRR.Window.Close": 5, "__proto__": "p", "constructor": "c"},
    "src": {"SRR.Title": "a1b2c3d4", "SRR.Window.Close": "zzzz"}, "base": {"SRR.Title": "Roll requests"},
    "review": {"SRR.Title": true, "Unknown.key": true}, "receipts": [{"receipt": "ABCD1234efgh", "id": "x"}, {"receipt": "<b>"}, null]}`);
  const draft = sanitizeDraft(raw, flatEn);
  assert.deepEqual(Object.keys(draft.texts), ["SRR.Title"]);
  assert.equal(draft.src["SRR.Title"], "a1b2c3d4");
  assert.equal(draft.base["SRR.Title"], "Roll requests");
  assert.deepEqual(Object.keys(draft.review), ["SRR.Title"]);
  // receipts of the old mailbox design are no submissions
  assert.equal(draft.history.length, 0);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(draft.texts), null);
  for ( const junk of [null, undefined, "x", 5, []] ) assert.deepEqual(Object.keys(sanitizeDraft(junk, flatEn).texts), []);
});

test("drafts of all modules are read back defensively", () => {
  const ok = parseDrafts(JSON.stringify({"sephrals-roll-requests|de": {texts: {}}, "bad key": {}, "__proto__|de": {}}));
  assert.ok("sephrals-roll-requests|de" in ok);
  assert.ok(!("bad key" in ok));
  assert.deepEqual(Object.keys(parseDrafts("{not json")), []);
  assert.deepEqual(Object.keys(parseDrafts(null)), []);
  assert.deepEqual(Object.keys(parseDrafts("[1,2]")), []);
  assert.equal(draftKey("sephrals-roll-requests", "pt-BR"), "sephrals-roll-requests|pt-BR");
});

test("source hashes detect a changed English text", () => {
  const draft = emptyDraft();
  setDraftText(draft, "SRR.Title", "Roll requests", "Titel");
  assert.equal(draft.src["SRR.Title"], sourceHash("Roll requests"));
  assert.deepEqual(changedKeys(draft, flatEn), []);
  const newer = new Map(flatEn).set("SRR.Title", "Roll request window");
  assert.deepEqual(changedKeys(draft, newer), ["SRR.Title"]);
  assert.equal(draft.base["SRR.Title"], "Roll requests");
  acceptEnglish(draft, "SRR.Title", "Roll request window");
  assert.deepEqual(changedKeys(draft, newer), []);
  assert.equal(draft.base["SRR.Title"], "Roll request window");
  setDraftText(draft, "SRR.Title", "Roll request window", "");
  assert.deepEqual(Object.keys(draft.texts), []);
  setDraftText(draft, "__proto__", "x", "y");
  assert.equal(({}).y, undefined);
});

test("export keeps the structure and order of English and only translated keys", () => {
  const rows = [rowOf("SRR.Window.Close", "Schliessen"), rowOf("SRR.Title", "Titel"), rowOf("SRR.Window.Send.Button", "Sende"),
    rowOf("Other.Note", "")];
  const out = exportFile(EN, rows);
  assert.deepEqual(JSON.parse(out.text), {SRR: {Title: "Titel", Window: {Close: "Schliessen"}}});
  assert.deepEqual(Object.keys(JSON.parse(out.text).SRR), ["Title", "Window"]);
  assert.equal(out.keys, 2);
  assert.deepEqual(out.skipped, ["SRR.Window.Send.Button"]);
  assert.ok(out.text.endsWith("\n"));
});

test("an import is checked like hostile input", () => {
  const good = parseImport(JSON.stringify({SRR: {Title: "Titel", Window: {Close: "Zu"}}}), EN, "xx");
  assert.ok(good.ok);
  assert.equal(good.accepted.size, 2);
  const hostile = `{"SRR": {"Title": "<img src=x onerror=alert(1)>", "Window": {"Close": "Zu\\u202Eevil", "Send": {"Button": "Sende",
    "Hint": "Klicke <i>x</i>"}}},
    "__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}, "Other": {"Note": "ok note"},
    "Unknown": {"key": "x"}, "SRR.Extra": 5}`;
  const result = parseImport(hostile, EN, "xx");
  assert.ok(result.ok);
  assert.deepEqual([...result.accepted.keys()], ["Other.Note"]);
  const rejected = result.rejected.map(r => r.key).sort();
  assert.deepEqual(rejected, ["SRR.Title", "SRR.Window.Close", "SRR.Window.Send.Button", "SRR.Window.Send.Hint"]);
  assert.ok(result.skipped.length >= 2);
  assert.ok(result.unknown.includes("Unknown.key"));
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("an import that is not a language file is rejected as a whole", () => {
  assert.equal(parseImport("{not json", EN, "xx").reason, "bad-json");
  assert.equal(parseImport("[1, 2]", EN, "xx").reason, "not-object");
  assert.equal(parseImport("null", EN, "xx").reason, "not-object");
  assert.equal(parseImport("\"text\"", EN, "xx").reason, "not-object");
  assert.equal(parseImport(5, EN, "xx").reason, "not-text");
  assert.equal(parseImport("x".repeat(2_000_001), EN, "xx").reason, "too-big");
  assert.ok(!parseImport("[1]", EN, "xx").ok);
});

test("a deeply nested import does not crash", () => {
  let text = "\"x\"";
  for ( let i = 0; i < 60; i++ ) text = `{"a": ${text}}`;
  const result = parseImport(text, EN, "xx");
  assert.ok(result.ok);
  assert.equal(result.accepted.size, 0);
});

test("the submission file carries the translated texts, their source hashes and the confirmations", () => {
  const rows = [rowOf("SRR.Title", "Titel"), rowOf("SRR.Window.Close", "Schliessen"), rowOf("SRR.Window.Send.Button", "Sende"), rowOf("Other.Note", "")];
  const at = Date.UTC(2026, 10, 22, 10, 0);
  const sub = buildSubmission({module: "sephrals-roll-requests", moduleVersion: "1.0.6", lang: "xx", rows, name: " Ada ", machine: true, note: "hi", at});
  // by hand only: a machine draft cannot be declared, the field always says none
  assert.deepEqual(Object.keys(sub), ["format", "v", "module", "moduleVersion", "lang", "createdAt", "credit", "attest", "consent", "note", "keys", "src"]);
  assert.equal(sub.format, "sephrals-translation");
  assert.equal(sub.v, 1);
  assert.equal(sub.createdAt, "2026-11-22T10:00:00.000Z");
  // the button text misses {count}: an error, it stays out
  assert.deepEqual(sub.keys, {"SRR.Title": "Titel", "SRR.Window.Close": "Schliessen"});
  assert.deepEqual(sub.src, {"SRR.Title": sourceHash("Roll requests"), "SRR.Window.Close": sourceHash("Close")});
  assert.deepEqual(sub.credit, {name: "Ada"});
  assert.deepEqual(sub.attest, {reviewed: true, license: true, machine: "none"});
  assert.equal(sub.consent, CONSENT_VERSION);
  assert.ok(isSubmission(sub));
  const plain = buildSubmission({module: "m", moduleVersion: "1", lang: "xx", rows});
  assert.deepEqual(plain.credit, {});
  assert.equal(plain.attest.machine, "none");
  for ( const not of [null, {}, {format: "sephrals-translation", v: 2, module: "m", keys: {}}, {format: "x", v: 1, module: "m", keys: {}},
    {format: "sephrals-translation", v: 1, module: "m", keys: []}, EN] ) assert.equal(isSubmission(not), false);
});

test("Import takes the translator's own submission file, but not one of another module", () => {
  const rows = [rowOf("SRR.Title", "Titel"), rowOf("SRR.Window.Close", "Schliessen")];
  const sub = buildSubmission({module: "sephrals-roll-requests", moduleVersion: "1.0.6", lang: "xx", rows});
  const back = parseImport(JSON.stringify(sub), EN, "xx", "sephrals-roll-requests");
  assert.ok(back.ok);
  assert.deepEqual([...back.accepted.keys()].sort(), ["SRR.Title", "SRR.Window.Close"]);
  assert.equal(parseImport(JSON.stringify(sub), EN, "xx", "sephrals-tavern-games").reason, "other-module");
  sub.keys["SRR.Title"] = "<img src=x onerror=alert(1)>";
  assert.equal(parseImport(JSON.stringify(sub), EN, "xx", "sephrals-roll-requests").rejected[0].key, "SRR.Title");
});

test("the new issue link carries title and text, cut to what a link can hold", () => {
  const base = "https://github.com/Sephral/sephrals-roll-requests/issues/new";
  const url = new URL(issueLink(base, "Translation: Roll Requests (ru)", "Line 1\nLine 2"));
  assert.equal(url.origin + url.pathname, base);
  assert.equal(url.searchParams.get("title"), "Translation: Roll Requests (ru)");
  assert.equal(url.searchParams.get("body"), "Line 1\nLine 2");
  assert.equal(new URL(issueLink(base, "t", "x".repeat(20000))).searchParams.get("body").length, LIMITS.issueBody);
  assert.equal(issueLink(null, "t", "b"), null);
});

test("optional submit fields: no line break, no web address, a length limit", () => {
  assert.deepEqual(validateSubmitFields({name: "Ada", note: "thanks"}), {});
  assert.equal(validateSubmitFields({name: "x".repeat(61)}).name, "too-long");
  assert.equal(validateSubmitFields({note: "x".repeat(501)}).note, "too-long");
  assert.equal(validateSubmitFields({note: "a\nb"}).note, "line-break");
  assert.equal(validateSubmitFields({note: "see https://example.com"}).note, "url");
  assert.equal(validateSubmitFields({name: "www.evil.example"}).name, "url");
});

test("the issues page", () => {
  assert.equal(issueUrl({url: "https://github.com/Sephral/sephrals-roll-requests.git"}), "https://github.com/Sephral/sephrals-roll-requests/issues/new");
  assert.equal(issueUrl({bugs: "https://github.com/Sephral/sephrals-roll-requests/issues"}), "https://github.com/Sephral/sephrals-roll-requests/issues/new");
  assert.equal(issueUrl({bugs: {url: "https://github.com/Sephral/x/issues/"}, url: "https://example.com"}), "https://github.com/Sephral/x/issues/new");
  assert.equal(issueUrl({url: "https://evil.example/Sephral/x.git"}), null);
  assert.equal(issueUrl({url: "javascript:alert(1)"}), null);
  assert.equal(issueUrl({}), null);
  assert.equal(issueUrl(null), null);
  assert.equal(issueUrl("https://github.com/Sephral/x/releases/latest/download/module.json"), null);
  assert.equal(issueUrl({manifest: "https://github.com/Sephral/x/releases/latest/download/module.json", url: "https://github.com/Sephral/x", bugs: "https://github.com/Sephral/x/issues"}), "https://github.com/Sephral/x/issues/new");
  assert.equal(issueTitle("Roll Requests", "pt-BR"), "Translation: Roll Requests (pt-BR)");
});

test("the chat command finds module and language in any order", () => {
  const modules = [{id: "sephrals-roll-requests", title: "Sephral’s Roll Requests"}, {id: "sephrals-tavern-games", title: "Sephral’s Tavern Games"}];
  assert.equal(parseTranslateCommand("hello", modules), null);
  assert.equal(parseTranslateCommand("/translatex", modules), null);
  assert.deepEqual(parseTranslateCommand("/translate", modules), {module: null, lang: null});
  assert.deepEqual(parseTranslateCommand("/translate roll-requests pt-br", modules), {module: "sephrals-roll-requests", lang: "pt-BR"});
  assert.deepEqual(parseTranslateCommand("/translate xx tavern", modules), {module: "sephrals-tavern-games", lang: "xx"});
  assert.deepEqual(parseTranslateCommand("/Translate  sephrals-tavern-games", modules), {module: "sephrals-tavern-games", lang: null});
  assert.deepEqual(parseTranslateCommand("/translate ../../etc", modules), {module: null, lang: null});
  // Foundry 14 hands over the HTML of its chat editor
  assert.deepEqual(parseTranslateCommand("<p>/translate tavern xx</p>", modules), {module: "sephrals-tavern-games", lang: "xx"});
  assert.deepEqual(parseTranslateCommand("<p>/translate&nbsp;xx<br></p>", modules), {module: null, lang: "xx"});
  assert.equal(parseTranslateCommand("<p>hello /translate</p>", modules), null);
});

test("refresh hook payload carries full keys, all keys after a restore", () => {
  assert.equal(REFRESH_HOOK, "sephrals-translator.refresh");
  const all = ["SRR.Title", "SRR.Window.Close"];
  const changed = refreshPayload("sephrals-roll-requests", ["SRR"], new Set(["SRR.Title"]), all);
  assert.deepEqual(changed, {module: "sephrals-roll-requests", moduleId: "sephrals-roll-requests", namespace: "SRR", roots: ["SRR"], keys: ["SRR.Title"]});
  assert.deepEqual(refreshPayload("m", ["SRR", "SRR2"], null, all).keys, all);
  assert.equal(refreshPayload("m", ["SRR", "SRR2"], null, all).namespace, "SRR");
});

test("a module listens only when its api says so", () => {
  assert.equal(listensToRefresh({translatorRefresh: true}), true);
  for ( const api of [null, undefined, {}, {translatorRefresh: "yes"}, {translatorRefresh: false}, "x"] ) assert.equal(listensToRefresh(api), false);
  const pins = {translatorRefresh: true, translatorRefreshKeys: key => key === "SMP.Player.unknownPrivate"};
  assert.equal(drawsOnCanvas(pins, "SMP.Player.unknownPrivate"), true);
  assert.equal(drawsOnCanvas(pins, "SMP.Title"), false);
  assert.equal(drawsOnCanvas({translatorRefresh: false, translatorRefreshKeys: () => true}, "x"), false);
  assert.equal(drawsOnCanvas({translatorRefresh: true}, "x"), false);
  assert.equal(drawsOnCanvas({translatorRefresh: true, translatorRefreshKeys: () => { throw new Error("boom"); }}, "x"), false);
  assert.equal(drawsOnCanvas({translatorRefresh: true, translatorRefreshKeys: () => "yes"}, "x"), false);
});

/* ---------- earlier submissions ---------- */

test("a submission is remembered, newest first, only the newest keep their texts", () => {
  const draft = emptyDraft();
  for ( let i = 0; i < HISTORY_MAX + 2; i++ ) addHistory(draft, {at: 1000 + i, version: "1.0.6", via: i % 2 ? "github" : "discord", texts: {"SRR.Title": `T${i}`}});
  assert.equal(draft.history.length, HISTORY_MAX);
  assert.equal(draft.history[0].at, 1000 + HISTORY_MAX + 1);
  assert.equal(draft.history[0].via, "github");
  assert.equal(draft.history.filter(e => e.texts).length, HISTORY_TEXTS);
  assert.equal(draft.history[0].count, 1);
  assert.equal(addHistory(emptyDraft(), {at: 1, via: "evil", texts: {}}).via, "discord");
  // read back like any stored draft: unknown ways, bad times, keys and texts are dropped
  const raw = JSON.parse(JSON.stringify(draft));
  raw.history.unshift({at: 5, via: "mail", texts: {}}, null, {at: "x", via: "discord"}, {at: 6, via: "discord", version: "1.0<script>",
    texts: {"SRR.Title": "ok", "Unknown.key": "x", "__proto__": "p", "SRR.Window.Close": 5}});
  const back = sanitizeDraft(raw, flatEn);
  assert.equal(back.history.length, HISTORY_MAX);
  assert.equal(back.history[0].via, "discord");
  assert.equal(back.history[0].version, "1.0script");
  assert.deepEqual(Object.keys(back.history[0].texts), ["SRR.Title"]);
  assert.equal(back.history.filter(e => e.texts).length, HISTORY_TEXTS);
});

test("compare with the last submission: what changed, nothing changed", () => {
  const draft = emptyDraft();
  const rows = () => [rowOf("SRR.Title", draft.texts["SRR.Title"] ?? ""), rowOf("SRR.Window.Close", draft.texts["SRR.Window.Close"] ?? "")];
  setDraftText(draft, "SRR.Title", flatEn.get("SRR.Title"), "Wurfanfragen");
  assert.equal(lastSent(draft), null);
  assert.equal(unchangedSinceLast(draft, rows()), false);
  addHistory(draft, {at: 1, via: "discord", texts: sendableTexts(rows())});
  assert.deepEqual(Object.keys(sendableTexts(rows())), ["SRR.Title"]);
  assert.equal(unchangedSinceLast(draft, rows()), true);
  setDraftText(draft, "SRR.Window.Close", flatEn.get("SRR.Window.Close"), "Schliessen");
  assert.deepEqual([...changedSince(lastSent(draft), rows())], ["SRR.Window.Close"]);
  setDraftText(draft, "SRR.Title", flatEn.get("SRR.Title"), "");
  assert.deepEqual([...changedSince(lastSent(draft), rows())].sort(), ["SRR.Title", "SRR.Window.Close"]);
  draft.history[0].texts = null;
  assert.equal(lastSent(draft), null);
  assert.equal(changedSince(null, rows()).size, 0);
});

test("the copy of a submission is a language file Import takes back", () => {
  const text = copyFileText(EN, {"SRR.Window.Close": "Zu", "SRR.Title": "Titel"});
  assert.deepEqual(JSON.parse(text), {SRR: {Title: "Titel", Window: {Close: "Zu"}}});
  const back = parseImport(text, EN, "de");
  assert.equal(back.accepted.size, 2);
  const at = new Date(2026, 10, 21, 9, 5).getTime();
  assert.equal(copyFileName("sephrals-roll-requests", "pt-br", at), "sephrals-roll-requests-pt-BR-2026-11-21-0905.json");
  assert.equal(copyFileName("../x", "../etc", at), "x-xx-2026-11-21-0905.json");
});

/* ---------- using a translation ---------- */

test("the settings of use and shared are read like hostile input", () => {
  assert.deepEqual({...parseUse(JSON.stringify({"sephrals-roll-requests": "pt-br", "evil": "de", "sephrals-x": "en", "sephrals-y": "../x", "__proto__": "de"}))},
    {"sephrals-roll-requests": "pt-BR"});
  for ( const junk of [null, 5, "{", "[]", "\"x\""] ) assert.deepEqual(Object.keys(parseUse(junk)), []);
  const shared = parseShared(JSON.stringify({
    "sephrals-roll-requests": {lang: "ru", at: 5, texts: {"SRR.Title": "Броски", "SRR.Window.Close": "", "SETTINGS.Long": "x", "__proto__.a": "x", "srr": "x", "SRR.Hint": 3}},
    "sephrals-bad": {lang: "en", texts: {"SRR.Title": "x"}},
    "other": {lang: "ru", texts: {"SRR.Title": "x"}}
  }));
  assert.deepEqual(Object.keys(shared), ["sephrals-roll-requests"]);
  assert.deepEqual({...shared["sephrals-roll-requests"].texts}, {"SRR.Title": "Броски"});
  assert.equal(shared["sephrals-roll-requests"].at, 5);
});

test("only keys under a module prefix may be used", () => {
  for ( const ok of ["SRR.Title", "scbr.dialog.title", "FOLIO.Tab.Spells", "SCBR.a.b"] ) assert.ok(usableKey(ok), ok);
  for ( const bad of ["Title", "SETTINGS.Foo", "DOCUMENT.Actor", "SRR..x", "SRR.__proto__", "__proto__.x", "1AB.x", 5, null, `SRR.${"x".repeat(300)}`] ) {
    assert.ok(!usableKey(bad), String(bad));
  }
});

test("which translation is in use: own choice first, the shared one unless the module language is fixed", () => {
  const use = {"sephrals-a": "ru"};
  const shared = {"sephrals-a": {lang: "uk"}, "sephrals-b": {lang: "uk"}};
  assert.deepEqual(pickUse("sephrals-a", {use, shared}), {lang: "ru", source: "me"});
  assert.deepEqual(pickUse("sephrals-b", {use, shared}), {lang: "uk", source: "world"});
  assert.equal(pickUse("sephrals-b", {use, shared, forced: true}), null);
  assert.deepEqual(pickUse("sephrals-a", {use, shared, forced: true}), {lang: "ru", source: "me"});
  assert.equal(pickUse("sephrals-c", {use, shared}), null);
  assert.equal(useModeOf("sephrals-a", "ru", use, shared), "me");
  assert.equal(useModeOf("sephrals-a", "uk", use, shared), "world");
  assert.equal(useModeOf("sephrals-b", "ru", use, shared), "preview");
});

test("used texts leave out errors, unknown keys and empty texts", () => {
  const out = usableTexts({"SRR.Title": "Wurfanfragen", "SRR.Window.Send.Button": "Senden an Spieler", "SRR.Window.Send.Hint": "Klick <b>senden</b>",
    "SRR.Window.Close": "  ", "Other.Note": "Notiz", "SRR.Nope": "x"}, flatEn, "de");
  // the placeholder {count} is missing in the button text: an error, the English text stays
  assert.deepEqual([...out.keys()], ["SRR.Title", "SRR.Window.Send.Hint", "Other.Note"]);
  assert.equal(usableTexts({"SRR.Title": "<img src=x onerror=alert(1)>"}, flatEn, "de").size, 0);
  assert.equal(usableTexts(null, flatEn, "de").size, 0);
});

test("check details come as data for the UI language", () => {
  const [placeholder] = checkValue("Scene check: {avg} of 5 from {count} answers", "Check {avg}", {lang: "de"}).errors;
  assert.deepEqual(checkDetail(placeholder, "keine"), {key: "STL.CheckDetail.placeholder-mismatch", data: {missing: "{count}", extra: "keine"}});
  const [handlebars] = checkValue("Hello", "Hello {{x}} }", {lang: "de"}).errors.filter(e => e.code === "handlebars-mismatch");
  assert.equal(checkDetail(handlebars ?? {code: "handlebars-mismatch"}), null);
  assert.equal(checkDetail(null), null);
  assert.deepEqual(checkDetail({code: "too-long", data: {max: 10000}}).data, {max: "10000"});
});

test("the next text that still wants work follows the list and wraps around", () => {
  const rows = new Map([["a", {status: "ok"}], ["b", {status: "open"}], ["c", {status: "warning"}], ["d", {status: "error"}], ["e", {status: "ok"}]]);
  const order = ["a", "b", "c", "d", "e"];
  assert.equal(nextTodoKey(order, rows, "a"), "b");
  assert.equal(nextTodoKey(order, rows, "b"), "d");
  assert.equal(nextTodoKey(order, rows, "d"), "b");
  assert.equal(nextTodoKey(order, rows, "d", -1), "b");
  assert.equal(nextTodoKey(order, rows, null), "b");
  assert.equal(nextTodoKey(order, rows, "zz"), "b");
  assert.equal(nextTodoKey(["a", "e"], rows, "a"), null);
  assert.equal(nextTodoKey([], rows, "a"), null);
});

test("the memory offers distinct earlier translations of the same English, most used first", () => {
  const memory = new Map([[memoryKey(" Close "), [{text: "«Zu»", where: "A"}, {text: "«Schließen»", where: "B"}, {text: "«Schließen»", where: "C"}, {text: " ", where: "D"}]]]);
  const out = memoryFor(memory, "Close");
  assert.deepEqual(out.map(e => e.text), ["«Schließen»", "«Zu»"]);
  assert.deepEqual(out[0].where, ["B", "C"]);
  assert.deepEqual(memoryFor(memory, "Close", {own: "«Schließen»"}).map(e => e.text), ["«Zu»"]);
  assert.deepEqual(memoryFor(memory, "Open"), []);
});

test("texts with the same English and no translation yet are found for filling", () => {
  const rows = new Map([["a", {en: "Close", status: "ok"}], ["b", {en: "Close ", status: "open"}], ["c", {en: "Close", status: "error"}], ["d", {en: "Open", status: "open"}]]);
  assert.deepEqual(sameEnglishOpen(rows, "a"), ["b"]);
  assert.deepEqual(sameEnglishOpen(rows, "d"), []);
});

test("the language picker names each language, marks the shipped ones and never offers English", () => {
  const names = {ru: {local: "Russisch", native: "Русский"}, de: {local: "Deutsch", native: "Deutsch"}, "pt-BR": {local: "Portugiesisch (Brasilien)", native: "Português (Brasil)"}};
  const out = languageChoices({extra: ["en", "de", "bad code!"], current: "xx", shipped: ["de"], nameOf: code => names[code] ?? {}});
  const by = Object.fromEntries(out.map(c => [c.code, c]));
  assert.ok(!by.en);
  assert.equal(by.ru.label, "Russisch · Русский (ru)");
  assert.equal(by.de.label, "Deutsch (de)");
  assert.equal(by.de.shipped, true);
  assert.equal(by.ru.shipped, false);
  assert.equal(by["pt-BR"].label, "Portugiesisch (Brasilien) · Português (Brasil) (pt-BR)");
  assert.equal(by.xx.label, "xx");
  assert.equal(out.length, LANGUAGES.length + 1);
  const labels = out.map(c => c.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b)));
});

test("an example fills the placeholders with sample values and keeps unknown ones", () => {
  assert.equal(sampleText("Scene check: {avg} of 5 from {count} answers"), "Scene check: 3 of 5 from 3 answers");
  assert.equal(sampleText("{name} rolled for {module}", {module: "Table Compass"}), "Ada rolled for Table Compass");
  assert.equal(sampleText("Mood {axis}"), "Mood {axis}");
  assert.equal(sampleText(null), "");
});

test("the memory compares English texts with folded spaces, letters untouched", () => {
  assert.equal(memoryKey("  Close   this  "), "Close this");
  assert.equal(memoryKey("Session settings"), "Session settings");
});

test("a module made for another system, or needing an inactive module, cannot run here", () => {
  const world = {systemId: "dnd5e", active: id => id === "some-library"};
  assert.deepEqual(moduleNeeds({systems: [{id: "crucible"}]}, world), {systems: ["crucible"], modules: []});
  assert.deepEqual(moduleNeeds({systems: [{id: "crucible"}, {id: "dnd5e"}]}, world), {systems: [], modules: []});
  assert.deepEqual(moduleNeeds({requires: [{id: "ember", type: "module"}, {id: "some-library", type: "module"}]}, world), {systems: [], modules: ["ember"]});
  assert.deepEqual(moduleNeeds(null, world), {systems: [], modules: []});
  assert.deepEqual(moduleNeeds({systems: [{id: "crucible"}], requires: [{id: "ember"}]}, {systemId: "crucible", active: () => true}), {systems: [], modules: []});
});
