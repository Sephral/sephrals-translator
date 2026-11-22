/**
 * The review window. A reviewer opens the submission file of another translator: every text shows in the real windows
 * of the module while the window is open (the same live preview as the translator), and each one is marked OK or Needs
 * change, with a better wording and a comment if needed. The state is kept in this browser, so a review can go on
 * later. The result is a review file for the translator (who imports it, see translator-app) and a short text for the
 * post in the review queue on Discord. Nothing is sent anywhere.
 */

import {MODULE_ID, TEMPLATES, addSettingsGear, setting, t, tEnglish} from "./config.mjs";
import {runtime, trace} from "./debug.mjs";
import {LivePreview} from "./preview.mjs";
import {readReviews, saveReview} from "./store.mjs";
import {restingTexts} from "./use.mjs";
import {describeWhere, openWhereShown, placeBeside, renderCode} from "./where.mjs";
import {REVIEW_LIMITS, REVIEW_STATUSES, buildReviewFile, checkSuggestion, readSubmissionForReview, reviewCounts, reviewKey,
  reviewMessage, reviewStatus, sanitizeReview, emptyReview} from "./review-logic.mjs";
import {checkDetail, copyFileName, PREVIEW_BLOCKERS} from "./translator-logic.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/** Create an element; foreign text only as textContent. */
function el(tag, {className = "", text = null, attrs = {}} = {}, ...children) {
  const node = document.createElement(tag);
  if ( className ) node.className = className;
  if ( text !== null ) node.textContent = text;
  for ( const [name, value] of Object.entries(attrs) ) node.setAttribute(name, value);
  for ( const child of children ) if ( child ) node.append(child);
  return node;
}

export class ReviewApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} options
   * @param {object} options.data   The parsed submission file
   */
  constructor({data, ...options}) {
    super({...options, id: "stl-review"});
    this.data = data;
    this.preview = new LivePreview();
    this.moduleId = data?.module ?? null;
    this.submission = null;
    this.rows = [];
    this.review = emptyReview();
    this.view = {status: "all", query: "", selected: null};
    this.saveTimer = null;
    this.ready = null;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["stl-app", "stl-translator", "stl-review"],
    window: {icon: "fa-solid fa-clipboard-check", resizable: true},
    position: {width: Math.min(1000, Math.max(320, window.innerWidth - 40)), height: Math.min(700, Math.max(320, window.innerHeight - 70))}
  };

  /** @override */
  static PARTS = {main: {template: `${TEMPLATES}/review.hbs`}};

  /** @override */
  get title() {
    return t("STL.Review.title");
  }

  /** @override */
  async _prepareContext() {
    const keys = ["rule", "hint", "filters", "search", "keys", "pick", "reviewer", "copy", "save"];
    return {text: Object.fromEntries(keys.map(key => [key, t(`STL.Review.${key}`)]))};
  }

  /** @override */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    addSettingsGear(frame);
    return frame;
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    runtime.review = this;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    root.dataset.stlSelf = "1";
    root.dataset.stlTheme = setting("theme");
    if ( !this.ready ) {
      this.#wire();
      this.ready = this.#begin().catch(err => {
        console.error(`${MODULE_ID} |`, err);
        this.#message(t("STL.Review.reject.not-submission"));
      });
    }
  }

  /** @override */
  async _onClose(options) {
    clearTimeout(this.saveTimer);
    clearInterval(this.poll);
    try {
      await this.#saveNow();
      for ( const [id, m] of this.preview.mods ) this.preview.adopt(id, restingTexts(id, m.en, m.base));
      await this.preview.restoreAll();
      this.preview.clearMarks();
    } finally {
      if ( runtime.review === this ) runtime.review = null;
    }
    await super._onClose?.(options);
  }

  /* -------------------------------------------- */

  #message(text) {
    const box = this.element?.querySelector(".stl-langmsg");
    if ( !box ) return;
    box.textContent = text;
    box.hidden = !text;
  }

  /** Read the file, load the module, apply the submitted texts to the live preview. */
  async #begin() {
    const mod = game.modules.get(this.moduleId);
    if ( !mod?.active ) {
      this.#message(t("STL.Review.noModule", {module: String(this.moduleId ?? "?").slice(0, 80)}));
      return;
    }
    const m = await this.preview.load(this.moduleId);
    const read = readSubmissionForReview(this.data, m.en);
    if ( !read.ok ) {
      this.#message(t(`STL.Review.reject.${read.reason}`));
      return;
    }
    this.submission = read.submission;
    this.rows = read.rows;
    this.module = mod;
    const stored = readReviews()[reviewKey(this.submission)];
    this.review = sanitizeReview(stored, new Set(this.rows.map(r => r.key)));
    this.element.querySelector("[name=reviewer]").value = this.review.reviewer;
    // the submitted texts in the real windows (a text that could act as markup keeps the English one)
    const texts = new Map(this.rows.map(row => [row.key, row.errors.some(e => PREVIEW_BLOCKERS.has(e.code)) ? row.en : row.text]));
    const changed = this.preview.set(this.moduleId, texts);
    if ( changed.length ) await this.preview.refresh(this.moduleId, {keys: changed, scoped: false});
    this.element.querySelector(".stl-review-head").textContent = t("STL.Review.head", {module: mod.title, version: this.submission.moduleVersion || "?",
      lang: this.submission.lang, translator: this.submission.translator || t("STL.Review.anonymous"), count: this.rows.length});
    trace.add("review", {module: this.moduleId, lang: this.submission.lang, keys: this.rows.length});
    this.#paintAll();
    // which files use a key: for "after reload" and for the hint where a text appears
    this.preview.index(this.moduleId).then(() => this.#refreshWhere());
    this.preview.learnSamples(this.moduleId).then(() => this.#refreshWhere());
    // a window opened or drawn again later gets the outline of the selected text back
    this.poll = setInterval(() => {
      if ( this.view.selected && !this.preview.marksAlive() ) this.#refreshWhere();
    }, 1500);
  }

  #wire() {
    const root = this.element;
    root.querySelector(".stl-filters").addEventListener("click", ev => {
      const button = ev.target.closest("button[data-status]");
      if ( !button ) return;
      this.view.status = button.dataset.status;
      this.#paintFilters();
      this.#paintList();
    });
    root.querySelector("[name=query]").addEventListener("input", ev => {
      this.view.query = ev.target.value;
      this.#paintList();
    });
    root.querySelector(".stl-list").addEventListener("click", ev => {
      const li = ev.target.closest("li[data-key]");
      if ( li ) this.#select(li.dataset.key);
    });
    root.querySelector("[name=reviewer]").addEventListener("input", ev => {
      this.review.reviewer = ev.target.value.slice(0, REVIEW_LIMITS.name);
      this.#saveSoon();
    });
    root.querySelector("[data-stl=save]").addEventListener("click", () => this.saveFile());
    root.querySelector("[data-stl=copy]").addEventListener("click", () => this.copyMessage());
  }

  #paintAll() {
    if ( !this.rendered ) return;
    this.#paintFilters();
    this.#paintList();
    this.#paintDetail();
    this.#paintProgress();
  }

  #paintFilters() {
    const counts = reviewCounts(this.rows, this.review);
    const box = this.element.querySelector(".stl-filters");
    box.replaceChildren(...["all", ...REVIEW_STATUSES].map(status => el("button", {className: "stl-chip",
      text: `${t(`STL.Review.status.${status}`)} ${counts[status]}`,
      attrs: {type: "button", "data-status": status, "aria-pressed": String(this.view.status === status)}})));
  }

  #filtered() {
    const q = this.view.query.trim().toLowerCase();
    return this.rows.filter(row => ((this.view.status === "all") || (reviewStatus(this.review, row.key) === this.view.status))
      && (!q || row.key.toLowerCase().includes(q) || row.en.toLowerCase().includes(q) || row.text.toLowerCase().includes(q)));
  }

  #listItem(row) {
    const status = reviewStatus(this.review, row.key);
    const li = el("li", {attrs: {role: "option", "data-key": row.key, "data-status": status === "change" ? "warning" : status,
      title: row.key, "aria-selected": String(row.key === this.view.selected)}});
    li.append(el("span", {className: "stl-status-pill", text: t(`STL.Review.status.${status}`)}),
      el("span", {className: "stl-li-key", text: row.key.split(".").slice(1).join(".") || row.key}),
      el("span", {className: "stl-li-en", text: row.text}));
    return li;
  }

  #paintList() {
    const list = this.element.querySelector(".stl-list");
    const rows = this.#filtered();
    list.replaceChildren(...rows.map(row => this.#listItem(row)));
    if ( !rows.length ) list.append(el("li", {className: "stl-none", text: t("STL.Window.noMatch")}));
  }

  #refreshListRow(key) {
    const old = this.element.querySelector(`.stl-list li[data-key="${CSS.escape(key)}"]`);
    const row = this.rows.find(r => r.key === key);
    if ( old && row ) old.replaceWith(this.#listItem(row));
  }

  #select(key) {
    this.view.selected = key;
    for ( const li of this.element.querySelectorAll(".stl-list li[data-key]") ) li.setAttribute("aria-selected", String(li.dataset.key === key));
    this.#paintDetail();
  }

  /**
   * The hint and buttons of the selected text, and its outline wherever it shows.
   * @param {{pulse?: boolean}} [options]
   */
  #refreshWhere({pulse = false} = {}) {
    const pane = this.element?.querySelector(".stl-detail");
    const key = this.view.selected;
    const open = pane?.querySelector("[data-stl=open-window]");
    if ( !key || !open || !this.preview.mods.has(this.moduleId) ) {
      this.preview.clearMarks();
      return;
    }
    const state = this.preview.stateOf(this.moduleId, key, this.preview.visibleKeys(this.moduleId, [key]));
    const where = describeWhere(this.preview, this.moduleId, key, state);
    // the hint of a text on screen speaks of typing, which the review does not do
    pane.querySelector(".stl-state-text").textContent = (state === "live") ? "" : where.hint;
    open.hidden = !where.open;
    open.textContent = where.open ?? "";
    open.dataset.action = where.action ?? "window";
    const code = pane.querySelector("[data-stl=code]");
    if ( code ) code.hidden = !where.code;
    const places = this.preview.highlight(this.moduleId, key, {sticky: true, pulse}).count;
    pane.querySelector("[data-stl=show]").hidden = (state !== "live") || !places;
  }

  /** Select the next text without a verdict after a key, in the order of the list (wraps around). */
  #nextOpen(key) {
    const order = this.#filtered().map(r => r.key);
    const at = order.indexOf(key);
    for ( let step = 1; step < order.length; step++ ) {
      const next = order[(at + step) % order.length];
      if ( !this.review.items[next]?.verdict ) {
        this.#select(next);
        this.element.querySelector(`.stl-list li[data-key="${CSS.escape(next)}"]`)?.scrollIntoView({block: "nearest"});
        return next;
      }
    }
    return null;
  }

  #paintProgress() {
    const counts = reviewCounts(this.rows, this.review);
    this.element.querySelector(".stl-review-progress").textContent = t("STL.Review.progress", {done: counts.done, total: counts.all});
  }

  /** The pane of the selected text: English, German, submitted text, checks, verdict, suggestion and comment. */
  #paintDetail() {
    const pane = this.element.querySelector(".stl-detail");
    const row = this.rows.find(r => r.key === this.view.selected);
    if ( !row ) {
      pane.replaceChildren(el("p", {className: "stl-empty", text: t("STL.Review.pick")}));
      return;
    }
    const m = this.preview.mods.get(this.moduleId);
    const item = this.review.items[row.key] ?? null;
    const block = (label, text, className = "") => el("div", {className: `stl-block ${className}`.trim()},
      el("span", {className: "stl-label", text: label}), el("div", {className: "stl-text", text}));
    const nodes = [el("div", {className: "stl-keyhead"}, el("code", {className: "stl-key", text: row.key}))];
    nodes.push(block(t("STL.Detail.english"), row.en, "stl-en"));
    if ( m?.de.has(row.key) && (this.submission.lang !== "de") ) nodes.push(block(t("STL.Detail.german"), m.de.get(row.key), "stl-de"));
    nodes.push(block(t("STL.Review.submitted"), row.text, "stl-submitted"));
    const checks = el("ul", {className: "stl-checks"});
    for ( const e of row.errors ) checks.append(this.#checkItem("error", e));
    for ( const w of row.warnings ) checks.append(this.#checkItem("warning", w));
    if ( checks.children.length ) nodes.push(checks);
    const verdicts = el("div", {className: "stl-buttons stl-verdicts", attrs: {role: "group"}},
      el("button", {text: t("STL.Review.ok"), attrs: {type: "button", "data-verdict": "ok", "aria-pressed": String(item?.verdict === "ok")}}),
      el("button", {text: t("STL.Review.change"), attrs: {type: "button", "data-verdict": "change", "aria-pressed": String(item?.verdict === "change")}}),
      el("button", {text: t("STL.Detail.show"), attrs: {type: "button", "data-stl": "show"}}),
      el("button", {text: t("STL.Detail.openWindow"), attrs: {type: "button", "data-stl": "open-window", hidden: ""}}),
      el("button", {text: t("STL.Detail.code"), attrs: {type: "button", "data-stl": "code", hidden: ""}}));
    nodes.push(verdicts);
    nodes.push(el("div", {className: "stl-code", attrs: {hidden: ""}}));
    const suggestion = el("label", {className: "stl-label stl-yours", text: t("STL.Review.suggestion")});
    const area = el("textarea", {attrs: {name: "suggestion", rows: "3", lang: this.submission.lang, spellcheck: "true", maxlength: String(REVIEW_LIMITS.suggestion)}});
    area.value = item?.suggestion ?? "";
    suggestion.append(area);
    nodes.push(suggestion);
    const suggestionChecks = el("ul", {className: "stl-checks stl-suggestion-checks"});
    nodes.push(suggestionChecks);
    const comment = el("label", {className: "stl-label", text: t("STL.Review.comment")});
    const input = el("input", {attrs: {type: "text", name: "comment", maxlength: String(REVIEW_LIMITS.comment)}});
    input.value = item?.comment ?? "";
    comment.append(input);
    nodes.push(comment);
    const shown = el("p", {className: "stl-state-text"});
    nodes.push(shown);
    pane.replaceChildren(...nodes);
    this.#refreshWhere({pulse: true});

    const paintSuggestionChecks = () => {
      const result = checkSuggestion(row.en, area.value, this.submission.lang);
      suggestionChecks.replaceChildren(...result.errors.map(e => this.#checkItem("error", e)));
    };
    paintSuggestionChecks();
    verdicts.addEventListener("click", ev => {
      const button = ev.target.closest("button");
      if ( !button ) return;
      if ( button.dataset.stl === "show" ) {
        const result = this.preview.highlight(this.moduleId, row.key, {sticky: true, pulse: true, reveal: true});
        const place = this.preview.marked?.find(el => this.preview.isShownEl(el));
        if ( place ) placeBeside(place, this.element);
        shown.textContent = result.shown ? t("STL.State.shown", {count: result.shown}) : t("STL.State.notShown");
        return;
      }
      if ( button.dataset.stl === "code" ) {
        const box = pane.querySelector(".stl-code");
        if ( box.hidden ) renderCode(this.preview, this.moduleId, row.key, box);
        box.hidden = !box.hidden;
        button.textContent = t(box.hidden ? "STL.Detail.code" : "STL.Detail.codeHide");
        return;
      }
      if ( button.dataset.stl === "open-window" ) {
        openWhereShown(this.preview, this.moduleId, row.key, button, shown).then(found => {
          if ( this.view.selected !== row.key ) return;
          trace.add("openWindow", {module: this.moduleId, key: row.key, how: found.how, kind: found.kind ?? null});
          this.#refreshWhere();
          if ( found.how ) shown.textContent = found.message;
        });
        return;
      }
      this.setVerdict(row.key, button.dataset.verdict, {suggestion: area.value, comment: input.value});
      for ( const b of verdicts.querySelectorAll("[data-verdict]") ) b.setAttribute("aria-pressed", String(b.dataset.verdict === button.dataset.verdict));
      // OK needs nothing more: on to the next text that is not reviewed yet (Needs change stays for the suggestion)
      if ( button.dataset.verdict === "ok" ) this.#nextOpen(row.key);
    });
    const keep = () => {
      const current = this.review.items[row.key];
      // writing a suggestion or a comment marks the text as needing a change, unless it was marked otherwise
      this.setVerdict(row.key, current?.verdict ?? ((area.value.trim() || input.value.trim()) ? "change" : null),
        {suggestion: area.value, comment: input.value});
      for ( const b of verdicts.querySelectorAll("[data-verdict]") ) b.setAttribute("aria-pressed", String(b.dataset.verdict === this.review.items[row.key]?.verdict));
      paintSuggestionChecks();
    };
    area.addEventListener("input", keep);
    input.addEventListener("input", keep);
    area.addEventListener("keydown", ev => ev.stopPropagation());
    input.addEventListener("keydown", ev => ev.stopPropagation());
  }

  /** A check result like in the translator: the label of the check and its detail in the UI language. */
  #checkItem(kind, item) {
    const key = `STL.Check.${item.code}`;
    const detail = checkDetail(item, t("STL.CheckDetail.none"));
    const text = (detail && game.i18n.has(detail.key)) ? ` ${t(detail.key, detail.data)}` : "";
    return el("li", {className: `stl-check-${kind}`, attrs: {"data-code": item.code}},
      el("strong", {text: game.i18n.has(key) ? t(key) : item.code}), el("span", {className: "stl-detailtext", text}));
  }

  /**
   * Mark a text (also for macros and tests).
   * @param {string} key
   * @param {"ok"|"change"|null} verdict
   * @param {{suggestion?: string, comment?: string}} [extra]
   */
  setVerdict(key, verdict, {suggestion = "", comment = ""} = {}) {
    if ( !this.rows.some(r => r.key === key) ) return;
    if ( !verdict ) delete this.review.items[key];
    else this.review.items[key] = {verdict, suggestion: String(suggestion).slice(0, REVIEW_LIMITS.suggestion),
      comment: String(comment).slice(0, REVIEW_LIMITS.comment)};
    this.#refreshListRow(key);
    this.#paintFilters();
    this.#paintProgress();
    this.#saveSoon();
  }

  #saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#saveNow(), 600);
  }

  async #saveNow() {
    clearTimeout(this.saveTimer);
    if ( !this.submission ) return;
    this.review.saved = Date.now();
    await saveReview(reviewKey(this.submission), this.review);
  }

  /** The review file as built now. */
  file() {
    return this.submission ? buildReviewFile(this.submission, this.review, this.rows) : null;
  }

  /** Save the review file (for the translator, attached to the post in the review queue). */
  saveFile() {
    const file = this.file();
    if ( !file ) return null;
    const name = copyFileName(this.moduleId, file.lang, Date.now()).replace(/\.json$/, "-review.json");
    foundry.utils.saveDataToFile(`${JSON.stringify(file, null, 2)}\n`, "application/json", name);
    this.#report(t("STL.Review.saved", {file: name}));
    trace.add("reviewSaved", {result: file.result, change: file.counts.change});
    return name;
  }

  /** The short text for the post of this translation in the review queue. */
  message() {
    const file = this.file();
    if ( !file ) return "";
    // the post is read by people of every language: always English
    return reviewMessage(file, {
      head: tEnglish("STL.Review.msg.head", {module: this.module?.title ?? file.module, version: file.moduleVersion || "?", lang: file.lang,
        reviewer: file.reviewer || tEnglish("STL.Review.anonymousReviewer"), ok: file.counts.ok, change: file.counts.change, open: file.counts.open}),
      approved: tEnglish("STL.Review.msg.approved"), changes: tEnglish("STL.Review.msg.changes"), partial: tEnglish("STL.Review.msg.partial"),
      more: tEnglish("STL.Review.msg.more"), moreOne: tEnglish("STL.Review.msg.moreOne"), file: tEnglish("STL.Review.msg.file")
    });
  }

  async copyMessage() {
    const text = this.message();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    this.#report(ok ? t("STL.Review.copied") : t("STL.Review.copyByHand"), ok ? null : text);
    return ok;
  }

  #report(line, text = null) {
    const box = this.element?.querySelector(".stl-report");
    if ( !box ) return;
    box.replaceChildren(el("p", {text: line}));
    if ( text ) {
      const area = el("textarea", {attrs: {rows: "5", readonly: ""}});
      area.value = text;
      box.append(area);
      area.select();
    }
    box.hidden = false;
  }
}

/**
 * Open the review of a submission file (parsed JSON). The translator window closes first, both use the live preview.
 * @param {object} data
 * @returns {Promise<ReviewApp>}
 */
export async function openReview(data) {
  await runtime.translator?.close();
  await runtime.review?.close();
  return new ReviewApp({data}).render({force: true});
}
