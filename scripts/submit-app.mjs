/**
 * The submit dialog. A translation is handed in on Sephral's Discord server or as an issue on GitHub (decision of
 * 2026-11-22): the dialog saves the submission file, prepares the text of the message, copies it and opens Discord or
 * the new issue page. The module sends nothing itself, so there is no server, no receipt and nothing to withdraw
 * through the module: the translator writes in the channel or the issue.
 *
 * Two checkboxes are required (translated by hand, without machine translation or AI, and the licence to publish), a
 * name for the credits and a note are optional. Earlier submissions stay in the draft of this browser.
 */

import {TEMPLATES, setting, t, tEnglish} from "./config.mjs";
import {trace} from "./debug.mjs";
import {DISCORD_CHANNEL, DISCORD_URL, addHistory, buildSubmission, copyFileName, coverage, issueLink, issueTitle, issueUrl,
  unchangedSinceLast, validateSubmitFields} from "./translator-logic.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/** Create an element; foreign text only as textContent. */
/** A link as people read it: host and path, without the long query of a prefilled issue. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return String(url ?? "");
  }
}

function el(tag, {className = "", text = null, attrs = {}} = {}, ...children) {
  const node = document.createElement(tag);
  if ( className ) node.className = className;
  if ( text !== null ) node.textContent = text;
  for ( const [name, value] of Object.entries(attrs) ) node.setAttribute(name, value);
  for ( const child of children ) if ( child ) node.append(child);
  return node;
}

export class SubmitApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} options
   * @param {import("./translator-app.mjs").TranslatorApp} options.translator
   */
  constructor({translator, ...options}) {
    super({...options, id: "stl-submit"});
    this.translator = translator;
    this.last = null;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["stl-app", "stl-submit-app"],
    window: {icon: "fa-solid fa-paper-plane", resizable: true},
    position: {width: Math.min(580, Math.max(300, window.innerWidth - 30)), height: "auto"}
  };

  /** @override */
  static PARTS = {main: {template: `${TEMPLATES}/submit.hbs`, scrollable: [""]}};

  /** @override */
  get title() {
    return t("STL.Submit.title");
  }

  /** @override */
  async _prepareContext() {
    const keys = ["rule", "attest", "license", "name", "namePlaceholder", "note", "privacy", "cancel", "close", "viaDiscord",
      "viaGithub", "message", "copy", "history", "historyHint", "creditTitle", "creditNamed", "creditAnonymous", "links", "linkDiscord", "linkGithub"];
    const text = Object.fromEntries(keys.map(key => [key, t(`STL.Submit.${key}`)]));
    text.intro = t("STL.Submit.intro", {channel: `#${DISCORD_CHANNEL}`});
    return {text};
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    root.dataset.stlSelf = "1";
    root.dataset.stlTheme = setting("theme");
    if ( root.dataset.wired ) return;
    root.dataset.wired = "1";
    root.querySelector(".stl-form").addEventListener("input", () => this.#update());
    // typing a name means: credit me under this name
    root.querySelector("[name=name]").addEventListener("input", ev => {
      if ( ev.target.value.trim() ) root.querySelector("[name=credit][value=named]").checked = true;
      this.#update();
    });
    root.querySelector("[name=credit][value=named]").addEventListener("change", () => root.querySelector("[name=name]").focus());
    // the links work even where the browser blocks a new tab opened by the module
    root.querySelector(".stl-link-discord").href = DISCORD_URL;
    const issues = this.#issueBase();
    const github = root.querySelector(".stl-link-github");
    github.hidden = !issues;
    if ( issues ) github.href = issues;
    root.addEventListener("click", ev => {
      const button = ev.target.closest("button[data-stl]");
      if ( !button || button.disabled ) return;
      const action = button.dataset.stl;
      if ( action === "cancel" ) this.close();
      else if ( action === "via-discord" ) this.#handIn("discord");
      else if ( action === "via-github" ) this.#handIn("github");
      else if ( action === "copy" ) this.#copy();
      else if ( action === "save-entry" ) this.#saveEntry(Number(button.dataset.index));
    });
    root.querySelector("[name=message]").addEventListener("focus", ev => ev.target.select());
    const cov = coverage(this.translator.allRows());
    root.querySelector(".stl-summary").textContent = t("STL.Submit.summary", {count: cov.translatedKeys, keys: cov.translatedKeys, words: cov.translatedWords,
      module: this.translator.module?.title ?? "", lang: this.translator.view.lang});
    root.querySelector("[data-stl=via-github]").hidden = !this.#issueBase();
    this.#paintHistory();
    this.#update();
  }

  /** The values of the form. */
  #values() {
    const form = this.element.querySelector(".stl-form");
    const get = name => form.elements[name];
    const credit = form.querySelector("[name=credit]:checked")?.value ?? "";
    // anonymous: no name goes into the file or the message, whatever the field still holds
    return {reviewed: get("attestReviewed").checked, license: get("attestLicense").checked, credit,
      name: (credit === "named") ? get("name").value : "", note: get("note").value};
  }

  /** Problems that block handing in: no translation yet, errors in a text. */
  #problems() {
    const rows = this.translator.allRows();
    const problems = [];
    const bad = rows.filter(r => r.errors.length);
    if ( !rows.some(r => r.translated) ) problems.push(t("STL.Submit.nothing"));
    if ( bad.length ) problems.push(t("STL.Submit.errors", {count: bad.length}));
    return problems;
  }

  /** Enable the two ways when everything is in order. */
  #update() {
    const root = this.element;
    const v = this.#values();
    const first = Object.entries(validateSubmitFields(v))[0];
    const message = root.querySelector(".stl-fielderror");
    message.textContent = first ? t(`STL.Submit.field.${first[1]}`, {field: t(`STL.Submit.${first[0]}`)}) : "";
    message.hidden = !first;
    const problems = this.#problems();
    const list = root.querySelector(".stl-problems");
    list.replaceChildren(...problems.map(text => el("li", {text})));
    list.hidden = !problems.length;
    const hint = root.querySelector(".stl-hint-line");
    const unchanged = !problems.length && unchangedSinceLast(this.translator.draft, this.translator.allRows());
    hint.textContent = unchanged ? t("STL.Submit.unchanged") : "";
    hint.hidden = !unchanged;
    // what is still missing, so a disabled button never leaves the translator guessing
    const missing = [];
    if ( !v.reviewed ) missing.push(t("STL.Submit.missingParts.attest"));
    if ( !v.license ) missing.push(t("STL.Submit.missingParts.license"));
    if ( !v.credit ) missing.push(t("STL.Submit.missingParts.credit"));
    else if ( (v.credit === "named") && !v.name.trim() ) missing.push(t("STL.Submit.missingParts.name"));
    const line = root.querySelector(".stl-missing");
    line.textContent = (missing.length && !problems.length) ? t("STL.Submit.missing", {list: missing.join(", ")}) : "";
    line.hidden = !line.textContent;
    const ready = !missing.length && !first && !problems.length;
    for ( const button of root.querySelectorAll("[data-stl=via-discord], [data-stl=via-github]") ) button.disabled = !ready;
  }

  /** The new issue page of the module (from bugs or url of its module.json, only github.com). */
  #issueBase() {
    return issueUrl(this.translator.module?.manifest);
  }

  /**
   * Save the submission file, prepare the message, copy it and open Discord or the new issue page.
   * @param {"discord"|"github"} via
   */
  async #handIn(via) {
    const tr = this.translator;
    const v = this.#values();
    const at = Date.now();
    const submission = buildSubmission({module: tr.view.moduleId, moduleVersion: tr.module?.version, lang: tr.view.lang,
      rows: tr.allRows(), name: v.name, note: v.note, at});
    const file = copyFileName(tr.view.moduleId, tr.view.lang, at);
    foundry.utils.saveDataToFile(`${JSON.stringify(submission, null, 2)}\n`, "application/json", file);
    const text = this.#messageText(submission, file, v);
    const target = via === "github"
      ? issueLink(this.#issueBase(), issueTitle(tr.module?.title ?? tr.view.moduleId, tr.view.lang), text)
      : DISCORD_URL;
    this.last = {via, target};
    // copy while this page still has the focus and the click counts, then open the new tab
    this.#showSteps(via, file, text);
    await this.#copy({quiet: true});
    this.#open(this.last);
    addHistory(tr.draft, {at, version: tr.module?.version, via, texts: submission.keys});
    await tr.save();
    trace.add("handIn", {via, keys: Object.keys(submission.keys).length});
    this.#paintHistory();
    tr.historyChanged();
    this.setPosition({height: "auto"});
  }

  /**
   * The text of the message in the channel or the issue, always in English so everyone there can read it: what, how
   * many, the two confirmations, the credit (a name or anonymous) and the note.
   * @param {object} submission
   * @param {string} file
   * @param {object} v
   * @returns {string}
   */
  #messageText(submission, file, v) {
    const tr = this.translator;
    const lines = [
      tEnglish("STL.Submit.msg.head", {module: tr.module?.title ?? submission.module, id: submission.module, version: submission.moduleVersion || "?",
        lang: submission.lang, count: Object.keys(submission.keys).length}),
      tEnglish("STL.Submit.msg.file", {file}),
      "",
      `- ${tEnglish("STL.Submit.attest")}`,
      `- ${tEnglish("STL.Submit.license")}`,
      "",
      v.name.trim() ? tEnglish("STL.Submit.msg.name", {name: v.name.trim()}) : tEnglish("STL.Submit.msg.anonymous")
    ];
    if ( v.note.trim() ) lines.push("", tEnglish("STL.Submit.msg.note", {note: v.note.trim()}));
    return lines.join("\n");
  }

  /** The steps after the click: where the file is, where to put it, the text to paste. */
  #showSteps(via, file, text) {
    const root = this.element;
    root.querySelector(".stl-form").hidden = true;
    const box = root.querySelector(".stl-steps");
    box.hidden = false;
    box.querySelector(".stl-steps-head").textContent = t(`STL.Submit.steps.${via}Head`);
    const steps = via === "github"
      ? [t("STL.Submit.steps.saved", {file}), t("STL.Submit.steps.githubOpen"), t("STL.Submit.steps.githubAttach", {file})]
      : [t("STL.Submit.steps.saved", {file}), t("STL.Submit.steps.discordOpen", {channel: `#${DISCORD_CHANNEL}`}),
        t("STL.Submit.steps.discordPost", {file})];
    box.querySelector(".stl-steps-list").replaceChildren(...steps.map(step => el("li", {text: step})));
    box.querySelector("[name=message]").value = text;
    box.querySelector(".stl-reopen-label").textContent = t(`STL.Submit.reopen.${via}`);
    // a real link to the page, also shown as text: it opens even where the browser blocked the new tab
    const target = this.last?.target ?? "";
    box.querySelector("[data-stl=reopen]").href = target;
    box.querySelector(".stl-open-hint").textContent = t("STL.Submit.openHint");
    const link = box.querySelector(".stl-open-link");
    link.href = target;
    link.textContent = shortUrl(target);
    this.setPosition({height: "auto"});
  }

  /** Open Discord or the issue page in a new tab, without telling them where the click came from. */
  #open(last) {
    if ( last?.target ) window.open(last.target, "_blank", "noopener,noreferrer");
  }

  /** Copy the message text. Browsers allow it only on https or localhost, the text stays in the field to copy by hand. */
  async #copy({quiet = false} = {}) {
    const area = this.element?.querySelector("[name=message]");
    if ( !area ) return false;
    let ok = false;
    try {
      await navigator.clipboard.writeText(area.value);
      ok = true;
    } catch {
      area.focus();
      area.select();
    }
    if ( !quiet || !ok ) this.#historyMessage(t(ok ? "STL.Submit.copied" : "STL.Submit.copyByHand"));
    return ok;
  }

  #saveEntry(index) {
    const tr = this.translator;
    const entry = tr.draft.history[index];
    if ( !entry?.texts ) return;
    const submission = buildSubmission({module: tr.view.moduleId, moduleVersion: entry.version, lang: tr.view.lang, at: entry.at,
      rows: Object.entries(entry.texts).map(([key, text]) => ({key, text, en: tr.rows.get(key)?.en ?? "", translated: true}))});
    const file = copyFileName(tr.view.moduleId, tr.view.lang, entry.at);
    foundry.utils.saveDataToFile(`${JSON.stringify(submission, null, 2)}\n`, "application/json", file);
    this.#historyMessage(t("STL.Submit.steps.saved", {file}));
  }

  #historyMessage(text) {
    const box = this.element?.querySelector(".stl-history-msg");
    if ( !box ) return;
    box.textContent = text;
    box.hidden = !text;
  }

  /** The list of earlier submissions of this module and language. */
  #paintHistory() {
    const root = this.element;
    const entries = this.translator.draft.history;
    root.querySelector(".stl-history").hidden = !entries.length;
    root.querySelector(".stl-history-list").replaceChildren(...entries.map((entry, index) => {
      const when = entry.at ? new Date(entry.at).toLocaleString([], {dateStyle: "medium", timeStyle: "short"}) : "";
      const save = entry.texts
        ? el("button", {text: t("STL.Submit.save"), attrs: {type: "button", "data-stl": "save-entry", "data-index": String(index)}}) : null;
      return el("li", {attrs: {"data-via": entry.via}},
        el("div", {className: "stl-history-head"}, el("strong", {text: when}),
          el("span", {className: "stl-history-state", text: t(`STL.Submit.via.${entry.via}`)})),
        el("span", {className: "stl-history-meta", text: t("STL.Submit.entry", {count: entry.count, version: entry.version || "?"})}),
        save ? el("div", {className: "stl-buttons"}, save) : null);
    }));
  }
}
