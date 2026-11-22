/**
 * The live preview: texts of the translator go into Foundry's translations of this client (nothing is saved, nothing is
 * sent), then only the windows that show the old text are drawn again. Built on the spike of 2026-11-21
 * (tmp/translator-spike/preview.js), with its fixes: window titles after a render, setting fields that cache their
 * label, the scene controls, chat messages, a patch of the page for what no render rebuilds, a debounce, and a Proxy
 * that records which keys a render looks up.
 *
 * The translator's own windows are never drawn again (focus and cursor stay in the field).
 */

import {flatten, safeMergeTranslations} from "./translate-checks.mjs";
import {REFRESH_HOOK, drawsOnCanvas, listensToRefresh, refreshPayload} from "./translator-logic.mjs";

/** Selector of the elements that belong to the translator itself. */
export const SELF = "[data-stl-self]";

/** Debounce after the last keystroke, in ms. */
const DEBOUNCE = 200;

/** Files whose texts are resolved once at start or by hand: keys used only there change after a reload. */
const STARTUP_FILES = /(^|\/)(selftest|debug|usage|hub|migration|language|canvas|layers?|labels?|pins?)[\w.-]*$/i;

/** Part of STARTUP_FILES that a module redraws on the refresh hook when it announces it (canvas drawings). */
const REDRAWN_FILES = /(^|\/)(canvas|layers?|labels?|pins?)[\w.-]*$/i;

const escapeRx = s => s.replace(/[.*+?^$(){}|[\]\\]/g, c => `\\${c}`);

/** Open applications, ApplicationV2 and V1. */
function openApps() {
  const list = [];
  for ( const app of foundry.applications.instances.values() ) list.push({app, v: 2});
  for ( const app of Object.values(globalThis.ui?.windows ?? {}) ) list.push({app, v: 1});
  return list;
}

const elementOf = app => (app.element instanceof HTMLElement ? app.element : app.element?.[0]);

/** Is this application one of the translator's own windows? */
const isSelf = app => String(app.id).startsWith("stl-") || !!elementOf(app)?.matches?.(SELF);

export class LivePreview {
  /** @type {Map<string, object>} per module id */
  mods = new Map();

  /** While learning: another window was drawn during the recording. */
  #mixed = false;

  /** Searches running now (the learning waits for them). */
  #searching = 0;

  /** The window the learning looks at right now (a search waits for it). */
  #learnStep = null;

  /** A learning step runs: new sample windows are hidden. */
  #learningNow = false;

  /** While a search runs: puts each window it opens in its place (beside the translator), before its tabs are walked. */
  #placeOpened = null;

  timers = new Map();

  pending = new Map();

  /** Called after a refresh with (moduleId, report). */
  onRefresh = null;

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /**
   * Read the English file of a module (and its German file for orientation) and keep a snapshot of the strings Foundry
   * loaded. Nothing changes on screen.
   * @param {string} moduleId
   * @returns {Promise<object>}
   */
  async load(moduleId) {
    if ( this.mods.has(moduleId) ) return this.mods.get(moduleId);
    const mod = game.modules.get(moduleId);
    const entries = [...(mod?.languages ?? [])];
    const read = async lang => {
      const entry = entries.find(l => l.lang === lang);
      if ( !entry ) return null;
      try {
        const response = await fetch(entry.path);
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const enObj = await read("en");
    if ( !enObj ) throw new Error(`${moduleId}: no English file`);
    const deObj = await read("de");
    const en = flatten(enObj);
    // The namespaces: first parts of the keys (a file may also write flat keys like "SCLS.App.Title" at its top)
    const roots = [...new Set([...en.keys()].map(k => k.split(".")[0]))].filter(k => !k.startsWith("_DRAFT"));
    const snapshot = {};
    for ( const root of roots ) snapshot[root] = foundry.utils.deepClone(game.i18n.translations[root] ?? {});
    // What is on screen now: the text Foundry resolves today (the user's language), else the English text
    const base = new Map();
    for ( const [key, value] of en ) {
      const shown = foundry.utils.getProperty(game.i18n.translations, key);
      base.set(key, typeof shown === "string" ? shown : value);
    }
    const state = {
      id: moduleId, enObj, deObj, en, de: deObj ? flatten(deObj) : new Map(), roots, snapshot,
      current: new Map(base), shown: new Map(base), base, history: new Map(), touched: new Set(), tracked: {},
      usage: null, index: null, live: new Set()
    };
    this.mods.set(moduleId, state);
    return state;
  }

  /**
   * Put texts into the client translations. An empty text shows the English one, like an untranslated key.
   * Only the keys that change are written. Returns the changed keys.
   * @param {string} moduleId
   * @param {Map<string, string>|object} texts   key to text to show
   * @returns {string[]}
   */
  set(moduleId, texts) {
    const m = this.mods.get(moduleId);
    const entries = texts instanceof Map ? [...texts] : Object.entries(texts);
    const write = new Map();
    for ( const [key, text] of entries ) {
      if ( !m.en.has(key) ) continue;
      const value = (text === "" || text == null) ? m.en.get(key) : text;
      if ( m.current.get(key) === value ) continue;
      const history = m.history.get(key) ?? [];
      history.push(m.current.get(key));
      if ( history.length > 6 ) history.shift();
      m.history.set(key, history);
      m.current.set(key, value);
      m.touched.add(key);
      write.set(key, value);
    }
    return safeMergeTranslations(game.i18n.translations, m.roots, write);
  }

  /**
   * Restore Foundry's original strings of a module, also in the page that shows the preview.
   * @param {string} moduleId
   * @param {{refresh?: boolean}} [options]
   */
  async restore(moduleId, {refresh = true} = {}) {
    const m = this.mods.get(moduleId);
    if ( !m ) return;
    clearTimeout(this.timers.get(moduleId));
    const keys = [...m.touched];
    if ( keys.length ) {
      this.set(moduleId, new Map(keys.map(k => [k, m.base.get(k)])));
      this.patchDom(moduleId, keys);
    }
    for ( const root of m.roots ) game.i18n.translations[root] = foundry.utils.deepClone(m.snapshot[root] ?? {});
    const hadKeys = keys.length > 0;
    m.current = new Map(m.base);
    m.shown = new Map(m.base);
    m.history.clear();
    m.touched.clear();
    m.tracked = {};
    if ( refresh && hadKeys ) await this.refresh(moduleId, {keys: null, scoped: false, patch: false});
    this.mods.delete(moduleId);
  }

  /**
   * Texts that stay when the window lets go of a module (a translation in use): they become the strings that the
   * restore puts back, in the translations and in the page.
   * @param {string} moduleId
   * @param {Map<string, string>} texts
   */
  adopt(moduleId, texts) {
    const m = this.mods.get(moduleId);
    if ( !m ) return;
    const write = new Map();
    for ( const [key, text] of texts ) {
      if ( !m.en.has(key) || (typeof text !== "string") ) continue;
      m.base.set(key, text);
      m.touched.add(key);
      write.set(key, text);
    }
    safeMergeTranslations(m.snapshot, m.roots, write);
  }

  /** Restore every module. */
  async restoreAll() {
    for ( const id of [...this.mods.keys()] ) await this.restore(id);
  }

  /**
   * The module reloaded its own language file (the user changed its language setting) and overwrote the preview:
   * keep the new clean strings as the snapshot and put the preview on top again.
   * @param {string} moduleId
   * @returns {Promise<boolean>}   true when something had to be applied again
   */
  async reapply(moduleId) {
    const m = this.mods.get(moduleId);
    if ( !m || !m.touched.size ) return false;
    const overwritten = [...m.touched].some(key => foundry.utils.getProperty(game.i18n.translations, key) !== m.current.get(key));
    if ( !overwritten ) return false;
    for ( const root of m.roots ) m.snapshot[root] = foundry.utils.deepClone(game.i18n.translations[root] ?? {});
    for ( const [key, value] of m.en ) {
      const shown = foundry.utils.getProperty(game.i18n.translations, key);
      m.base.set(key, typeof shown === "string" ? shown : value);
    }
    const write = new Map([...m.touched].map(key => [key, m.current.get(key)]));
    safeMergeTranslations(game.i18n.translations, m.roots, write);
    m.shown = new Map(m.base);
    for ( const key of m.touched ) m.shown.set(key, m.base.get(key));
    await this.refresh(moduleId, {keys: [...m.touched], scoped: false});
    return true;
  }

  /* -------------------------------------------- */
  /*  Which windows show module strings           */
  /* -------------------------------------------- */

  /** Texts long enough to be found in the page, without placeholders or markup. */
  valuesOf(moduleId) {
    const m = this.mods.get(moduleId);
    m.values ??= [...m.base.values()].filter(v => v.length >= 6 && !/[{<]/.test(v));
    return [...m.values, ...[...m.touched].map(k => m.current.get(k)).filter(v => v.length >= 6 && !/[{<]/.test(v))];
  }

  /** Does the window belong to the module (by id or class, else by the texts it shows)? */
  belongs(app, moduleId) {
    const el = elementOf(app);
    if ( !el ) return false;
    const ns = this.mods.get(moduleId).roots.map(r => r.toLowerCase());
    const id = String(app.id).toLowerCase();
    if ( id.includes(moduleId) || ns.some(n => id.startsWith(n)) ) return true;
    if ( [...el.classList].some(c => c.includes(moduleId) || ns.some(n => c.toLowerCase().startsWith(n))) ) return true;
    const hay = `${el.textContent} ${[...el.querySelectorAll("[data-tooltip],[title],[placeholder],[aria-label]")]
      .map(e => [e.dataset.tooltip, e.title, e.placeholder, e.ariaLabel].join(" ")).join(" ")}`;
    return this.valuesOf(moduleId).some(v => hay.includes(v));
  }

  /* -------------------------------------------- */
  /*  Refresh                                     */
  /* -------------------------------------------- */

  /**
   * Draw again what shows the module's strings. Returns a report with timings.
   * @param {string} moduleId
   * @param {object} [options]
   * @param {string[]|null} [options.keys]   The changed keys (a scoped refresh looks only for their old texts)
   * @param {boolean} [options.patch]        Also patch the page in place for what no render rebuilds
   * @param {boolean} [options.scoped]
   */
  async refresh(moduleId, {keys = null, patch = true, scoped = true} = {}) {
    const m = this.mods.get(moduleId);
    if ( !m ) return null;
    const t0 = performance.now();
    const rxs = (scoped && keys?.length && keys.length <= 5)
      ? keys.flatMap(k => [m.shown.get(k), ...(m.history.get(k) ?? [])]).filter(t => t && t.trim().length >= 1)
        .map(t => new RegExp(`^${t.trim().split(/{[^}]+}/).map(escapeRx).join(".{0,80}?").replace(/\s+/g, "\\s+")}$`))
      : null;
    const shows = el => {
      if ( !rxs ) return true;
      const test = v => {
        const text = v.replace(/\s+/g, " ").trim();
        return text && rxs.some(rx => rx.test(text));
      };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for ( let n = walker.nextNode(); n; n = walker.nextNode() ) if ( test(n.nodeValue) ) return true;
      for ( const e of el.querySelectorAll("[data-tooltip],[title],[placeholder],[aria-label]") ) {
        for ( const a of ["data-tooltip", "title", "placeholder", "aria-label"] ) if ( e.hasAttribute(a) && test(e.getAttribute(a)) ) return true;
      }
      return keys.some(k => (m.tracked?.[k] ?? []).some(tr => {
        const x = tr.node ?? tr.el;
        return x?.isConnected && el.contains(x);
      }));
    };
    const report = {apps: [], controls: false, chat: 0, hook: 0, ms: {}, errors: []};
    const time = async (name, fn) => {
      const start = performance.now();
      try {
        await fn();
      } catch(err) {
        report.errors.push(`${name}: ${err.message}`);
      }
      report.ms[name] = Math.round((performance.now() - start) * 10) / 10;
    };

    await time("settingFields", async () => {
      // core copies the localized name and hint into a setting's DataField on the first render (label ||= ...)
      const keyLike = v => /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(v ?? "");
      for ( const [id, d] of game.settings.settings ) {
        if ( !id.startsWith(`${moduleId}.`) || !(d.type instanceof foundry.data.fields.DataField) ) continue;
        if ( d.type.label && !keyLike(d.type.label) ) d.type.label = "";
        if ( d.type.hint && !keyLike(d.type.hint) ) d.type.hint = "";
      }
    });

    await time("apps", async () => {
      const targets = openApps().filter(({app}) => !isSelf(app) && (app.rendered !== false)
        && (rxs ? shows(elementOf(app) ?? document.createElement("i")) : this.belongs(app, moduleId)));
      await Promise.all(targets.map(async ({app, v}) => {
        try {
          if ( v === 2 ) {
            await app.render();
            // the frame keeps its title on a plain render
            if ( app.window?.title && (app.title !== undefined) ) app.window.title.innerText = app.title;
          }
          else await app.render(false);
          report.apps.push(app.id);
        } catch(err) {
          report.errors.push(`${app.id}: ${err.message}`);
        }
      }));
    });

    await time("controls", async () => {
      if ( rxs && !shows(document.getElementById("scene-controls") ?? document.createElement("i")) ) return;
      await ui.controls?.render({reset: true});
      report.controls = true;
    });

    await time("chat", async () => {
      const ids = new Set();
      for ( const el of document.querySelectorAll("#chat .chat-message, .chat-popout .chat-message") ) {
        const msg = game.messages.get(el.dataset.messageId);
        if ( !msg ) continue;
        const ours = msg.flags?.[moduleId] || m.roots.some(r => msg.flags?.[r.toLowerCase()]) || el.querySelector(`[class*="${moduleId}"]`);
        if ( rxs ? shows(el) : (ours || this.valuesOf(moduleId).some(v => el.textContent.includes(v))) ) ids.add(msg.id);
      }
      for ( const id of ids ) await ui.chat.updateMessage(game.messages.get(id));
      report.chat = ids.size;
    });

    if ( patch ) await time("patch", async () => {
      report.patched = this.patchDom(moduleId, keys ?? [...m.touched]);
    });

    await time("hook", async () => {
      // Modules that announce api.translatorRefresh redraw their own canvas texts (PIXI labels, cached strings)
      Hooks.callAll(REFRESH_HOOK, refreshPayload(moduleId, m.roots, keys, m.en.keys()));
      report.hook = 1;
    });

    report.totalMs = Math.round((performance.now() - t0) * 10) / 10;
    m.lastReport = report;
    try {
      this.onRefresh?.(moduleId, report);
    } catch(err) {
      console.warn("sephrals-translator | onRefresh failed", err);
    }
    return report;
  }

  /** The debounced call for every keystroke. Resolves with the report of the refresh that follows. */
  schedule(moduleId, changed) {
    const set = this.pending.get(moduleId) ?? new Set();
    for ( const key of changed ) set.add(key);
    this.pending.set(moduleId, set);
    clearTimeout(this.timers.get(moduleId));
    return new Promise(resolve => {
      this.timers.set(moduleId, setTimeout(async () => {
        const keys = [...(this.pending.get(moduleId) ?? [])];
        this.pending.delete(moduleId);
        resolve(keys.length ? await this.refresh(moduleId, {keys}) : null);
      }, DEBOUNCE));
    });
  }

  /** Texts of core, the system and other modules: a module text equal to one of them is never patched in place. */
  foreignSet(moduleId) {
    const m = this.mods.get(moduleId);
    const ownRoots = new Set([...this.mods.values()].flatMap(x => x.roots));
    this._foreign ??= {};
    const cacheKey = m.roots.join("|");
    if ( !this._foreign[cacheKey] ) {
      const set = new Set();
      const walk = o => {
        for ( const v of Object.values(o) ) {
          if ( typeof v === "string" ) set.add(v.replace(/\s+/g, " ").trim());
          else if ( v && (typeof v === "object") ) walk(v);
        }
      };
      for ( const [k, v] of Object.entries(game.i18n.translations) ) if ( !ownRoots.has(k) && v && (typeof v === "object") ) walk(v);
      for ( const v of Object.values(CONFIG.supportedLanguages ?? {}) ) set.add(String(v).trim());
      this._foreign[cacheKey] = set;
    }
    return this._foreign[cacheKey];
  }

  /**
   * For what no render rebuilds (a gear added once, a toast, a card built by hand, an open context menu): text nodes
   * and attributes that still show the text last drawn for a key get the new text in place. Templates with {x} match
   * with a pattern and keep the values found in the text.
   * @returns {number}   Number of places changed
   */
  patchDom(moduleId, keys) {
    const m = this.mods.get(moduleId);
    const jobs = [];
    for ( const key of keys ) {
      const to = m.current.get(key);
      const olds = [...new Set([m.shown.get(key) ?? m.en.get(key), ...(m.history.get(key) ?? [])])].filter(v => v !== to);
      for ( const from of olds ) {
        if ( !from || (from.trim().length < 2) || this.foreignSet(moduleId).has(from.trim()) ) continue;
        const names = [...from.matchAll(/{([^}]+)}/g)].map(x => x[1]);
        // a template that is mostly placeholders would match any text: leave it to the render
        if ( names.length && (from.replace(/{[^}]+}/g, "").trim().length < 4) ) continue;
        const rx = names.length ? new RegExp(`^${from.split(/\{[^}]+\}/).map(escapeRx).join("(.{0,80}?)")}$`) : null;
        jobs.push({key, from, to, rx, names});
      }
    }
    let n = 0;
    // nodes patched earlier follow the key directly: this also works for texts too short to search for
    for ( const key of keys ) {
      const to = m.current.get(key);
      if ( /{[^}]+}/.test(to) ) continue;
      for ( const t of m.tracked[key] ?? [] ) {
        if ( t.node ) {
          if ( t.node.isConnected && (t.node.nodeValue === t.text) ) {
            t.text = t.text.replace(t.core, () => to);
            t.node.nodeValue = t.text;
            t.core = to;
            n++;
          }
        }
        else if ( t.el?.isConnected && (t.el.getAttribute(t.attr) === t.text) ) {
          t.text = t.text.replace(t.core, () => to);
          t.el.setAttribute(t.attr, t.text);
          t.core = to;
          n++;
        }
      }
    }
    const apply = (text, job) => {
      if ( !job.rx ) return text.trim() === job.from.trim() ? text.replace(job.from.trim(), () => job.to) : null;
      const hit = text.trim().match(job.rx);
      if ( !hit ) return null;
      const vals = Object.fromEntries(job.names.map((nm, i) => [nm, hit[i + 1]]));
      return text.replace(text.trim(), () => job.to.replace(/{([^}]+)}/g, (all, nm) => vals[nm] ?? all));
    };
    if ( jobs.length ) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for ( let node = walker.nextNode(); node; node = walker.nextNode() ) {
        const el = node.parentElement;
        if ( !el || el.closest(`${SELF},script,style,textarea`) ) continue;
        for ( const job of jobs ) {
          const r = apply(node.nodeValue, job);
          if ( r !== null ) {
            node.nodeValue = r;
            n++;
            (m.tracked[job.key] ??= []).push({node, text: r, core: job.to});
            break;
          }
        }
      }
      for ( const el of document.querySelectorAll("[data-tooltip],[title],[placeholder],[aria-label],[alt]") ) {
        if ( el.closest(SELF) ) continue;
        for ( const attr of ["data-tooltip", "title", "placeholder", "aria-label", "alt"] ) {
          const v = el.getAttribute(attr);
          if ( !v ) continue;
          for ( const job of jobs ) {
            const r = apply(v, job);
            if ( r !== null ) {
              el.setAttribute(attr, r);
              n++;
              (m.tracked[job.key] ??= []).push({el, attr, text: r, core: job.to});
              break;
            }
          }
        }
      }
    }
    for ( const key of keys ) m.shown.set(key, m.current.get(key));
    return n;
  }

  /* -------------------------------------------- */
  /*  Where a key is shown                        */
  /* -------------------------------------------- */

  /** Every element (and attribute) of the page whose text passes the test, except the translator's windows. */
  scan(test) {
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for ( let n = walker.nextNode(); n; n = walker.nextNode() ) {
      const el = n.parentElement;
      // a sample window the translator learns unseen is not on screen
      if ( !el || el.closest(`${SELF},script,style,.stl-learning`) ) continue;
      if ( test(n.nodeValue) ) hits.push({el, where: "text"});
    }
    for ( const el of document.querySelectorAll("[data-tooltip],[title],[placeholder],[aria-label],[alt]") ) {
      if ( el.closest(`${SELF},.stl-learning`) ) continue;
      for ( const attr of ["data-tooltip", "title", "placeholder", "aria-label", "alt"] ) {
        const v = el.getAttribute(attr);
        if ( v && test(v) ) hits.push({el, where: attr});
      }
    }
    return hits;
  }

  /** A template as a whole text: only surrounding space and a trailing colon or full stop may differ. */
  wholeRegex(text) {
    return new RegExp(`^\\s*(?:${this.templateRegex(text).source})\\s*[:.…]?\\s*$`, "i");
  }

  /** A regular expression for a template: {x} matches anything. */
  templateRegex(text) {
    const esc = text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "\u0000").split("\u0000").join(".{0,80}?");
    return new RegExp(esc.trim().replace(/\s+/g, "\\s+"), "i");
  }

  /** The element to outline for a hit: an option shows through its select. */
  targetOf(el) {
    return el.closest("select") ?? el;
  }

  /**
   * Outline elements. Sticky marks stay until the next mark or clearMarks (the selected text), the others go after
   * a few seconds. A pulse draws the eye for a moment.
   * @param {{el: HTMLElement}[]} hits
   * @param {{sticky?: boolean, pulse?: boolean}} [options]
   * @returns {HTMLElement[]}   the outlined elements
   */
  mark(hits, {sticky = false, pulse = true} = {}) {
    const els = [...new Set(hits.map(h => this.targetOf(h.el)))];
    const keep = new Set(els);
    for ( const el of document.querySelectorAll(".stl-hl") ) if ( !keep.has(el) ) el.classList.remove("stl-hl", "stl-hl-pulse");
    for ( const el of els ) {
      el.classList.add("stl-hl");
      if ( pulse ) {
        el.classList.remove("stl-hl-pulse");
        void el.offsetWidth;
        el.classList.add("stl-hl-pulse");
      }
    }
    this.marked = els;
    clearTimeout(this._markTimer);
    if ( !sticky ) this._markTimer = setTimeout(() => this.clearMarks(), 6000);
    return els;
  }

  clearMarks() {
    clearTimeout(this._markTimer);
    this.marked = [];
    for ( const el of document.querySelectorAll(".stl-hl") ) el.classList.remove("stl-hl", "stl-hl-pulse");
  }

  /** Are the outlined elements still on the page (a window drawn again replaces them)? */
  marksAlive() {
    return !!this.marked?.length && this.marked.every(el => el.isConnected);
  }

  /** Does the element take space on screen (not in a hidden tab, a closed details or a minimized window)? */
  isShownEl(el) {
    return !!el?.isConnected && (el.getClientRects().length > 0) && !el.closest(".minimized .window-content");
  }

  /**
   * The places on the page that show the text of a key. Whole texts first: a short label is not marked inside every
   * longer text that happens to contain it.
   * @param {string} moduleId
   * @param {string} key
   * @returns {{el: HTMLElement, where: string}[]}
   */
  hitsOf(moduleId, key) {
    const text = (this.mods.get(moduleId)?.current.get(key) ?? "").trim();
    // a text that is only placeholders ("{name}") would match every text on the page
    if ( !hasLiteral(text) ) return [];
    const rx = this.templateRegex(text);
    const whole = this.wholeRegex(text);
    const exact = this.scan(v => whole.test(v));
    if ( exact.length || (text.length < 12) ) return exact;
    return this.scan(v => rx.test(v));
  }

  /**
   * The keys of the module whose text an element shows, for picking a text on screen: its own text, its tooltip and
   * label, the chosen option of a select; else the same for its parents (up to three levels). Whole texts first.
   * @param {string} moduleId
   * @param {HTMLElement} el
   * @returns {string[]}
   */
  keysAt(moduleId, el) {
    const m = this.mods.get(moduleId);
    if ( !m || !el ) return [];
    const tests = [...m.current.entries()].filter(([, text]) => (typeof text === "string") && hasLiteral(text))
      .map(([key, text]) => ({key, whole: this.wholeRegex(text.trim()), part: (text.trim().length >= 12) ? this.templateRegex(text) : null}));
    const plain = v => String(v ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    for ( let node = el, depth = 0; node && (node !== document.body) && (depth < 4); node = node.parentElement, depth++ ) {
      const strings = [];
      for ( const attr of ["data-tooltip", "title", "aria-label", "placeholder", "alt"] ) strings.push(plain(node.getAttribute?.(attr)));
      strings.push(plain([...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.nodeValue).join(" ")));
      if ( node.tagName === "SELECT" ) strings.push(plain(node.selectedOptions?.[0]?.textContent));
      if ( (node.textContent ?? "").length <= 400 ) strings.push(plain(node.textContent));
      const texts = strings.filter(v => v.length >= 2);
      const whole = tests.filter(x => texts.some(v => x.whole.test(v))).map(x => x.key);
      if ( whole.length ) return whole;
      const part = tests.filter(x => x.part && texts.some(v => x.part.test(v))).map(x => x.key);
      if ( part.length ) return part;
    }
    return [];
  }

  /**
   * Put first the keys the window around an element looked up (several keys with the same English: the one this
   * window uses is the one meant).
   * @param {string} moduleId
   * @param {string[]} keys
   * @param {string|null} appId   id of the window the element sits in
   * @returns {string[]}
   */
  rankByWindow(moduleId, keys, appId) {
    const usage = this.mods.get(moduleId)?.usage ?? {};
    const here = k => (appId && usage[k]?.includes(appId)) ? 0 : 1;
    return [...keys].sort((a, b) => here(a) - here(b));
  }

  /**
   * Make a hidden element visible: switch to its tab, open a closed details, bring back a minimized window.
   * @param {HTMLElement} el
   * @returns {boolean}   whether anything changed
   */
  reveal(el) {
    let changed = false;
    const frame = el.closest(".application, .app");
    const app = frame ? [...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})]
      .find(a => elementOf(a) === frame) : null;
    if ( app?.minimized ) {
      app.maximize?.();
      changed = true;
    }
    for ( let node = el; node && (node !== document.body); node = node.parentElement ) {
      if ( (node.tagName === "DETAILS") && !node.open ) {
        node.open = true;
        changed = true;
      }
      const tab = node.dataset?.tab;
      if ( !tab || !node.classList.contains("tab") || node.classList.contains("active") ) continue;
      const group = node.dataset.group;
      if ( group && (typeof app?.changeTab === "function") ) {
        try {
          app.changeTab(tab, group);
          changed = true;
          continue;
        } catch {
          /* fall back to the tab button */
        }
      }
      const sel = `[data-tab="${CSS.escape(tab)}"]${group ? `[data-group="${CSS.escape(group)}"]` : ""}`;
      const button = [...(frame ?? document).querySelectorAll(sel)].find(n => (n !== node) && !n.classList.contains("tab"));
      if ( button ) {
        button.click();
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Outline the places where a key shows now.
   * @param {string} moduleId
   * @param {string} key
   * @param {{sticky?: boolean, pulse?: boolean, reveal?: boolean}} [options]
   *   reveal: switch tabs or open what hides the first place, and scroll it into view
   * @returns {{count: number, shown: number}}   places found, places visible on screen
   */
  highlight(moduleId, key, {sticky = false, pulse = true, reveal = false} = {}) {
    let hits = this.hitsOf(moduleId, key);
    if ( !hits.length ) {
      if ( sticky ) this.clearMarks();
      return {count: 0, shown: 0};
    }
    if ( reveal && !hits.some(h => this.isShownEl(this.targetOf(h.el))) && this.reveal(this.targetOf(hits[0].el)) ) {
      hits = this.hitsOf(moduleId, key);
    }
    const els = this.mark(hits, {sticky, pulse});
    const shown = els.filter(el => this.isShownEl(el));
    if ( reveal && shown.length ) shown[0].scrollIntoView({block: "center", inline: "nearest", behavior: "smooth"});
    return {count: els.length, shown: shown.length};
  }

  /**
   * Which of the keys show on screen now? One scan of the page for the texts of the given keys.
   * @param {string} moduleId
   * @param {string[]} keys
   * @returns {Set<string>}
   */
  visibleKeys(moduleId, keys) {
    const m = this.mods.get(moduleId);
    const foreign = this.foreignSet(moduleId);
    // a short text counts only as a whole text (like the outline), so "Story" is not found inside every longer text
    const rxs = keys.map(key => [key, m.current.get(key) ?? ""]).filter(([, t]) => hasLiteral(t) && !foreign.has(t.trim()))
      .map(([key, t]) => [key, (t.trim().length < 12) ? this.wholeRegex(t.trim()) : this.templateRegex(t)]);
    const found = new Set();
    if ( !rxs.length ) return found;
    const test = v => {
      for ( const [key, rx] of rxs ) if ( !found.has(key) && rx.test(v) ) found.add(key);
      return false;
    };
    this.scan(test);
    return found;
  }

  /* -------------------------------------------- */
  /*  Which keys a window looks up                */
  /* -------------------------------------------- */

  /**
   * Run fn while every dotted key that reaches the translations is recorded. foundry.utils.getProperty starts with
   * `key in object`, so a Proxy with a has trap sees the full key of every localize, format and Handlebars call.
   * @returns {Promise<Set<string>>}
   */
  async record(fn) {
    const keys = new Set();
    const original = game.i18n.translations;
    game.i18n.translations = new Proxy(original, {has(target, key) {
      if ( (typeof key === "string") && key.includes(".") ) keys.add(key);
      return key in target;
    }});
    try {
      await fn();
    } finally {
      game.i18n.translations = original;
    }
    return keys;
  }

  /**
   * Render every open window of the module once while recording: key to ids of the windows that looked it up.
   * @param {string} moduleId
   * @returns {Promise<Record<string, string[]>>}
   */
  async usageByRender(moduleId) {
    const m = this.mods.get(moduleId);
    const usage = {};
    for ( const {app, v} of openApps() ) {
      if ( isSelf(app) || (app.rendered === false) || elementOf(app)?.classList.contains("stl-learning") || !this.belongs(app, moduleId) ) continue;
      const keys = await this.record(async () => {
        if ( v === 2 ) await app.render();
        else await app.render(false);
      });
      for ( const k of keys ) if ( m.en.has(k) ) (usage[k] ??= []).push(app.id);
    }
    m.usage = usage;
    return usage;
  }

  /**
   * Which files of the module mention a key (literally or by its prefix). Reads scripts and templates through the file
   * browser, which only some users may use; without it the answer is null and the states fall back to "open".
   * @param {string} moduleId
   * @returns {Promise<Record<string, string[]>|null>}
   */
  async index(moduleId) {
    const m = this.mods.get(moduleId);
    if ( m.index !== null ) return m.index;
    try {
      const FP = foundry.applications.apps.FilePicker.implementation;
      const files = [];
      const walk = async (dir, depth = 0) => {
        const r = await FP.browse("data", dir);
        for ( const f of r.files ) if ( /\.(mjs|js|hbs|html)$/.test(f) ) files.push(f);
        if ( depth < 4 ) for ( const d of r.dirs ) if ( !/node_modules|media|lang|tests/.test(d) ) await walk(d, depth + 1);
      };
      for ( const sub of ["scripts", "templates"] ) {
        try {
          await walk(`modules/${moduleId}/${sub}`);
        } catch {
          /* the folder may not exist */
        }
      }
      const texts = await Promise.all(files.map(async f => [f, await (await fetch(f)).text()]));
      const usage = {};
      const kinds = {};
      for ( const key of m.en.keys() ) {
        let where = texts.filter(([, t]) => t.includes(key)).map(([f]) => f.split(`${moduleId}/`)[1]);
        // where the key appears, from the code around its first uses (a chat message, a notification, a dialog ...)
        for ( const [f, t] of texts ) {
          const at = t.indexOf(key);
          if ( at < 0 ) continue;
          const kind = kindOf(f.split(`${moduleId}/`)[1] ?? f, t.slice(Math.max(0, at - 250), at + key.length + 250));
          if ( kind && (!kinds[key] || (kinds[key] === "window")) ) kinds[key] = kind;
        }
        if ( !where.length ) {
          const parts = key.split(".");
          for ( let i = parts.length - 1; (i >= 2) && !where.length; i-- ) {
            const prefix = `${parts.slice(0, i).join(".")}.`;
            where = texts.filter(([, t]) => t.includes(`${prefix}\${`) || t.includes(`"${prefix}" +`) || t.includes(`\`${prefix}`))
              .map(([f]) => f.split(`${moduleId}/`)[1]);
          }
        }
        if ( where.length ) usage[key] = where;
      }
      m.index = usage;
      m.kinds = kinds;
      // the code itself, for the last fallback: show where a key is used when no window can show it
      m.files = new Map(texts.map(([file, text]) => [file.split(`${moduleId}/`)[1] ?? file, text]));
    } catch {
      m.index = false;
    }
    return m.index || null;
  }

  /**
   * The states of a key.
   *  live    the text is on screen now, or a window that is open looks it up
   *  map     drawn on the map by a module that redraws it on the refresh hook (api.translatorRefreshKeys): changes there while typing
   *  open    not on screen right now: open the window to see it
   *  reload  fixed at start or by hand: visible after a reload
   * @param {string} moduleId
   * @param {string} key
   * @param {Set<string>} visible   from visibleKeys
   * @returns {"live"|"map"|"open"|"reload"}
   */
  stateOf(moduleId, key, visible) {
    const m = this.mods.get(moduleId);
    // a window that looked the key up counts only while it is still open
    const ids = m.usage?.[key];
    if ( visible?.has(key) || (ids?.length && openApps().some(({app}) => ids.includes(app.id) && elementOf(app)?.isConnected && !elementOf(app).classList.contains("stl-learning"))) ) return "live";
    // canvas texts are not in the page, so "open to see" would be wrong while the map redraws them live
    if ( canvas?.ready && drawsOnCanvas(game.modules.get(moduleId)?.api, key) ) return "map";
    const files = m.index?.[key];
    // a listening module redraws its canvas texts, but hub, selftest, language and similar files still wait for a reload
    if ( files?.length && files.every(f => STARTUP_FILES.test(f)) ) {
      const listens = this.listens(moduleId);
      if ( !listens || !files.every(f => REDRAWN_FILES.test(f)) ) return "reload";
    }
    return "open";
  }

  /**
   * Does the module redraw its canvas texts on the refresh hook?
   * @param {string} moduleId
   * @returns {boolean}
   */
  listens(moduleId) {
    return listensToRefresh(game.modules.get(moduleId)?.api);
  }

  /* -------------------------------------------- */
  /*  Finding the window that shows a key         */
  /* -------------------------------------------- */

  /**
   * The setting or settings menu of the module that shows a key (its name, hint or one of its choices).
   * @param {string} moduleId
   * @param {string} key
   * @returns {{kind: "setting"|"menu", id: string, gmOnly: boolean}|null}
   */
  settingOf(moduleId, key) {
    const m = this.mods.get(moduleId);
    const texts = new Set([key, m?.en.get(key), m?.base.get(key), m?.current.get(key)].filter(v => (typeof v === "string") && (v.length > 1)));
    const hit = v => (typeof v === "string") && texts.has(v);
    const canConfigure = game.user.can("SETTINGS_MODIFY");
    for ( const s of game.settings.settings.values() ) {
      if ( (s.namespace !== moduleId) || !s.config ) continue;
      const choices = (s.choices && (typeof s.choices === "object")) ? Object.values(s.choices) : [];
      if ( hit(s.name) || hit(s.hint) || choices.some(hit) ) return {kind: "setting", id: s.key, gmOnly: (s.scope === "world") && !canConfigure};
    }
    for ( const menu of game.settings.menus.values() ) {
      if ( (menu.namespace === moduleId) && [menu.name, menu.label, menu.hint].some(hit) ) {
        return {kind: "menu", id: menu.key, gmOnly: !!menu.restricted && !canConfigure};
      }
    }
    return null;
  }

  /**
   * Open Foundry's settings on the tab of a module.
   * @param {string} moduleId
   */
  async openSettings(moduleId) {
    const sheet = game.settings.sheet;
    await sheet.render({force: true});
    try {
      sheet.changeTab(moduleId, "categories");
    } catch {
      /* a module without settings of its own has no tab */
    }
    sheet.bringToFront?.();
    await wait(250);
  }

  /**
   * The sample windows of a module (api.samples, see samples.mjs in the modules): windows filled with made-up data,
   * nothing saved. Empty when the module has none.
   * @param {string} moduleId
   * @returns {{id: string, label: string, group: string, open: Function}[]}
   */
  samples(moduleId) {
    const api = game.modules.get(moduleId)?.api;
    if ( (typeof api?.samples !== "function") || (moduleId === "sephrals-translator") ) return [];
    try {
      const list = api.samples();
      return (Array.isArray(list) ? list : []).filter(e => e?.id && (typeof e.open === "function"))
        .map(e => ({id: String(e.id), label: String(e.label ?? e.id), group: String(e.group ?? ""), open: e.open}));
    } catch(err) {
      console.warn(`sephrals-translator | the sample windows of ${moduleId} failed`, err);
      return [];
    }
  }

  /**
   * Learn once per module and session which texts its sample windows show: each one is opened unseen (hidden while it
   * draws, notifications muted), its tabs are clicked, the keys it looks up are kept, and it is closed again. Then the
   * states know which texts a sample window shows (a chat card, a tab) and which no window shows. A search for a window
   * waits for this.
   * @param {string} moduleId
   * @returns {Promise<void>}
   */
  learnSamples(moduleId) {
    this.learning ??= new Map();
    if ( this.learning.has(moduleId) ) return this.learning.get(moduleId);
    const run = (async () => {
      const m = this.mods.get(moduleId);
      if ( !m ) return;
      m.windows ??= new Map();
      const todo = this.candidates(moduleId).filter(c => c.sample && !m.windows.has(c.id));
      if ( !todo.length ) return;
      // only the sample windows of this module are hidden (their ids by the shared convention), never a window the
      // user opens meanwhile
      const prefix = `${moduleId}-sample-`;
      const hide = el => {
        // only while a learning step runs: a search the user started shows its windows
        if ( !this.#learningNow || (el?.nodeType !== 1) || !el.matches(".application, .app") || el.matches(SELF) ) return;
        if ( String(el.id).startsWith(prefix) || el.classList.contains("sephral-sample-window") ) el.classList.add("stl-learning");
      };
      const observer = new MutationObserver(records => {
        for ( const r of records ) for ( const n of r.addedNodes ) hide(n);
      });
      observer.observe(document.body, {childList: true, subtree: true});
      try {
        // a window that another window drew meanwhile looked up keys that are not its own: learned again later
        const tries = new Map();
        while ( todo.length ) {
          // a search the user started goes first; the learning goes on after it
          while ( this.#searching > 0 ) await wait(150);
          const c = todo.shift();
          if ( this.mods.get(moduleId) !== m ) break;
          // a search may have tried it meanwhile; a sample the user has open now stays as it is (learned later)
          if ( m.windows.has(c.id) ) continue;
          const shownNow = foundry.applications.instances.get(c.appId);
          if ( shownNow?.rendered && !elementOf(shownNow)?.classList.contains("stl-learning") ) {
            tries.set(c.id, (tries.get(c.id) ?? 0) + 1);
            if ( tries.get(c.id) < 6 ) todo.push(c);
            if ( todo.every(t => foundry.applications.instances.get(t.appId)?.rendered) ) await wait(2000);
            continue;
          }
          this.#learningNow = true;
          // a window drawn unseen must not take the focus (an open dropdown of the user would close)
          const focus = HTMLElement.prototype.focus;
          HTMLElement.prototype.focus = function(...args) {
            if ( !this.closest?.(`${SELF}, .stl-app`) ) return;
            return focus.apply(this, args);
          };
          let result;
          try {
            this.#learnStep = this.#tryCandidate(moduleId, c, LEARN);
            result = await this.#learnStep;
          } finally {
            HTMLElement.prototype.focus = focus;
            this.#learnStep = null;
            this.#learningNow = false;
          }
          if ( result !== "mixed" ) continue;
          tries.set(c.id, (tries.get(c.id) ?? 0) + 1);
          if ( tries.get(c.id) < 3 ) todo.push(c);
        }
      } catch(err) {
        console.warn(`sephrals-translator | learning the sample windows of ${moduleId} failed`, err);
      } finally {
        observer.disconnect();
        // a window still open unseen (the user switched the module, a step failed) is closed, never shown
        for ( const {app} of openApps() ) {
          if ( elementOf(app)?.classList.contains("stl-learning") ) await app.close({animate: false}).catch(() => {});
        }
        document.querySelectorAll(".stl-learning").forEach(el => el.classList.remove("stl-learning"));
      }
    })();
    this.learning.set(moduleId, run);
    return run;
  }

  /**
   * Does the text of a key name a sample window or its group (shown in the field Sample windows of the translator)?
   * @param {string} moduleId
   * @param {string} key
   * @returns {boolean}
   */
  isSampleLabel(moduleId, key) {
    const text = (this.mods.get(moduleId)?.current.get(key) ?? "").trim();
    if ( text.length < 3 ) return false;
    return this.samples(moduleId).some(e => (e.label === text) || (e.group === text) || ((text.length >= 6) && e.label.includes(text)));
  }

  /**
   * Keep what a sample window opened from the header looked up, like a search would.
   * @param {string} moduleId
   * @param {string} id   the sample id
   * @param {Set<string>} keys
   */
  noteSample(moduleId, id, keys) {
    const m = this.mods.get(moduleId);
    if ( !m ) return;
    m.windows ??= new Map();
    const own = m.windows.get(`sample.${id}`) ?? new Set();
    for ( const k of keys ) if ( m.en.has(k) ) own.add(k);
    m.windows.set(`sample.${id}`, own);
  }

  /**
   * Ways to open a window of the module: its sample windows first (they show the texts with data), then the open
   * functions of its API that need no argument, and its settings menus that open a window (not the self test, the debug
   * file and the other action menus every module has).
   * @param {string} moduleId
   * @returns {{id: string, words: Set<string>, run: Function, sample?: boolean, label?: string}[]}
   */
  candidates(moduleId) {
    // appId: the id its window gets by the shared convention (sampleId in samples.mjs)
    const list = this.samples(moduleId).map(e => ({id: `sample.${e.id}`, words: wordsOf(`${e.id} ${e.label}`), run: () => e.open(),
      sample: true, label: e.label, appId: `${moduleId}-sample-${String(e.id).replace(/[^\w-]/g, "-")}`}));
    const api = game.modules.get(moduleId)?.api;
    if ( api && (typeof api === "object") && (moduleId !== "sephrals-translator") ) {
      for ( const name of Object.keys(api) ) {
        const fn = api[name];
        if ( (typeof fn !== "function") || !/^open/.test(name) || (fn.length > 0) ) continue;
        list.push({id: `api.${name}`, words: wordsOf(name), run: () => fn.call(api)});
      }
    }
    const canConfigure = game.user.can("SETTINGS_MODIFY");
    for ( const menu of game.settings.menus.values() ) {
      const Type = menu.type;
      if ( (menu.namespace !== moduleId) || ACTION_MENUS.test(menu.key) || (menu.restricted && !canConfigure) || (typeof Type !== "function") ) continue;
      list.push({id: `menu.${menu.key}`, words: wordsOf(`${menu.key} ${Type.name}`), run: async () => {
        const id = Type.DEFAULT_OPTIONS?.id;
        const open = id ? foundry.applications.instances.get(id) : null;
        const app = open ?? new Type();
        if ( app instanceof foundry.applications.api.ApplicationV2 ) await app.render({force: true});
        else await app.render(true);
        app.bringToFront?.();
      }});
    }
    return list;
  }

  /**
   * Open the window that shows a key: the settings for a setting, else the window that looked the key up before, else
   * the candidates one by one (best name match first). A candidate whose window does not show the key is closed again.
   * Learned per module, so the next key of the same window opens at once.
   * @param {string} moduleId
   * @param {string} key
   * @param {{place?: (el: HTMLElement) => void}} [options]   place: puts each window the search opens in its place
   * @returns {Promise<{how: "shown"|"settings"|"window"|null, kind?: string, sample?: boolean}>}
   *   how null: no window shows the key on its own, kind says where it appears (chat, notify, dialog, player, ...)
   *   sample: a sample window of the module (made-up data) shows it
   */
  async findWindow(moduleId, key, {place = null} = {}) {
    const m = this.mods.get(moduleId);
    if ( !m ) return {how: null, kind: "unknown"};
    if ( this.visibleKeys(moduleId, [key]).has(key) ) return {how: "shown"};
    const setting = this.settingOf(moduleId, key);
    if ( setting?.gmOnly ) return {how: null, kind: "gmSetting"};
    if ( setting ) {
      await this.openSettings(moduleId);
      return {how: "settings"};
    }
    // a learning run in the background pauses after its current window, the search runs at once
    return this.exclusive(async () => {
      this.#placeOpened = place;
      try {
        return await this.#search(moduleId, key);
      } finally {
        this.#placeOpened = null;
      }
    });
  }

  /**
   * Run something that opens windows of a module (a search, a sample from the header) while the learning in the
   * background waits: it pauses after the window it looks at now and goes on afterwards.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async exclusive(fn) {
    this.#searching++;
    try {
      await this.#learnStep;
      return await fn();
    } finally {
      this.#searching--;
    }
  }

  /**
   * Hold the learning in the background (after the window it looks at now) until the returned function is called, for
   * example while the user has a dropdown of the translator open.
   * @returns {() => void}
   */
  holdLearning() {
    this.#searching++;
    let held = true;
    return () => {
      if ( !held ) return;
      held = false;
      this.#searching--;
    };
  }

  /** The search of findWindow: windows that looked the key up before, then the untried ways to open one. */
  async #search(moduleId, key) {
    const m = this.mods.get(moduleId);
    m.windows ??= new Map();
    m.noWindow ??= new Set();
    m.bestOf ??= new Map();
    const all = this.candidates(moduleId);
    const words = wordsOf([key.split(".").slice(1).join(" "), ...(m.index?.[key] ?? [])].join(" "));
    const score = c => [...c.words].filter(w => [...words].some(v => (v === w) || ((Math.min(v.length, w.length) >= 4) && (v.startsWith(w) || w.startsWith(v))))).length;
    // the windows that looked the key up before (the one that showed it first), then the untried ones: best name
    // match first, on a tie a sample window, which shows the window with data
    const best = m.bestOf.get(key) ?? m.tabOf?.get(key)?.candidate;
    const known = all.filter(c => m.windows.get(c.id)?.has(key)).sort((a, b) => Number(b.id === best) - Number(a.id === best));
    const untried = all.filter(c => !m.windows.has(c.id)).sort((a, b) => (score(b) - score(a)) || (Number(!!b.sample) - Number(!!a.sample)));
    // a window that looks the key up but does not show it (another state, a picture) comes back when nothing shows it
    let looked = null;
    for ( const c of [...known, ...untried] ) {
      const result = await this.#tryCandidate(moduleId, c, key);
      if ( result === "shown" ) {
        m.bestOf.set(key, c.id);
        return {how: "window", sample: !!c.sample};
      }
      if ( result === "looked" ) looked ??= c;
    }
    if ( looked ) {
      await this.#tryCandidate(moduleId, looked, key, {keep: true});
      return {how: "window", sample: !!looked.sample};
    }
    m.noWindow.add(key);
    return {how: null, kind: this.whereOf(moduleId, key)};
  }

  /**
   * Did a window of the module (a sample, an open function, a menu) look the key up before?
   * @param {string} moduleId
   * @param {string} key
   * @returns {boolean}
   */
  knownWindow(moduleId, key) {
    return [...(this.mods.get(moduleId)?.windows?.values() ?? [])].some(keys => keys.has(key));
  }

  /**
   * Is it known that no window shows the key on its own? Either it was looked for, or every way to open a window of the
   * module was tried once and none of them looked the key up.
   * @param {string} moduleId
   * @param {string} key
   * @returns {boolean}
   */
  noWindow(moduleId, key) {
    const m = this.mods.get(moduleId);
    if ( !m ) return false;
    if ( m.noWindow?.has(key) ) return true;
    if ( !m.windows?.size ) return false;
    const all = this.candidates(moduleId);
    if ( !all.every(c => m.windows.has(c.id)) ) return false;
    return !all.some(c => m.windows.get(c.id).has(key));
  }

  /**
   * Run one candidate while recording the keys it looks up, then look through the tabs of its new windows. Close its new
   * windows when the key is not among them (keep: leave them open). The tab that showed a key is remembered.
   * @returns {Promise<"shown"|"looked"|"opened"|false>}   looked: the window looked the key up but does not show it
   */
  async #tryCandidate(moduleId, candidate, key, {keep = false} = {}) {
    const m = this.mods.get(moduleId);
    m.tabOf ??= new Map();
    const before = new Set(openApps().map(({app}) => app));
    let keys = new Set();
    // while learning, note any window drawn that is not a sample window of this module
    const watch = [];
    if ( key === LEARN ) {
      this.#mixed = false;
      // its own window by the shared id, or one it opened that existed before (another sample the user opened is foreign)
      const onRender = app => {
        if ( isSelf(app) ) return;
        if ( candidate.appId && String(app.id).startsWith(candidate.appId) ) return;
        if ( !candidate.appId && !before.has(app) ) return;
        this.#mixed = true;
      };
      watch.push(["renderApplicationV2", Hooks.on("renderApplicationV2", onRender)], ["renderApplication", Hooks.on("renderApplication", onRender)]);
    }
    // looking stays quiet: a way that does not fit (GM only, nothing selected) must not pop up a notification
    const notifications = globalThis.ui?.notifications;
    const notify = notifications?.notify;
    const ownNotify = !!notifications && Object.hasOwn(notifications, "notify");
    // (not while learning in the background: a sample opens without notifications, and the user may be shown one)
    const mute = notify && (key !== LEARN);
    if ( mute ) notifications.notify = () => ({id: -1, remove() {}, update() {}});
    try {
      keys = await this.record(async () => {
        // a way that waits for its window to close (a modal question) must not hold the search: 5 seconds at most
        await Promise.race([Promise.resolve().then(() => candidate.run()), wait(5000)]);
        await wait(400);
      });
    } catch(err) {
      console.warn(`sephrals-translator | ${moduleId} ${candidate.id} failed`, err);
    } finally {
      if ( mute && ownNotify ) notifications.notify = notify;
      else if ( mute ) delete notifications.notify;
    }
    // the module was switched meanwhile: close what this way opened and stop
    if ( this.mods.get(moduleId) !== m ) {
      for ( const {app} of openApps() ) if ( !before.has(app) && !isSelf(app) ) await app.close({animate: false}).catch(() => {});
      for ( const [hook, id] of watch ) Hooks.off(hook, id);
      return false;
    }
    const own = new Set([...keys].filter(k => m.en.has(k)));
    m.windows.set(candidate.id, own);
    // a learning run counts only sample windows as its own: the user may open other windows meanwhile
    const isSample = app => String(app.id).startsWith(`${moduleId}-sample-`) || !!elementOf(app)?.classList.contains("stl-learning");
    const opened = openApps().map(({app}) => app).filter(app => !before.has(app) && !isSelf(app) && (app.rendered !== false) && ((key !== LEARN) || isSample(app)));
    // a way that only brought an open window to the front: that window, and the other open windows of the module
    const fresh = opened.length ? opened : openApps().map(({app}) => app).filter(app => !isSelf(app) && (app.rendered !== false) && this.belongs(app, moduleId));
    // a search shows its windows beside the translator from the start, so the walk through their tabs hides nothing
    const place = () => {
      if ( (key === LEARN) || !this.#placeOpened ) return;
      for ( const app of fresh ) {
        const el = elementOf(app);
        if ( el?.isConnected ) try { this.#placeOpened(el); } catch { /* a window that does not move stays where it is */ }
      }
    };
    place();
    // a tab learned before: straight to it
    const learned = m.tabOf.get(key);
    if ( learned?.candidate === candidate.id ) await this.#clickTab(fresh, learned.tab);
    if ( this.#shownIn(moduleId, key, fresh) ) return "shown";
    // the other tabs of the new windows, one by one (only tab buttons, they change nothing); every text that shows
    // first on a tab is remembered with it
    // learning: the same window at another tab (all its first keys known from a window walked before) needs no walk
    const walkedBefore = (key === LEARN) && own.size && [...own].every(k => m.walkedKeys?.has(k));
    if ( fresh.length && !walkedBefore ) {
      const seen = this.visibleKeys(moduleId, [...own]);
      // learning only needs the keys: a window that drew every tab at once adds none on the first two clicks
      let idle = 0;
      for ( const tab of fresh.flatMap(app => tabsOf(elementOf(app))) ) {
        if ( (key === LEARN) && (idle >= 2) ) break;
        const more = await this.record(async () => {
          await this.#clickTab(fresh, tab);
        });
        place();
        const size = own.size;
        for ( const k of more ) if ( m.en.has(k) ) own.add(k);
        idle = (own.size > size) ? 0 : idle + 1;
        for ( const k of this.visibleKeys(moduleId, [...own]) ) {
          if ( seen.has(k) ) continue;
          seen.add(k);
          if ( !m.tabOf.has(k) ) m.tabOf.set(k, {candidate: candidate.id, tab});
        }
        if ( this.#shownIn(moduleId, key, fresh) ) {
          m.tabOf.set(key, {candidate: candidate.id, tab});
          return "shown";
        }
      }
    }
    for ( const [hook, id] of watch ) Hooks.off(hook, id);
    if ( (key === LEARN) && !this.#mixed && fresh.length && !walkedBefore ) {
      m.walkedKeys ??= new Set();
      for ( const k of own ) m.walkedKeys.add(k);
    }
    if ( (key === LEARN) && this.#mixed ) {
      // another window was drawn while this one was recorded (the user, the module itself): its keys are not known
      this.#mixed = false;
      m.windows.delete(candidate.id);
      for ( const {app} of openApps() ) if ( !before.has(app) && isSample(app) ) await app.close().catch(() => {});
      return "mixed";
    }
    const looked = own.has(key) && (fresh.length > 0);
    if ( (keep && fresh.length) || (!opened.length && looked) ) return looked ? "looked" : "opened";
    // close what this way opened (and sample windows it led to), never a window the user opened meanwhile
    for ( const {app} of openApps() ) {
      if ( before.has(app) || isSelf(app) ) continue;
      if ( !opened.includes(app) && !isSample(app) ) continue;
      try {
        await app.close();
      } catch {
        /* a window that does not close stays */
      }
    }
    return looked ? "looked" : false;
  }

  /**
   * Does the key show now in one of the given windows: a place of its text there that is visible (the page scan also
   * finds text in hidden tab panels, which a window may draw all at once).
   */
  #shownIn(moduleId, key, apps) {
    const frames = apps.map(app => elementOf(app)).filter(Boolean);
    return this.hitsOf(moduleId, key).some(h => frames.some(f => f.contains(h.el)) && this.isShownEl(this.targetOf(h.el)));
  }

  /**
   * Click a tab button in one of the windows (looked up again, a render may have replaced it).
   * @param {object[]} apps
   * @param {{tab: string, group: string, action: string}} tab
   * @returns {Promise<boolean>}
   */
  async #clickTab(apps, tab) {
    const find = app => tabsOf(elementOf(app), {elements: true}).find(t => (t.tab === tab.tab) && (t.group === tab.group) && (t.action === tab.action));
    for ( const app of apps ) {
      const button = find(app);
      if ( !button ) continue;
      if ( isActiveTab(button.el) ) return true;
      button.el.click();
      // a window that draws itself again for a tab is ready when the new button is the active one (at most 2 seconds)
      for ( let waited = 0; waited < 2000; waited += 50 ) {
        await wait(50);
        const now = find(app);
        if ( now && isActiveTab(now.el) ) break;
      }
      await wait(120);
      return true;
    }
    return false;
  }

  /**
   * Where a key appears when no window shows it, from the code around it: chat, notify, dialog, player, window or unknown.
   * @param {string} moduleId
   * @param {string} key
   * @returns {string}
   */
  whereOf(moduleId, key) {
    return this.mods.get(moduleId)?.kinds?.[key] ?? "unknown";
  }

  /** Does the code of the module mention the key (so "Show the code" has something to show)? */
  hasCode(moduleId, key) {
    return !!this.mods.get(moduleId)?.index?.[key]?.length && !!this.mods.get(moduleId)?.files?.size;
  }

  /**
   * Where a key is used in the code of the module: up to three places, each with a few lines around it. A key built
   * from parts (`SRR.Type.${type}`) is found by its prefix.
   * @param {string} moduleId
   * @param {string} key
   * @param {{context?: number, max?: number}} [options]
   * @returns {{file: string, line: number, lines: {n: number, text: string, hit: boolean}[]}[]}
   */
  codeFor(moduleId, key, {context = 3, max = 3} = {}) {
    const m = this.mods.get(moduleId);
    if ( !m?.files ) return [];
    const parts = key.split(".");
    const needles = [key];
    for ( let i = parts.length - 1; i >= 2; i-- ) needles.push(`${parts.slice(0, i).join(".")}.`);
    const out = [];
    for ( const needle of needles ) {
      for ( const file of m.index?.[key] ?? [] ) {
        const lines = (m.files.get(file) ?? "").split(/\r?\n/);
        lines.forEach((text, i) => {
          if ( (out.length >= max) || !text.includes(needle) || out.some(o => (o.file === file) && (Math.abs(o.line - (i + 1)) <= context)) ) return;
          const from = Math.max(0, i - context);
          out.push({file, line: i + 1, lines: lines.slice(from, i + context + 1).map((t, j) => ({n: from + j + 1, text: t.slice(0, 200), hit: (from + j) === i}))});
        });
      }
      if ( out.length ) break;
    }
    return out;
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Does a text have letters or digits of its own, besides placeholders? Only such a text can be found on the page. */
function hasLiteral(text) {
  return String(text ?? "").replace(/\{[^}]+\}/g, "").replace(/[\s\p{P}\p{S}]/gu, "").length >= 2;
}

/** The key a learning run looks for: no module has it, so every window is closed again after its tabs. */
const LEARN = "stl:learn";

/** Is a tab button the active one (Foundry's tabs and the modules' own: class active, aria-selected or aria-pressed)? */
function isActiveTab(el) {
  return ["active", "is-active", "selected", "is-selected", "current"].some(c => el.classList.contains(c))
    || (el.getAttribute("aria-selected") === "true") || (el.getAttribute("aria-pressed") === "true")
    || (el.hasAttribute("aria-current") && (el.getAttribute("aria-current") !== "false"));
}

/** Tab buttons: navigation only (Foundry's tabs and the tab actions of the modules), never the tab panels themselves. */
const TAB_BUTTONS = 'nav [data-tab], [data-action="tab"][data-tab], [data-action$="Tab"][data-tab], [data-action$="tab"][data-tab]';

/**
 * The tab buttons of a window, one per group and tab.
 * @param {HTMLElement|null} el
 * @param {{elements?: boolean}} [options]   elements: with the button element (el)
 * @returns {{tab: string, group: string, action: string, el?: HTMLElement}[]}
 */
function tabsOf(el, {elements = false} = {}) {
  if ( !el?.querySelectorAll ) return [];
  const seen = new Set();
  const out = [];
  for ( const node of el.querySelectorAll(TAB_BUTTONS) ) {
    // a panel carries data-tab too: it has the class tab and no action
    if ( node.classList.contains("tab") && !node.dataset.action ) continue;
    if ( node.closest("[data-stl-self], .sephral-sample-banner") ) continue;
    const entry = {tab: node.dataset.tab, group: node.dataset.group ?? "", action: node.dataset.action ?? ""};
    const id = `${entry.group}|${entry.tab}|${entry.action}`;
    if ( seen.has(id) ) continue;
    seen.add(id);
    out.push(elements ? {...entry, el: node} : entry);
  }
  return out;
}

/** Settings menus every Sephral module has: they run an action or open another tool, never a window of module texts. */
const ACTION_MENUS = /(^|\.)(selfTest|debugFile|usageMenu|sephralsModules|translator|migrat\w*|tour\w*|reset\w*)$/i;

/** Words of a name or key for matching a key to a window ("openLines" and "STC.Lines.title" share "lines"). */
const NOISE = new Set(["open", "menu", "sephrals", "app", "application", "window", "config", "title", "name", "hint", "label",
  "scripts", "templates", "mjs", "hbs", "button", "text"]);
function wordsOf(text) {
  return new Set(String(text).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => (w.length >= 3) && !NOISE.has(w)));
}

/**
 * The kind of place a key appears in, from the code around one of its uses.
 * @param {string} file   path inside the module
 * @param {string} around   code around the key
 * @returns {string|null}
 */
function kindOf(file, around) {
  if ( /ui\.notifications\.|notify\(/.test(around) ) return "notify";
  if ( /ChatMessage|chatMessage|whisper|speaker|createMessage|\.toMessage\(/.test(around) || /(chat|card|message)[\w-]*\.(hbs|html)$/i.test(file) ) return "chat";
  if ( /DialogV2|Dialog\.|\.confirm\(|\.prompt\(|\.wait\(\{/.test(around) ) return "dialog";
  if ( /player/i.test(file) ) return "player";
  if ( /\.(hbs|html)$/.test(file) ) return "window";
  return null;
}
