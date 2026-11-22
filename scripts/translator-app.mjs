/**
 * The translator window: pick a module and a language, translate key by key and see every change in the real windows
 * of the module at once. The window is drawn once; typing only touches the row, the checks and the preview, so focus and
 * cursor stay where they are. All foreign text (English, German, drafts, imports) is set with textContent or .value.
 */

import {MODULE_ID, TEMPLATES, addSettingsGear, setting, t} from "./config.mjs";
import {runtime, trace} from "./debug.mjs";
import {listModules, needsText, progressOf, readLangFile, shipsLang, unavailableModules} from "./modules.mjs";
import {LivePreview} from "./preview.mjs";
import {loadDraft, readDrafts, readShared, readUse, saveDraft, saveShared, saveUse} from "./store.mjs";
import {SubmitApp} from "./submit-app.mjs";
import {restingTexts} from "./use.mjs";
import {describeWhere, openWhereShown, placeBeside, renderCode} from "./where.mjs";
import {openReview} from "./review-app.mjs";
import {isReviewFile, notesFromReview} from "./review-logic.mjs";
import {LIMITS, OTHER_LANGUAGE, STATUSES, acceptEnglish, languageChoices, analyzeRow, changedSince, checkDetail, draftKey, memoryFor, memoryKey, nextTodoKey, sameEnglishOpen, countPlaceholders, coverage, emptyDraft, exportFile, filterRows,
  groupOf, insertAt, isSubmission, lastSent, lengthInfo, normalizeLang, parseImport, previewText, sanitizeDraft, setDraftText,
  statusCounts, usableTexts, useModeOf} from "./translator-logic.mjs";
import {flatten, placeholders} from "./translate-checks.mjs";

const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

/** Create an element. */
function el(tag, {className = "", text = null, attrs = {}} = {}, ...children) {
  const node = document.createElement(tag);
  if ( className ) node.className = className;
  if ( text !== null ) node.textContent = text;
  for ( const [name, value] of Object.entries(attrs) ) node.setAttribute(name, value);
  for ( const child of children ) if ( child ) node.append(child);
  return node;
}

/** Codes Foundry modules use that Intl names under another code. */
const NAME_AS = {cn: "zh-Hans", "zh-TW": "zh-Hant"};

/**
 * The name of a language in a language (Intl), capitalised, or "" when the browser does not know the code.
 * @param {string} code
 * @param {string} inLang
 * @returns {string}
 */
function languageName(code, inLang) {
  try {
    const locale = NAME_AS[inLang] ?? inLang;
    const name = new Intl.DisplayNames([locale], {type: "language", fallback: "none"}).of(NAME_AS[code] ?? code);
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : "";
  } catch {
    return "";
  }
}

/**
 * Events a click on a text sends, swallowed while picking so the click only picks. The pick itself happens on pointerup:
 * a disabled button gets no click event, but pointer events.
 */
const PICK_SWALLOW = ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu"];

export class TranslatorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} [options]
   * @param {string} [options.module]   Module id to start with
   * @param {string} [options.lang]     Language code to start with
   */
  constructor({module = null, lang = null, ...options} = {}) {
    super({...options, id: "stl-translator"});
    this.start = {module, lang};
    this.preview = new LivePreview();
    this.view = {moduleId: null, lang: null, status: "all", group: "", query: "", selected: null};
    this.modules = [];
    this.draft = emptyDraft();
    this.rows = new Map();
    this.order = [];
    this.langMessage = "";
    this.visible = new Set();
    this.progress = new Map();
    this.queue = Promise.resolve();
    this.ready = null;
    this.saveTimer = null;
    this.poll = null;
    this.hookId = null;
    this.reportLine = null;
  }

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["stl-app", "stl-translator"],
    window: {icon: "fa-solid fa-language", resizable: true},
    position: {width: Math.min(1100, Math.max(320, window.innerWidth - 40)), height: Math.min(720, Math.max(320, window.innerHeight - 70))}
  };

  /** @override */
  static PARTS = {main: {template: `${TEMPLATES}/translator.hbs`}};

  /** @override */
  get title() {
    return t("STL.Title");
  }

  /** The row of the selected key. */
  get selectedRow() {
    return this.rows.get(this.view.selected) ?? null;
  }

  /** The module record of the current module. */
  get module() {
    return this.modules.find(m => m.id === this.view.moduleId) ?? null;
  }

  /** @override */
  async _prepareContext() {
    const keys = ["module", "language", "langPlaceholder", "filters", "search", "group", "keys", "pick", "import", "export", "submit", "use", "review",
      "pickScreen", "reviewHint", "importHint", "exportHint", "submitHint", "langTitle", "langOtherLabel", "samples", "samplesHint"];
    return {text: Object.fromEntries(keys.map(key => [key, t(`STL.Window.${key}`)]))};
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
    runtime.translator = this;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    root.dataset.stlSelf = "1";
    root.dataset.stlTheme = setting("theme");
    if ( !this.ready ) {
      this.#wire();
      this.ready = this.#enqueue(() => this.#begin());
    }
    else this.#enqueue(() => this.#paintAll());
  }

  /** @override */
  async _onClose(options) {
    clearTimeout(this.saveTimer);
    clearInterval(this.poll);
    if ( this.hookId !== null ) Hooks.off("clientSettingChanged", this.hookId);
    try {
      await this.#saveNow();
      await this.#shareNow();
      // a translation in use stays when the window lets go, the rest goes back to what Foundry showed
      this.#stopPick();
      for ( const [id, m] of this.preview.mods ) this.preview.adopt(id, restingTexts(id, m.en, m.base));
      await this.preview.restoreAll();
      this.preview.clearMarks();
    } finally {
      if ( runtime.translator === this ) runtime.translator = null;
    }
    await super._onClose?.(options);
  }

  /** Run steps one after the other, so a module switch never overlaps with the next. */
  #enqueue(fn) {
    this.queue = this.queue.then(fn).catch(err => console.error(`${MODULE_ID} |`, err));
    return this.queue;
  }

  /* -------------------------------------------- */
  /*  Start and switching                         */
  /* -------------------------------------------- */

  async #begin() {
    this.modules = listModules();
    // installed modules Foundry leaves out of this world: named in the module list, with what they need
    unavailableModules().then(list => {
      this.unavailable = list;
      if ( this.rendered ) this.#paintTop();
    });
    const wanted = this.start.module;
    const moduleId = this.modules.some(m => m.id === wanted) ? wanted : (this.modules.find(m => m.id !== MODULE_ID) ?? this.modules[0])?.id;
    const guess = normalizeLang(this.start.lang ?? game.i18n.lang);
    const lang = (guess && guess !== "en") ? guess : null;
    // A module that follows its own language setting reloads its file: apply the draft again
    this.hookId = Hooks.on("clientSettingChanged", key => {
      if ( typeof key === "string" && key.startsWith("sephrals-") && key.endsWith(".uiLanguage") ) {
        for ( const delay of [300, 1500] ) setTimeout(() => this.#reapply(), delay);
      }
    });
    this.poll = setInterval(() => this.#reapply(), 1500);
    this.#paintAll();
    this.#loadProgress(lang);
    if ( moduleId && lang ) await this.#open(moduleId, lang);
    else {
      this.view.moduleId = moduleId ?? null;
      this.view.lang = null;
      this.langMessage = lang ? "" : t("STL.Message.pickLanguage");
      this.#paintAll();
    }
  }

  async #reapply() {
    if ( !this.view.moduleId || !this.rendered ) return;
    try {
      const done = await this.preview.reapply(this.view.moduleId);
      if ( done ) trace.add("reapplied", {module: this.view.moduleId});
      // a window drawn again (or opened by hand) loses the outline of the selected text: put it back
      if ( this.selectedRow && !this.preview.marksAlive() ) this.#autoMark();
    } catch(err) {
      console.warn(`${MODULE_ID} | reapply failed`, err);
    }
  }

  /** Progress of every module in the language, for the picker. */
  async #loadProgress(lang) {
    if ( !lang ) return;
    await Promise.all(this.modules.map(async m => {
      try {
        const progress = await progressOf(m.id, lang);
        if ( progress ) this.progress.set(m.id, progress);
      } catch {
        /* a module without a readable file simply has no number */
      }
    }));
    if ( this.rendered ) this.#paintTop();
  }

  /**
   * Open a module in a language: restore the previous preview, read the files, load or preload the draft, apply it.
   * @param {string} moduleId
   * @param {string} lang
   */
  async #open(moduleId, lang) {
    await this.#saveNow();
    this.#stopPick();
    this.preview.clearMarks();
    if ( this.view.moduleId ) {
      await this.#shareNow();
      const old = this.preview.mods.get(this.view.moduleId);
      if ( old ) this.preview.adopt(this.view.moduleId, restingTexts(this.view.moduleId, old.en, old.base));
      await this.preview.restore(this.view.moduleId);
    }
    this.view.moduleId = moduleId;
    this.view.lang = lang;
    this.view.selected = null;
    this.view.group = "";
    this.langMessage = "";
    this.visible = new Set();
    const m = await this.preview.load(moduleId);
    let draft = loadDraft(moduleId, lang, m.en);
    let preloaded = 0;
    if ( !draft || !Object.keys(draft.texts).length ) {
      draft ??= emptyDraft();
      if ( shipsLang(moduleId, lang) ) {
        const shipped = parseImport(JSON.stringify((await readLangFile(moduleId, lang)) ?? {}), m.enObj, lang);
        if ( shipped.ok ) {
          for ( const [key, text] of shipped.accepted ) setDraftText(draft, key, m.en.get(key), text);
          preloaded = shipped.accepted.size;
        }
      }
    }
    this.draft = sanitizeDraft(draft, m.en);
    this.#computeRows();
    this.#applyAll();
    this.#paintAll();
    this.reportLine = preloaded ? t("STL.Report.preloaded", {count: preloaded}) : null;
    this.#paintReport();
    trace.add("open", {module: moduleId, lang, keys: this.rows.size, preloaded});
    // learn where the files of the module mention the keys (reads only, nothing changes on screen)
    this.preview.index(moduleId).then(() => this.#refreshState());
    // which texts the sample windows of the module show, learned unseen in the background
    this.preview.learnSamples(moduleId).then(() => {
      if ( this.view.moduleId === moduleId ) this.#refreshState();
    });
    this.#loadProgress(lang);
    this.wasComplete = coverage([...this.rows.values()]).percent >= 100;
    // earlier translations of the same English texts in the other modules (read in the background)
    if ( this.memory?.lang !== lang ) this.#loadMemory(lang);
  }

  /* -------------------------------------------- */
  /*  Rows                                        */
  /* -------------------------------------------- */

  #computeRows() {
    const m = this.preview.mods.get(this.view.moduleId);
    this.rows = new Map();
    for ( const [key, en] of m.en ) this.rows.set(key, analyzeRow(key, en, this.draft.texts[key] ?? "", this.draft, this.view.lang));
    this.order = [...m.en.keys()];
  }

  #updateRow(key) {
    const m = this.preview.mods.get(this.view.moduleId);
    const row = analyzeRow(key, m.en.get(key), this.draft.texts[key] ?? "", this.draft, this.view.lang);
    this.rows.set(key, row);
    return row;
  }

  /** The preview shows the draft: every translated key, the English text for the others. */
  #applyAll() {
    const m = this.preview.mods.get(this.view.moduleId);
    const texts = new Map();
    for ( const row of this.rows.values() ) if ( row.text.trim() ) texts.set(row.key, previewText(row));
    const changed = this.preview.set(this.view.moduleId, texts);
    if ( changed.length ) this.preview.refresh(this.view.moduleId, {keys: changed, scoped: false}).then(() => this.#refreshState());
    return changed.length && m ? changed : [];
  }

  /* -------------------------------------------- */
  /*  Painting                                    */
  /* -------------------------------------------- */

  #wire() {
    const root = this.element;
    const q = sel => root.querySelector(sel);
    q("[name=module]").addEventListener("change", ev => {
      const id = ev.target.value;
      if ( this.view.lang ) this.#enqueue(() => this.#open(id, this.view.lang));
      else {
        this.view.moduleId = id;
        this.#paintAll();
      }
    });
    // the language: a list of languages, and a field for a code under "Other language"
    q("[name=lang]").addEventListener("change", ev => {
      const other = q("[name=langOther]");
      if ( ev.target.value === OTHER_LANGUAGE ) {
        other.hidden = false;
        other.value = "";
        other.focus();
        return;
      }
      other.hidden = true;
      this.#setLang(ev.target.value);
    });
    q("[name=langOther]").addEventListener("change", ev => this.#setLang(ev.target.value, {typed: true}));
    // a sample window of the module: its windows with made-up data, nothing saved
    // a dropdown of the translator in use: the learning in the background waits, nothing it draws can close it
    root.addEventListener("focusin", ev => {
      if ( (ev.target.tagName === "SELECT") && !this.selectHold ) this.selectHold = this.preview.holdLearning();
    });
    root.addEventListener("focusout", ev => {
      if ( ev.target.tagName !== "SELECT" ) return;
      this.selectHold?.();
      this.selectHold = null;
    });
    q("[name=sample]").addEventListener("change", ev => {
      const id = ev.target.value;
      ev.target.value = "";
      if ( id ) this.openSample(id);
    });
    q("[name=langOther]").addEventListener("keydown", ev => {
      ev.stopPropagation();
      if ( ev.key === "Enter" ) {
        ev.preventDefault();
        this.#setLang(ev.target.value, {typed: true});
      }
      else if ( ev.key === "Escape" ) {
        ev.preventDefault();
        ev.target.hidden = true;
        q("[name=lang]").value = this.view.lang ?? "";
      }
    });
    q("[name=query]").addEventListener("input", ev => {
      this.view.query = ev.target.value;
      this.#paintList();
    });
    q("[name=group]").addEventListener("change", ev => {
      this.view.group = ev.target.value;
      this.#paintList();
    });
    q(".stl-filters").addEventListener("click", ev => {
      const button = ev.target.closest("button[data-status]");
      if ( !button ) return;
      this.view.status = button.dataset.status;
      this.#paintFilters();
      this.#paintList();
    });
    q(".stl-list").addEventListener("click", ev => {
      const li = ev.target.closest("li[data-key]");
      if ( li ) this.#select(li.dataset.key);
    });
    q(".stl-list").addEventListener("keydown", ev => {
      if ( ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter" ) return;
      const items = [...q(".stl-list").querySelectorAll("li[data-key]")];
      const index = items.findIndex(li => li.dataset.key === this.view.selected);
      if ( ev.key === "Enter" ) {
        q("[name=text]")?.focus();
      }
      else {
        const next = items[Math.max(0, Math.min(items.length - 1, index + (ev.key === "ArrowDown" ? 1 : -1)))];
        if ( next ) {
          this.#select(next.dataset.key);
          next.scrollIntoView({block: "nearest"});
        }
      }
      ev.preventDefault();
    });
    q("[data-stl=pick]").addEventListener("click", () => this.togglePick());
    q("[data-stl=import]").addEventListener("click", () => q("[name=file]").click());
    q("[name=file]").addEventListener("change", async ev => {
      const [file] = ev.target.files;
      ev.target.value = "";
      if ( file ) await this.#importFile(file);
    });
    q("[data-stl=review]").addEventListener("click", () => q("[name=reviewFile]").click());
    q("[name=reviewFile]").addEventListener("change", async ev => {
      const [file] = ev.target.files;
      ev.target.value = "";
      if ( file ) await this.#openReviewFile(file);
    });
    q("[data-stl=export]").addEventListener("click", () => this.exportDraft());
    q("[data-stl=submit]").addEventListener("click", () => this.openSubmit());
    q("[name=use]").addEventListener("change", ev => this.#enqueue(() => this.#setUse(ev.target.value)));
    root.addEventListener("dragover", ev => {
      if ( [...(ev.dataTransfer?.types ?? [])].includes("Files") ) ev.preventDefault();
    });
    root.addEventListener("drop", async ev => {
      const [file] = ev.dataTransfer?.files ?? [];
      if ( !file ) return;
      ev.preventDefault();
      await this.#importFile(file);
    });
  }

  /**
   * Switch to a language from the picker or the "Other language" field.
   * @param {string} value
   * @param {{typed?: boolean}} [options]   typed: from the field, which stays open while the code is refused
   */
  #setLang(value, {typed = false} = {}) {
    const lang = normalizeLang(value);
    const other = this.element.querySelector("[name=langOther]");
    if ( !lang || (lang === "en") ) {
      this.langMessage = t(lang === "en" ? "STL.Message.notEnglish" : "STL.Message.badLanguage");
      if ( !typed ) this.element.querySelector("[name=lang]").value = this.view.lang ?? "";
      this.#paintTop();
      return;
    }
    other.hidden = true;
    this.langMessage = "";
    if ( lang === this.view.lang ) {
      this.#paintTop();
      return;
    }
    const id = this.view.moduleId ?? this.modules[0]?.id;
    if ( id ) this.#enqueue(async () => {
      await this.#open(id, lang);
      this.#loadProgress(lang);
    });
  }

  /** The options of the language picker, built again only when the module, the language or the progress change. */
  #paintLanguages() {
    const select = this.element.querySelector("[name=lang]");
    const shipped = [...(game.modules.get(this.view.moduleId)?.languages ?? [])].map(l => l.lang);
    const stamp = [this.view.moduleId, this.view.lang, game.i18n.lang, shipped.join(",")].join("|");
    if ( (this.langStamp !== stamp) || (select.options.length < 2) ) {
      this.langStamp = stamp;
      const choices = languageChoices({extra: [...Object.keys(CONFIG.supportedLanguages ?? {}), game.i18n.lang, ...shipped],
        current: this.view.lang, shipped, nameOf: code => ({local: languageName(code, game.i18n.lang), native: languageName(code, code)})});
      select.replaceChildren(el("option", {text: t("STL.Window.langPick"), attrs: {value: "", disabled: ""}}),
        ...choices.map(c => el("option", {text: c.shipped ? `${c.label} ✓` : c.label, attrs: {value: c.code}})),
        el("option", {text: t("STL.Window.langOther"), attrs: {value: OTHER_LANGUAGE}}));
    }
    if ( document.activeElement !== select ) select.value = this.view.lang ?? "";
  }

  /** The sample windows of the module in the header, grouped; hidden when the module has none. */
  #paintSamples() {
    const field = this.element.querySelector(".stl-field-samples");
    const select = field?.querySelector("[name=sample]");
    if ( !select ) return;
    const list = this.view.moduleId ? this.preview.samples(this.view.moduleId) : [];
    field.hidden = !list.length;
    // labels too: a translated label shows in the field while one types
    const stamp = [this.view.moduleId, game.i18n.lang, list.map(e => `${e.id}:${e.group}:${e.label}`).join(",")].join("|");
    // never rebuilt while it is open in the user's hand (the dropdown would close)
    if ( (this.sampleStamp === stamp) || (document.activeElement === select) ) return;
    this.sampleStamp = stamp;
    const groups = new Map();
    for ( const entry of list ) {
      if ( !groups.has(entry.group) ) groups.set(entry.group, []);
      groups.get(entry.group).push(el("option", {text: entry.label, attrs: {value: entry.id}}));
    }
    select.replaceChildren(el("option", {text: t("STL.Window.samplesPick"), attrs: {value: ""}}),
      ...[...groups].map(([group, options]) => (group ? el("optgroup", {attrs: {label: group}}, ...options) : options)).flat());
    select.value = "";
  }

  /**
   * Open a sample window of the current module next to the translator and outline the selected text in it.
   * @param {string} id   the id of the sample (api.samples of the module)
   * @returns {Promise<boolean>}
   */
  async openSample(id) {
    const moduleId = this.view.moduleId;
    const entry = this.preview.samples(moduleId).find(e => e.id === id);
    if ( !entry ) return false;
    let app = null;
    // the learning in the background may finish the window it looks at first: say that something happens
    this.reportFor = null;
    this.reportLine = t("STL.Samples.opening", {name: entry.label});
    this.#paintReport();
    try {
      // the learning in the background waits meanwhile (it would open the same window unseen)
      await this.preview.exclusive(async () => {
        const keys = await this.preview.record(async () => {
          // a sample that waits for its window to close must not hold the translator
          app = await Promise.race([Promise.resolve().then(() => entry.open()), new Promise(resolve => setTimeout(resolve, 8000))]);
        });
        this.preview.noteSample(moduleId, id, keys);
      });
    } catch(err) {
      console.warn(`sephrals-translator | the sample window ${id} of ${moduleId} failed`, err);
    }
    const frame = app?.element instanceof HTMLElement ? app.element : app?.element?.[0];
    trace.add("sample", {module: moduleId, sample: id, opened: !!frame});
    // the line goes with the next text picked (a key no row has)
    this.reportFor = `sample:${id}`;
    this.reportLine = frame ? t("STL.Samples.opened", {name: entry.label}) : t("STL.Samples.failed");
    this.#paintReport();
    if ( !frame ) return false;
    placeBeside(frame, this.element);
    await this.preview.usageByRender(moduleId);
    if ( this.view.moduleId !== moduleId ) return true;
    const row = this.selectedRow;
    if ( row ) this.preview.highlight(moduleId, row.key, {sticky: true, pulse: true, reveal: true});
    this.#refreshState();
    return true;
  }

  #paintAll() {
    if ( !this.rendered ) return;
    this.#paintTop();
    this.#paintFilters();
    this.#paintList();
    this.#paintDetail();
    this.#paintReport();
    this.#paintSaved();
    this.#paintUse();
  }

  #paintTop() {
    const root = this.element;
    const select = root.querySelector("[name=module]");
    const keep = this.view.moduleId;
    select.replaceChildren(...this.modules.map(m => {
      const progress = this.progress.get(m.id);
      let label = progress ? `${m.title} (${progress.percent}%)` : m.title;
      // a module that cannot run here: translatable, not visible
      if ( m.needs ) label += ` · ${t("STL.Needs.short", {needs: needsText(m.needs, t)})}`;
      return el("option", {text: label, attrs: {value: m.id, ...(m.id === keep ? {selected: ""} : {})}});
    }));
    if ( this.unavailable?.length ) {
      select.append(el("optgroup", {attrs: {label: t("STL.Needs.elsewhere")}}, ...this.unavailable.map(m => el("option", {
        text: `${m.title} · ${t("STL.Needs.short", {needs: needsText(m.needs, t)})}`, attrs: {value: `unavailable:${m.id}`, disabled: ""}
      }))));
    }
    select.value = keep ?? "";
    this.#paintLanguages();
    this.#paintSamples();
    const message = root.querySelector(".stl-langmsg");
    message.textContent = this.langMessage;
    message.hidden = !this.langMessage;
    const needs = root.querySelector(".stl-needs");
    const mod = this.module;
    needs.textContent = mod?.needs ? t("STL.Needs.notice", {module: mod.title, needs: needsText(mod.needs, t)}) : "";
    needs.hidden = !mod?.needs;
    const cov = coverage([...this.rows.values()]);
    root.querySelector(".stl-bar span").style.width = `${cov.percent}%`;
    root.querySelector(".stl-progress-text").textContent = this.view.lang
      ? t("STL.Window.progress", {done: cov.translatedWords, total: cov.words, percent: cov.percent}) : "";
    if ( this.view.moduleId && this.rows.size ) this.progress.set(this.view.moduleId, cov);
  }

  #paintFilters() {
    const box = this.element.querySelector(".stl-filters");
    const counts = statusCounts([...this.rows.values()]);
    const sent = lastSent(this.draft);
    if ( sent ) counts.since = changedSince(sent, this.allRows()).size;
    else if ( this.view.status === "since" ) this.view.status = "all";
    // notes of a reviewer, imported from a review file
    counts.notes = Object.keys(this.draft.notes ?? {}).length;
    if ( !counts.notes && (this.view.status === "notes") ) this.view.status = "all";
    box.replaceChildren(...["all", ...STATUSES, ...(sent ? ["since"] : []), ...(counts.notes ? ["notes"] : [])].map(status => el("button", {
      className: "stl-chip", text: `${t(`STL.Status.${status}`)} ${counts[status]}`,
      attrs: {type: "button", "data-status": status, "aria-pressed": String(this.view.status === status)}
    })));
    // the groups of the module for the picker
    const select = this.element.querySelector("[name=group]");
    const groups = [...new Set(this.order.map(groupOf))].sort();
    select.replaceChildren(el("option", {text: t("STL.Window.allGroups"), attrs: {value: ""}}),
      ...groups.map(g => el("option", {text: g || t("STL.Window.noGroup"), attrs: {value: g || "__none__"}})));
    select.value = this.view.group;
  }

  #filtered() {
    const m = this.preview.mods.get(this.view.moduleId);
    const rows = this.order.map(key => this.rows.get(key)).filter(Boolean);
    const group = this.view.group === "__none__" ? "" : this.view.group;
    const since = this.view.status === "since" ? changedSince(lastSent(this.draft), rows) : null;
    const notes = this.view.status === "notes" ? new Set(Object.keys(this.draft.notes ?? {})) : null;
    const special = since ?? notes;
    let list = filterRows(rows, {status: special ? "all" : this.view.status, query: this.view.query, de: m?.de});
    if ( special ) list = list.filter(row => special.has(row.key));
    return this.view.group ? list.filter(row => row.group === group) : list;
  }

  #paintList() {
    const list = this.element.querySelector(".stl-list");
    const rows = this.#filtered();
    list.replaceChildren(...rows.map(row => this.#listItem(row)));
    if ( !rows.length ) list.append(el("li", {className: "stl-none", text: t("STL.Window.noMatch")}));
  }

  #listItem(row) {
    const note = this.draft.notes?.[row.key];
    const li = el("li", {attrs: {role: "option", "data-key": row.key, "data-status": row.status, title: row.key,
      "aria-selected": String(row.key === this.view.selected), ...(note ? {"data-note": note.verdict} : {})}});
    li.append(el("span", {className: "stl-status-pill", text: t(`STL.Status.${row.status}`)}),
      el("span", {className: "stl-li-key", text: row.key.split(".").slice(1).join(".") || row.key}),
      el("span", {className: "stl-li-en", text: row.en}));
    return li;
  }

  /** The row of the list for a key changed its status or text. */
  #refreshListRow(key) {
    const old = this.element.querySelector(`.stl-list li[data-key="${CSS.escape(key)}"]`);
    if ( !old ) return;
    const fresh = this.#listItem(this.rows.get(key));
    old.replaceWith(fresh);
  }

  #select(key) {
    // a report about the text picked before (several matches, filled texts) goes with that selection
    if ( this.reportFor && (this.reportFor !== key) ) {
      this.reportFor = null;
      this.reportLine = null;
      this.#paintReport();
    }
    this.view.selected = key;
    for ( const li of this.element.querySelectorAll(".stl-list li[data-key]") ) li.setAttribute("aria-selected", String(li.dataset.key === key));
    this.#paintDetail();
    this.#refreshState({pulse: true});
  }

  /** The detail pane for the selected key: built once per selection, typing only updates parts of it. */
  #paintDetail() {
    const pane = this.element.querySelector(".stl-detail");
    const row = this.selectedRow;
    const m = this.preview.mods.get(this.view.moduleId);
    if ( !row || !m ) {
      if ( !this.view.lang || !m ) {
        pane.replaceChildren(el("p", {className: "stl-empty", text: this.view.lang ? t("STL.Window.pick") : t("STL.Message.pickLanguage")}));
        return;
      }
      // the short way through, while no text is picked
      pane.replaceChildren(el("div", {className: "stl-empty stl-guide"}, el("p", {text: t("STL.Guide.head")}),
        el("ol", {}, ...["pick", "type", "next", "submit"].map(step => el("li", {text: t(`STL.Guide.${step}`)})))));
      return;
    }
    const block = (label, text, className = "") => el("div", {className: `stl-block ${className}`.trim()},
      el("span", {className: "stl-label", text: label}), el("div", {className: "stl-text", text}));
    const nodes = [];
    nodes.push(el("div", {className: "stl-keyhead"}, el("code", {className: "stl-key", text: row.key}),
      el("span", {className: "stl-meta", text: row.group ? t("STL.Detail.group", {group: row.group}) : ""}),
      el("span", {className: "stl-meta", text: t("STL.Detail.recommended", {count: [...row.en].length})})));
    nodes.push(block(t("STL.Detail.english"), row.en, "stl-en"));
    const old = this.draft.base[row.key];
    const changedBox = el("div", {className: "stl-changed", attrs: {hidden: ""}});
    changedBox.append(el("p", {className: "stl-label", text: t("STL.Detail.englishChanged")}),
      el("div", {className: "stl-two"}, block(t("STL.Detail.oldEnglish"), old ?? "", "stl-old"), block(t("STL.Detail.newEnglish"), row.en, "stl-new")),
      el("button", {text: t("STL.Detail.keepTranslation"), attrs: {type: "button", "data-stl": "accept"}}));
    nodes.push(changedBox);
    if ( m.de.has(row.key) && this.view.lang !== "de" ) nodes.push(block(t("STL.Detail.german"), m.de.get(row.key), "stl-de"));
    // what the last submission said, when it differs: to see and improve an earlier submission
    const sent = lastSent(this.draft);
    const sentBox = block(sent ? t("STL.Detail.sent", {date: new Date(sent.at).toLocaleString([], {dateStyle: "medium", timeStyle: "short"})}) : "",
      sent?.texts[row.key] ?? t("STL.Detail.notSent"), "stl-sent");
    sentBox.hidden = true;
    nodes.push(sentBox);
    // what a reviewer wrote about this text: take the suggestion or mark the note done
    const note = this.draft.notes?.[row.key];
    let noteBox = null;
    if ( note ) {
      noteBox = el("div", {className: "stl-note", attrs: {"data-verdict": note.verdict}},
        el("span", {className: "stl-label", text: t(`STL.Detail.note.${note.verdict}`, {name: note.reviewer || t("STL.Review.anonymousReviewer")})}),
        note.suggestion ? el("div", {className: "stl-text stl-note-suggestion", text: note.suggestion}) : null,
        note.comment ? el("p", {className: "stl-note-comment", text: note.comment}) : null,
        el("div", {className: "stl-buttons"},
          note.suggestion ? el("button", {text: t("STL.Detail.note.take"), attrs: {type: "button", "data-stl": "take-note"}}) : null,
          el("button", {text: t("STL.Detail.note.done"), attrs: {type: "button", "data-stl": "done-note"}})));
      nodes.push(noteBox);
    }
    const field = el("label", {className: "stl-label stl-yours", text: t("STL.Detail.yours")});
    const area = el("textarea", {attrs: {name: "text", rows: "4", lang: this.view.lang, spellcheck: "true", "aria-label": t("STL.Detail.yours")}});
    area.value = this.draft.texts[row.key] ?? "";
    field.append(area);
    nodes.push(field);
    const chips = el("div", {className: "stl-chips", attrs: {role: "group", "aria-label": t("STL.Detail.placeholders")}});
    for ( const holder of placeholders(row.en) ) {
      chips.append(el("button", {className: "stl-chip stl-holder", text: holder, attrs: {type: "button", "data-holder": holder,
        title: t("STL.Detail.insert", {name: holder})}}));
    }
    if ( chips.children.length ) nodes.push(chips);
    nodes.push(el("div", {className: "stl-memory", attrs: {hidden: ""}}));
    nodes.push(el("div", {className: "stl-next"},
      el("button", {attrs: {type: "button", "data-stl": "next"}}, el("i", {className: "fa-solid fa-forward", attrs: {inert: ""}}),
        document.createTextNode(` ${t("STL.Detail.next")}`)),
      el("span", {className: "stl-kbd", text: t("STL.Detail.nextKeys")})));
    const review = el("label", {className: "stl-checkline"}, el("input", {attrs: {type: "checkbox", name: "review"}}),
      el("span", {text: t("STL.Detail.markCheck")}));
    review.querySelector("input").checked = !!this.draft.review[row.key];
    nodes.push(review);
    nodes.push(el("ul", {className: "stl-checks", attrs: {"aria-label": t("STL.Detail.checks")}}));
    nodes.push(el("div", {className: "stl-hints"}));
    const previewBox = el("div", {className: "stl-preview"});
    previewBox.append(el("span", {className: "stl-label", text: t("STL.Detail.preview")}),
      el("span", {className: "stl-state", attrs: {"data-state": "open"}}),
      el("p", {className: "stl-state-text"}),
      el("div", {className: "stl-buttons"},
        el("button", {text: t("STL.Detail.show"), attrs: {type: "button", "data-stl": "show"}}),
        el("button", {text: t("STL.Detail.openWindow"), attrs: {type: "button", "data-stl": "open-window", hidden: ""}}),
        el("button", {text: t("STL.Detail.code"), attrs: {type: "button", "data-stl": "code", hidden: ""}})),
      el("div", {className: "stl-code", attrs: {hidden: ""}}));
    nodes.push(previewBox);
    pane.replaceChildren(...nodes);

    area.addEventListener("input", () => this.#typed(area));
    area.addEventListener("keydown", ev => {
      ev.stopPropagation();
      // Ctrl+Enter: on to the next text that still wants work; Alt+arrows: the next or previous text of the list
      if ( (ev.key === "Enter") && (ev.ctrlKey || ev.metaKey) ) {
        ev.preventDefault();
        this.goNext();
      }
      else if ( ev.altKey && ((ev.key === "ArrowDown") || (ev.key === "ArrowUp")) ) {
        ev.preventDefault();
        this.#step(ev.key === "ArrowDown" ? 1 : -1);
      }
    });
    pane.querySelector("[data-stl=next]").addEventListener("click", () => this.goNext());
    pane.querySelector(".stl-memory").addEventListener("click", ev => {
      const button = ev.target.closest("button");
      if ( !button ) return;
      if ( button.dataset.stl === "fill-same" ) this.#fillSame(row.key);
      else if ( button.dataset.take !== undefined ) {
        area.value = button.dataset.take;
        this.#typed(area);
        area.focus();
      }
    });
    this.#paintMemory();
    chips.addEventListener("click", ev => {
      const chip = ev.target.closest("button[data-holder]");
      if ( !chip ) return;
      const out = insertAt(area.value, area.selectionStart, area.selectionEnd, chip.dataset.holder);
      area.value = out.value;
      area.focus();
      area.setSelectionRange(out.cursor, out.cursor);
      this.#typed(area);
    });
    review.querySelector("input").addEventListener("change", ev => {
      if ( ev.target.checked ) this.draft.review[row.key] = true;
      else delete this.draft.review[row.key];
      this.#updateRow(row.key);
      this.#refreshListRow(row.key);
      this.#paintFilters();
      this.#updateChecks();
      this.#saveSoon();
    });
    pane.querySelector("[data-stl=accept]").addEventListener("click", () => {
      acceptEnglish(this.draft, row.key, row.en);
      this.#updateRow(row.key);
      this.#refreshListRow(row.key);
      this.#paintFilters();
      this.#updateChecks();
      this.#saveSoon();
    });
    pane.querySelector("[data-stl=show]").addEventListener("click", () => this.#show());
    pane.querySelector("[data-stl=open-window]").addEventListener("click", () => this.#openWindow());
    pane.querySelector("[data-stl=code]").addEventListener("click", ev => {
      const box = pane.querySelector(".stl-code");
      if ( box.hidden ) renderCode(this.preview, this.view.moduleId, row.key, box);
      box.hidden = !box.hidden;
      ev.currentTarget.textContent = t(box.hidden ? "STL.Detail.code" : "STL.Detail.codeHide");
    });
    noteBox?.addEventListener("click", ev => {
      const action = ev.target.closest("button[data-stl]")?.dataset.stl;
      if ( action === "take-note" ) {
        area.value = note.suggestion;
        this.#typed(area);
      }
      if ( action === "done-note" ) {
        delete this.draft.notes[row.key];
        this.#refreshListRow(row.key);
        this.#paintFilters();
        this.#paintDetail();
        this.#saveSoon();
      }
    });
    this.#updateChecks();
  }

  /** The checks, hints and the status of the selected key. */
  #updateChecks() {
    const row = this.selectedRow;
    const pane = this.element.querySelector(".stl-detail");
    if ( !row || !pane.querySelector(".stl-checks") ) return;
    const sent = lastSent(this.draft);
    const sentBox = pane.querySelector(".stl-sent");
    if ( sentBox ) sentBox.hidden = !sent || ((sent.texts[row.key] ?? "") === (row.translated ? row.text.normalize("NFC") : ""));
    const list = pane.querySelector(".stl-checks");
    const items = [];
    const text = row.text.trim() ? row : null;
    if ( !text ) items.push(el("li", {className: "stl-check-info", text: t("STL.Detail.nothingYet")}));
    else {
      for ( const e of row.errors ) items.push(this.#checkItem("error", e));
      for ( const w of row.warnings ) items.push(this.#checkItem("warning", w));
      if ( !row.errors.length && !row.warnings.length ) items.push(el("li", {className: "stl-check-ok", text: t("STL.Detail.allGood")}));
      if ( row.blocked ) items.push(el("li", {className: "stl-check-info", text: t("STL.Detail.notInPreview")}));
    }
    list.replaceChildren(...items);
    const info = lengthInfo(row.en, row.text);
    const hints = pane.querySelector(".stl-hints");
    const lines = [el("span", {className: info.ratio > 1.6 ? "stl-hint stl-hint-warn" : "stl-hint",
      text: t("STL.Hint.length", {length: info.length, recommended: info.recommended})})];
    if ( countPlaceholders(row.en).length ) lines.push(el("span", {className: "stl-hint", text: t("STL.Hint.plural")}));
    hints.replaceChildren(...lines);
    const changedBox = pane.querySelector(".stl-changed");
    changedBox.hidden = row.status !== "changed";
    pane.dataset.status = row.status;
  }

  #checkItem(kind, item) {
    const key = `STL.Check.${item.code}`;
    const label = game.i18n.has(key) ? t(key) : item.code;
    const detail = checkDetail(item, t("STL.CheckDetail.none"));
    const text = (detail && game.i18n.has(detail.key)) ? ` ${t(detail.key, detail.data)}` : "";
    return el("li", {className: `stl-check-${kind}`, attrs: {"data-code": item.code}},
      el("strong", {text: label}), el("span", {className: "stl-detailtext", text}));
  }

  #paintReport() {
    const box = this.element?.querySelector(".stl-report");
    if ( !box ) return;
    box.replaceChildren();
    if ( !this.reportLine ) {
      box.hidden = true;
      return;
    }
    if ( typeof this.reportLine === "string" ) box.append(el("p", {text: this.reportLine}));
    else {
      box.append(el("p", {text: this.reportLine.head}));
      if ( this.reportLine.items?.length ) box.append(el("ul", {}, ...this.reportLine.items.slice(0, 8).map(text => el("li", {text}))));
    }
    box.hidden = false;
  }

  #paintSaved() {
    const box = this.element?.querySelector(".stl-saved");
    if ( !box ) return;
    box.textContent = this.draft.saved ? t("STL.Window.saved", {time: new Date(this.draft.saved).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}) : "";
  }

  /* -------------------------------------------- */
  /*  Using the translation outside the window    */
  /* -------------------------------------------- */

  /** The mode of the current module and language: preview, me or world. */
  get useMode() {
    const {moduleId, lang} = this.view;
    return (moduleId && lang) ? useModeOf(moduleId, lang, readUse(), readShared()) : "preview";
  }

  #paintUse() {
    const select = this.element?.querySelector("[name=use]");
    if ( !select ) return;
    const mode = this.useMode;
    const gm = game.user.isGM;
    const modes = ["preview", "me", ...((gm || (mode === "world")) ? ["world"] : [])];
    select.replaceChildren(...modes.map(value => el("option", {text: t(`STL.Use.${value}`),
      attrs: {value, ...(((value === "world") && !gm) ? {disabled: ""} : {})}})));
    select.value = mode;
    select.disabled = !(this.view.moduleId && this.view.lang);
    select.title = t(`STL.Use.${(mode === "world") && !gm ? "worldByGM" : `${mode}Hint`}`);
  }

  /**
   * Choose where the translation is used: only in the window, always in this browser, or for everybody (GM).
   * @param {"preview"|"me"|"world"} mode
   */
  async #setUse(mode) {
    const {moduleId: id, lang} = this.view;
    if ( !id || !lang || !["preview", "me", "world"].includes(mode) ) return;
    const gm = game.user.isGM;
    if ( (mode === "world") && !gm ) return this.#paintUse();
    const use = readUse();
    const shared = readShared();
    let worldChanged = false;
    if ( mode === "me" ) use[id] = lang;
    else if ( (mode === "world") || (use[id] === lang) ) delete use[id];
    if ( gm && (mode === "world") ) {
      shared[id] = this.#sharedEntry();
      worldChanged = true;
    }
    else if ( gm && (shared[id]?.lang === lang) ) {
      delete shared[id];
      worldChanged = true;
    }
    await saveUse(use);
    if ( worldChanged ) await saveShared(shared);
    trace.add("use", {module: id, lang, mode});
    const now = this.useMode;
    this.reportLine = t(((now === "world") && !gm) ? "STL.Use.worldByGM" : `STL.Use.${now}Hint`);
    this.#paintReport();
    this.#paintUse();
  }

  /** The copy of the translation a GM shares: the texts without errors. */
  #sharedEntry() {
    const m = this.preview.mods.get(this.view.moduleId);
    return {lang: this.view.lang, texts: Object.fromEntries(usableTexts(this.draft.texts, m.en, this.view.lang)), at: Date.now()};
  }

  /** Keep the shared copy in step with the draft (GM, mode world): when the window closes or switches. */
  async #shareNow() {
    const {moduleId: id, lang} = this.view;
    if ( !game.user.isGM || !id || !lang || !this.preview.mods.has(id) ) return;
    const shared = readShared();
    if ( shared[id]?.lang !== lang ) return;
    const entry = this.#sharedEntry();
    if ( JSON.stringify(entry.texts) === JSON.stringify(shared[id].texts) ) return;
    shared[id] = entry;
    await saveShared(shared);
    trace.add("shared", {module: id, lang, keys: Object.keys(entry.texts).length});
  }

  /** The submit dialog changed the earlier submissions: the filter and the pane compare with the newest. */
  historyChanged() {
    if ( !this.rendered ) return;
    this.#paintFilters();
    this.#paintList();
    this.#paintDetail();
    this.#refreshState();
  }

  /* -------------------------------------------- */
  /*  Typing and the preview                      */
  /* -------------------------------------------- */

  /** A key was typed in: draft, row, checks, preview. */
  #typed(area) {
    const key = this.view.selected;
    const m = this.preview.mods.get(this.view.moduleId);
    if ( !key || !m ) return;
    setDraftText(this.draft, key, m.en.get(key), area.value);
    const before = this.rows.get(key).status;
    const row = this.#updateRow(key);
    if ( before !== row.status ) {
      this.#refreshListRow(key);
      this.#paintFilters();
    }
    else {
      const li = this.element.querySelector(`.stl-list li[data-key="${CSS.escape(key)}"] .stl-li-en`);
      if ( li ) li.textContent = row.en;
    }
    this.#updateChecks();
    this.#paintTop();
    this.#paintMemory();
    this.#noteComplete();
    this.#saveSoon();
    const changed = this.preview.set(this.view.moduleId, new Map([[key, previewText(row)]]));
    if ( changed.length ) this.preview.schedule(this.view.moduleId, changed).then(() => this.#refreshState());
    else this.#refreshState();
  }

  /**
   * Update the badge of the selected key (Live, open to see, after reload), its hint and its buttons, and outline the
   * text wherever it shows.
   * @param {{pulse?: boolean}} [options]   pulse: draw the eye to the outline (a new selection)
   */
  #refreshState({pulse = false} = {}) {
    const row = this.selectedRow;
    const pane = this.element?.querySelector(".stl-detail");
    const badge = pane?.querySelector(".stl-state");
    if ( !row || !badge ) {
      this.preview.clearMarks();
      return;
    }
    const id = this.view.moduleId;
    if ( !this.preview.mods.has(id) ) return;
    const visible = this.preview.visibleKeys(id, [row.key]);
    const state = this.preview.stateOf(id, row.key, visible);
    // a key that is not on screen: learn once which open windows look it up (draws the open windows of the module)
    const mod = this.preview.mods.get(id);
    if ( (state === "open") && (mod.usage === null) && !mod.usageBusy ) {
      mod.usageBusy = true;
      this.preview.usageByRender(id).finally(() => {
        mod.usageBusy = false;
        if ( this.preview.mods.get(id) === mod ) this.#refreshState();
      });
    }
    badge.dataset.state = state;
    badge.textContent = t(`STL.State.${state}`);
    const where = describeWhere(this.preview, id, row.key, state);
    pane.querySelector(".stl-state-text").textContent = where.hint;
    const open = pane.querySelector("[data-stl=open-window]");
    open.hidden = !where.open;
    open.textContent = where.open ?? "";
    open.dataset.action = where.action ?? "window";
    const code = pane.querySelector("[data-stl=code]");
    code.hidden = !where.code;
    if ( !where.code ) pane.querySelector(".stl-code").hidden = true;
    // a button only where it can do something: Show for a text with a place on screen, Open for one a window or the settings show
    const places = this.#autoMark({pulse});
    pane.querySelector("[data-stl=show]").hidden = (state !== "live") || !places;
  }

  /**
   * Outline the selected text wherever it shows (stays while it is selected and follows the windows drawn again).
   * @returns {number}   the places found
   */
  #autoMark({pulse = false} = {}) {
    const row = this.selectedRow;
    if ( !row || !this.preview.mods.has(this.view.moduleId) ) {
      this.preview.clearMarks();
      return 0;
    }
    return this.preview.highlight(this.view.moduleId, row.key, {sticky: true, pulse}).count;
  }

  /* -------------------------------------------- */
  /*  Moving through the texts                    */
  /* -------------------------------------------- */

  /**
   * Select a key and make sure the list shows it (a filter or search that hides it is reset), then put the cursor into
   * the translation field.
   * @param {string} key
   */
  #goTo(key) {
    if ( !this.#filtered().some(row => row.key === key) ) {
      this.view.status = "all";
      this.view.query = "";
      this.view.group = "";
      this.element.querySelector("[name=query]").value = "";
      this.#paintFilters();
      this.#paintList();
    }
    this.#select(key);
    this.element.querySelector(`.stl-list li[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({block: "nearest"});
    this.element.querySelector(".stl-detail [name=text]")?.focus();
  }

  /**
   * On to the next text that still wants work (open, error, English changed, marked to check), in the order of the list.
   * @param {number} [dir]   1 forward, -1 backward
   * @returns {string|null}  the key now selected
   */
  goNext(dir = 1) {
    const order = this.#filtered().map(row => row.key);
    const next = nextTodoKey(order, this.rows, this.view.selected, dir) ?? nextTodoKey(this.order, this.rows, this.view.selected, dir);
    if ( !next ) {
      this.reportLine = t("STL.Report.nothingLeft");
      this.#paintReport();
      return null;
    }
    this.#goTo(next);
    return next;
  }

  /** The next or previous text of the list, whatever its status. */
  #step(dir) {
    const order = this.#filtered().map(row => row.key);
    const at = order.indexOf(this.view.selected);
    const key = order[Math.max(0, Math.min(order.length - 1, at + dir))];
    if ( key && (key !== this.view.selected) ) this.#goTo(key);
  }

  /** Say once when every text of the module is translated. */
  #noteComplete() {
    const complete = coverage([...this.rows.values()]).percent >= 100;
    if ( complete && !this.wasComplete ) {
      this.reportLine = t("STL.Report.allDone");
      this.#paintReport();
    }
    this.wasComplete = complete;
  }

  /* -------------------------------------------- */
  /*  Earlier translations of the same English    */
  /* -------------------------------------------- */

  /**
   * Read what people already translated in the language: the drafts of this browser and the files the modules ship.
   * @param {string} lang
   */
  async #loadMemory(lang) {
    const map = new Map();
    const drafts = readDrafts();
    await Promise.all(this.modules.map(async mod => {
      try {
        const en = await readLangFile(mod.id, "en");
        if ( !en ) return;
        const english = flatten(en);
        const draft = drafts[draftKey(mod.id, lang)]?.texts ?? {};
        const add = (key, text) => {
          const source = english.get(key);
          if ( !source || (typeof text !== "string") || !text.trim() || (text === source) ) return;
          const k = memoryKey(source);
          if ( !map.has(k) ) map.set(k, []);
          map.get(k).push({text, where: mod.title, moduleId: mod.id});
        };
        if ( shipsLang(mod.id, lang) ) {
          const shipped = await readLangFile(mod.id, lang);
          if ( shipped ) for ( const [key, text] of flatten(shipped) ) if ( !(key in draft) ) add(key, text);
        }
        for ( const [key, text] of Object.entries(draft) ) add(key, text);
      } catch {
        /* a module whose files cannot be read adds nothing */
      }
    }));
    this.memory = {lang, map};
    if ( this.rendered && (this.view.lang === lang) ) this.#paintMemory();
  }

  /** Translations for the selected text: other texts of this module (live) and the memory of the other modules. */
  #memoryFor(row) {
    const key = memoryKey(row.en);
    const list = (this.memory?.lang === this.view.lang) ? (this.memory.map.get(key) ?? []).filter(e => e.moduleId !== this.view.moduleId) : [];
    const here = t("STL.Memory.thisModule");
    for ( const [k, other] of this.rows ) {
      const text = this.draft.texts[k];
      if ( (k !== row.key) && text?.trim() && (other.status !== "error") && (memoryKey(other.en) === key) ) list.push({text, where: here});
    }
    return memoryFor(new Map([[key, list]]), row.en, {own: this.draft.texts[row.key] ?? ""});
  }

  /** The box under the field: earlier translations to take, and the offer to fill the same English elsewhere. */
  #paintMemory() {
    const box = this.element?.querySelector(".stl-detail .stl-memory");
    const row = this.selectedRow;
    if ( !box || !row ) return;
    const items = this.#memoryFor(row);
    const own = this.draft.texts[row.key] ?? "";
    const same = (own.trim() && (row.status !== "error")) ? sameEnglishOpen(this.rows, row.key) : [];
    const nodes = [];
    if ( items.length ) {
      nodes.push(el("span", {className: "stl-label", text: t("STL.Memory.title")}));
      for ( const item of items ) {
        nodes.push(el("div", {className: "stl-memory-item"},
          el("span", {className: "stl-memory-text", text: item.text}),
          el("span", {className: "stl-meta", text: item.where.join(", "), attrs: {title: item.where.join(", ")}}),
          el("button", {text: t("STL.Memory.take"), attrs: {type: "button", "data-take": item.text}})));
      }
    }
    if ( same.length ) {
      nodes.push(el("div", {className: "stl-memory-item"},
        el("span", {className: "stl-memory-text", text: t("STL.Memory.same", {count: same.length})}),
        el("button", {text: t("STL.Memory.fill"), attrs: {type: "button", "data-stl": "fill-same"}})));
    }
    box.replaceChildren(...nodes);
    box.hidden = !nodes.length;
  }

  /** Give the other texts with the same English and no translation yet the text of this one. */
  #fillSame(key) {
    const m = this.preview.mods.get(this.view.moduleId);
    const text = this.draft.texts[key] ?? "";
    const keys = sameEnglishOpen(this.rows, key);
    if ( !m || !text.trim() || !keys.length ) return;
    const texts = new Map();
    for ( const k of keys ) {
      setDraftText(this.draft, k, m.en.get(k), text);
      texts.set(k, previewText(this.#updateRow(k)));
      this.#refreshListRow(k);
    }
    this.#paintFilters();
    this.#paintTop();
    this.#paintMemory();
    this.#noteComplete();
    this.#saveSoon();
    const changed = this.preview.set(this.view.moduleId, texts);
    if ( changed.length ) this.preview.schedule(this.view.moduleId, changed).then(() => this.#refreshState());
    this.reportLine = t("STL.Report.filled", {count: keys.length});
    this.reportFor = key;
    this.#paintReport();
    trace.add("fillSame", {key, count: keys.length});
  }

  /* -------------------------------------------- */
  /*  Picking a text on screen                    */
  /* -------------------------------------------- */

  /** Start or stop picking: the next click on a text in Foundry selects it in the list. Escape stops. */
  togglePick() {
    if ( this.picking ) {
      this.#stopPick();
      this.reportLine = null;
      this.#paintReport();
      return;
    }
    if ( !this.view.moduleId || !this.preview.mods.has(this.view.moduleId) ) return;
    this.picking = true;
    this.element.querySelector("[data-stl=pick]")?.setAttribute("aria-pressed", "true");
    document.body.classList.add("stl-picking");
    this.reportLine = t("STL.Pick.start", {module: game.modules.get(this.view.moduleId)?.title ?? this.view.moduleId});
    this.#paintReport();
    const outside = ev => (ev.target instanceof Element) && !ev.target.closest("[data-stl-self]");
    const over = ev => {
      for ( const node of document.querySelectorAll(".stl-pick-hover") ) node.classList.remove("stl-pick-hover");
      if ( outside(ev) ) ev.target.classList.add("stl-pick-hover");
    };
    // the click on a text must not also press the button or open the sheet it sits on
    const swallow = ev => {
      if ( !outside(ev) ) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };
    const pick = ev => {
      if ( !outside(ev) || (ev.button !== 0) ) return;
      swallow(ev);
      const target = ev.target;
      this.#stopPick();
      this.#pickFrom(target);
    };
    const key = ev => {
      if ( ev.key !== "Escape" ) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.#stopPick();
      this.reportLine = null;
      this.#paintReport();
    };
    this.pickHandlers = {over, swallow, pick, key};
    document.addEventListener("mouseover", over, true);
    for ( const type of PICK_SWALLOW ) document.addEventListener(type, swallow, true);
    document.addEventListener("pointerup", pick, true);
    window.addEventListener("keydown", key, true);
    trace.add("pick", {module: this.view.moduleId});
  }

  #stopPick() {
    if ( !this.picking ) return;
    this.picking = false;
    const {over, swallow, pick, key} = this.pickHandlers ?? {};
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("pointerup", pick, true);
    window.removeEventListener("keydown", key, true);
    // the mouseup and click that follow the picking pointerup are still swallowed, then the page works as before
    setTimeout(() => {
      for ( const type of PICK_SWALLOW ) document.removeEventListener(type, swallow, true);
    }, 150);
    this.pickHandlers = null;
    document.body.classList.remove("stl-picking");
    for ( const node of document.querySelectorAll(".stl-pick-hover") ) node.classList.remove("stl-pick-hover");
    this.element?.querySelector("[data-stl=pick]")?.setAttribute("aria-pressed", "false");
  }

  /**
   * Select the text an element shows (also for macros and tests).
   * @param {HTMLElement} target
   * @returns {Promise<string[]>}   the keys that show this text, the first one is selected
   */
  pickFrom(target) {
    return this.#pickFrom(target);
  }

  async #pickFrom(target) {
    const id = this.view.moduleId;
    let keys = this.preview.keysAt(id, target);
    if ( keys.length > 1 ) {
      // the same words in several texts: the one the window around the click looked up comes first
      const appId = target.closest(".application, .app")?.id ?? null;
      await this.preview.usageByRender(id);
      keys = this.preview.rankByWindow(id, keys, appId);
    }
    if ( !keys.length ) {
      this.reportLine = t("STL.Pick.none", {module: game.modules.get(id)?.title ?? id});
      this.#paintReport();
      return keys;
    }
    this.#goTo(keys[0]);
    this.reportLine = (keys.length > 1) ? t("STL.Pick.several", {count: keys.length}) : null;
    this.reportFor = this.reportLine ? keys[0] : null;
    this.#paintReport();
    return keys;
  }


  #show() {
    const row = this.selectedRow;
    if ( !row ) return;
    const result = this.preview.highlight(this.view.moduleId, row.key, {sticky: true, pulse: true, reveal: true});
    const place = this.preview.marked?.find(el => this.preview.isShownEl(el));
    if ( place ) placeBeside(place, this.element);
    const text = this.element.querySelector(".stl-state-text");
    text.textContent = result.shown ? t("STL.State.shown", {count: result.shown}) : t("STL.State.notShown");
  }

  async #openWindow() {
    const id = this.view.moduleId;
    const row = this.selectedRow;
    const pane = this.element?.querySelector(".stl-detail");
    const button = pane?.querySelector("[data-stl=open-window]");
    if ( !row || !button ) return;
    const found = await openWhereShown(this.preview, id, row.key, button, pane.querySelector(".stl-state-text"));
    if ( (this.view.moduleId !== id) || (this.selectedRow?.key !== row.key) ) return;
    trace.add("openWindow", {module: id, key: row.key, how: found.how, kind: found.kind ?? null});
    const text = found.message;
    this.#refreshState();
    if ( found.how ) pane.querySelector(".stl-state-text").textContent = text;
  }

  /* -------------------------------------------- */
  /*  Saving, export, import                      */
  /* -------------------------------------------- */

  #saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#saveNow(), 700);
  }

  async #saveNow() {
    clearTimeout(this.saveTimer);
    if ( !this.view.moduleId || !this.view.lang || !this.preview.mods.has(this.view.moduleId) ) return;
    await saveDraft(this.view.moduleId, this.view.lang, this.draft);
    this.#paintSaved();
  }

  /**
   * Switch to another module or language while the window is open.
   * @param {{module?: string, lang?: string}} options
   */
  async switchTo({module = null, lang = null} = {}) {
    await this.ready;
    const id = this.modules.some(m => m.id === module) ? module : this.view.moduleId;
    const code = normalizeLang(lang) ?? this.view.lang;
    if ( !id || !code || (code === "en") || ((id === this.view.moduleId) && (code === this.view.lang)) ) return;
    await this.#enqueue(() => this.#open(id, code));
  }

  /** Save the draft at once (also for the tests and the submit dialog). */
  save() {
    return this.#saveNow();
  }

  /** The rows as an array, in the order of the file. */
  allRows() {
    return this.order.map(key => this.rows.get(key)).filter(Boolean);
  }

  /** Download lang/<code>.json with the translated keys. */
  exportDraft() {
    const m = this.preview.mods.get(this.view.moduleId);
    if ( !m || !this.view.lang ) return null;
    const out = exportFile(m.enObj, this.allRows());
    foundry.utils.saveDataToFile(out.text, "application/json", `${this.view.lang}.json`);
    this.reportLine = {head: t("STL.Report.exported", {count: out.keys, file: `${this.view.lang}.json`}),
      items: out.skipped.length ? [t("STL.Report.skipped", {count: out.skipped.length}), ...out.skipped.slice(0, 5)] : []};
    this.#paintReport();
    trace.add("export", {module: this.view.moduleId, lang: this.view.lang, keys: out.keys});
    return out;
  }

  /**
   * Take a file in as a draft (checked like a hostile input).
   * @param {File} file
   */
  async #importFile(file) {
    if ( !this.view.lang ) {
      ui.notifications.warn(t("STL.Message.pickLanguage"));
      return;
    }
    let text = "";
    try {
      text = await file.text();
    } catch {
      text = null;
    }
    return this.importText(text);
  }

  /**
   * Import the text of a language file into the draft.
   * @param {string} text
   * @returns {object}   The result of the check
   */
  importText(text) {
    const m = this.preview.mods.get(this.view.moduleId);
    if ( !m || !this.view.lang ) return null;
    // a review file of a reviewer: its notes go next to the texts
    let data = null;
    try {
      data = (typeof text === "string") && (text.length <= LIMITS.file) ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if ( isReviewFile(data) ) return this.#importReview(data);
    const result = parseImport(text, m.enObj, this.view.lang, this.view.moduleId);
    if ( !result.ok ) {
      this.reportLine = t(`STL.Report.reject.${result.reason}`);
      this.#paintReport();
      return result;
    }
    for ( const [key, value] of result.accepted ) setDraftText(this.draft, key, m.en.get(key), value);
    this.#computeRows();
    this.#applyAll();
    this.#paintAll();
    this.#saveSoon();
    const items = result.rejected.map(r => `${r.key}: ${r.codes.map(c => (game.i18n.has(`STL.Check.${c}`) ? t(`STL.Check.${c}`) : c)).join(", ")}`);
    if ( result.unknown.length ) items.push(t("STL.Report.unknown", {count: result.unknown.length}));
    if ( result.skipped.length || result.nonStrings.length ) items.push(t("STL.Report.skippedOther", {count: result.skipped.length + result.nonStrings.length}));
    this.reportLine = {head: t("STL.Report.imported", {accepted: result.accepted.size, rejected: result.rejected.length}), items};
    this.#paintReport();
    trace.add("import", {accepted: result.accepted.size, rejected: result.rejected.length});
    return result;
  }

  /**
   * Take the notes of a review file into the draft (only this module and language, suggestions without errors).
   * @param {object} data
   * @returns {object}
   */
  #importReview(data) {
    const m = this.preview.mods.get(this.view.moduleId);
    const result = notesFromReview(data, m.en, this.view.moduleId, this.view.lang);
    if ( !result.ok ) {
      this.reportLine = t(`STL.Report.reject.${result.reason}`);
      this.#paintReport();
      return result;
    }
    this.draft.notes = {...(this.draft.notes ?? {}), ...result.notes};
    this.view.status = result.counts.notes ? "notes" : this.view.status;
    this.#paintAll();
    this.#saveSoon();
    this.reportLine = t("STL.Report.reviewImported", {count: result.counts.notes, change: result.counts.change,
      reviewer: result.reviewer || t("STL.Review.anonymousReviewer")});
    this.#paintReport();
    trace.add("reviewImported", {notes: result.counts.notes});
    return result;
  }

  /**
   * Open a submission file for a review (button Review...).
   * @param {File} file
   */
  async #openReviewFile(file) {
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    if ( !isSubmission(data) ) {
      this.reportLine = t("STL.Review.reject.not-submission");
      this.#paintReport();
      return null;
    }
    return openReview(data);
  }

  /** Open the submit dialog. */
  async openSubmit() {
    const m = this.preview.mods.get(this.view.moduleId);
    if ( !m || !this.view.lang ) {
      ui.notifications.warn(t("STL.Message.pickLanguage"));
      return null;
    }
    await this.#saveNow();
    return new SubmitApp({translator: this}).render({force: true});
  }

  /** A readable summary of the state, for the self test, the debug file and tests. */
  describe() {
    const rows = this.allRows();
    return {module: this.view.moduleId, lang: this.view.lang, selected: this.view.selected, counts: statusCounts(rows),
      coverage: coverage(rows), touched: this.preview.mods.get(this.view.moduleId)?.touched.size ?? 0, use: this.useMode,
      submissions: this.draft.history.length};
  }
}
