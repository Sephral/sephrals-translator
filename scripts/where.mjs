/**
 * Where a text shows and how to get there, shared by the translator and the review window: the hint under the badge,
 * the label of the open button (or none when nothing can open it), and the search for the window that shows it.
 */

import {t} from "./config.mjs";
import {SIMULATED, sampleText} from "./translator-logic.mjs";
import {needsOf, needsText} from "./modules.mjs";

/**
 * The hint and the open button for a key in a state.
 * @param {import("./preview.mjs").LivePreview} preview
 * @param {string} moduleId
 * @param {string} key
 * @param {string} state   from stateOf
 * @returns {{hint: string, open: string|null}}   open: the label of the open button, null hides it
 */
export function describeWhere(preview, moduleId, key, state) {
  // the code of the module, the last fallback when nothing shows the text in its place
  const code = preview.hasCode(moduleId, key);
  if ( state === "reload" ) return {hint: t("STL.State.reloadHint"), open: null, code};
  if ( state !== "open" ) return {hint: t(`STL.State.${state}Hint`), open: null, code: false};
  // a module that cannot run in this world opens no window here: say why, the code still shows where the text is used
  const needs = needsOf(moduleId);
  if ( needs ) return {hint: t("STL.Needs.hint", {needs: needsText(needs, t)}), open: null, code};
  const setting = preview.settingOf(moduleId, key);
  if ( setting?.gmOnly ) return {hint: t("STL.Where.gmSetting"), open: null, code};
  if ( setting ) return {hint: t("STL.State.settingHint"), open: t("STL.Detail.openSettings"), action: "window", code: false};
  // a notification, a chat message or a question: shown as an example, only in this browser. A window of the module
  // that showed it before comes first, and a chat message is looked for in the sample windows of the module (with the
  // example as the fallback).
  // the name of a sample window: it shows in the field Sample windows above
  if ( !preview.knownWindow(moduleId, key) && preview.isSampleLabel(moduleId, key) ) return {hint: t("STL.Samples.labelHint"), open: null, code: false};
  const kind = preview.whereOf(moduleId, key);
  const known = preview.knownWindow(moduleId, key);
  if ( SIMULATED.includes(kind) && !known ) {
    return {hint: t(`STL.Simulate.${kind}Hint`), open: t("STL.Detail.simulate"), action: "simulate", kind, code: false};
  }
  if ( (kind === "chat") && known ) return {hint: t("STL.Samples.chatHint"), open: t("STL.Detail.openWindow"), action: "window", kind, code: false};
  if ( preview.noWindow(moduleId, key) ) return {hint: t(`STL.Where.${kind}`), open: null, code};
  return {hint: t("STL.State.openHint"), open: t("STL.Detail.openWindow"), action: "window", code: false};
}

/**
 * Open the window (or the settings) that shows a key, outline the text there and word the result.
 * @param {import("./preview.mjs").LivePreview} preview
 * @param {string} moduleId
 * @param {string} key
 * @param {HTMLButtonElement} button   disabled while searching
 * @param {HTMLElement|null} textEl     shows that the search runs
 * @returns {Promise<{how: string|null, kind?: string, message?: string}>}
 */
export async function openWhereShown(preview, moduleId, key, button, textEl) {
  if ( button.dataset.action === "simulate" ) {
    const shown = await simulate(preview, moduleId, key);
    return {how: shown ? "example" : null, kind: preview.whereOf(moduleId, key), message: shown ? t("STL.Simulate.shown") : t("STL.Simulate.failed")};
  }
  button.disabled = true;
  if ( textEl ) textEl.textContent = t("STL.State.searching");
  // the windows the search opens go beside the translator, so neither hides the other
  const self = button.closest(".application");
  let found;
  try {
    found = await preview.findWindow(moduleId, key, {place: el => self && placeBeside(el, self)});
    if ( found.how ) {
      await preview.usageByRender(moduleId);
      let result = preview.highlight(moduleId, key, {sticky: true, pulse: true, reveal: true});
      const place = preview.marked?.find(el => preview.isShownEl(el));
      if ( place && self && placeBeside(place, self) ) {
        await new Promise(resolve => setTimeout(resolve, 150));
        result = preview.highlight(moduleId, key, {sticky: true, pulse: false, reveal: true});
      }
      if ( !result.shown ) found.message = t("STL.State.openedHidden");
      else if ( found.how === "settings" ) found.message = t("STL.State.inSettings");
      else if ( found.sample ) found.message = t("STL.Samples.shown", {count: result.shown});
      else found.message = t("STL.State.shown", {count: result.shown});
    }
    // a chat message, notification or question no window shows: the example instead
    else if ( SIMULATED.includes(found.kind) && await simulate(preview, moduleId, key) ) {
      found = {how: "example", kind: found.kind, message: t("STL.Simulate.shown")};
    }
  } catch(err) {
    console.warn(`sephrals-translator | looking for the window of ${key} failed`, err);
    found = {how: null, kind: "unknown"};
  } finally {
    button.disabled = false;
  }
  return found;
}

/** The example chat message on screen, removed by the next example or after a while. */
let example = null;

/**
 * Show a text in the kind of place it appears in, only in this browser: a notification, a chat message (rendered,
 * never saved, in the chat log or a small window when the chat is not open) or a question. Placeholders get sample values.
 * @param {import("./preview.mjs").LivePreview} preview
 * @param {string} moduleId
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function simulate(preview, moduleId, key) {
  const kind = preview.whereOf(moduleId, key);
  const title = game.modules.get(moduleId)?.title ?? moduleId;
  const text = sampleText(preview.mods.get(moduleId)?.current.get(key) ?? "", {module: title});
  if ( !text.trim() ) return false;
  try {
    example?.remove?.();
    example = null;
    if ( kind === "notify" ) {
      ui.notifications.info(text, {localize: false});
      return true;
    }
    if ( kind === "dialog" ) {
      foundry.applications.api.DialogV2.prompt({window: {title}, content: `<p>${text}</p>`, ok: {label: "OK"}, rejectClose: false}).catch(() => {});
      return true;
    }
    if ( kind === "chat" ) {
      const Message = getDocumentClass("ChatMessage");
      const message = new Message({content: `<p>${text}</p>`, speaker: {alias: title}, author: game.user.id, user: game.user.id});
      const rendered = (typeof message.renderHTML === "function") ? await message.renderHTML() : (await message.getHTML())?.[0];
      if ( !rendered ) return false;
      rendered.classList.add("stl-example");
      const log = ui.chat?.element?.querySelector?.(".chat-log");
      if ( log && (log.getClientRects().length > 0) ) {
        log.append(rendered);
        rendered.scrollIntoView({block: "end"});
        example = rendered;
      }
      else {
        const holder = document.createElement("ol");
        holder.className = "chat-log stl-example-log";
        holder.append(rendered);
        foundry.applications.api.DialogV2.prompt({window: {title: t("STL.Simulate.chatTitle")}, content: holder.outerHTML, ok: {label: "OK"}, rejectClose: false}).catch(() => {});
      }
      setTimeout(() => {
        if ( example === rendered ) {
          rendered.remove();
          example = null;
        }
      }, 30000);
      return true;
    }
  } catch(err) {
    console.warn(`sephrals-translator | the example of ${key} failed`, err);
  }
  return false;
}

/**
 * Show where a key is used in the code of the module: file, line and a few lines around it, the key line marked.
 * @param {import("./preview.mjs").LivePreview} preview
 * @param {string} moduleId
 * @param {string} key
 * @param {HTMLElement} box
 */
export function renderCode(preview, moduleId, key, box) {
  const snippets = preview.codeFor(moduleId, key);
  const nodes = [document.createElement("p")];
  nodes[0].className = "stl-code-hint";
  nodes[0].textContent = snippets.length ? t("STL.Code.hint") : t("STL.Code.none");
  for ( const snippet of snippets ) {
    const figure = document.createElement("figure");
    figure.className = "stl-snippet";
    const caption = document.createElement("figcaption");
    caption.textContent = `${snippet.file}:${snippet.line}`;
    const pre = document.createElement("pre");
    for ( const line of snippet.lines ) {
      const row = document.createElement("span");
      row.className = line.hit ? "stl-code-line stl-code-hit" : "stl-code-line";
      row.textContent = `${String(line.n).padStart(4)}  ${line.text}`;
      pre.append(row);
    }
    figure.append(caption, pre);
    nodes.push(figure);
  }
  box.replaceChildren(...nodes);
}

/** The narrowest a window gets beside the translator (px). */
const MIN_BESIDE = 420;

/**
 * Move the window around an element next to the translator's window when the two overlap: to the side with room, a
 * resizable window too wide for both sides narrower on the side with more room, else against the screen edge on that side.
 * @param {HTMLElement} el     an element in the window to move
 * @param {HTMLElement} self   the translator's or the review's window
 * @returns {boolean}   whether the window moved
 */
export function placeBeside(el, self) {
  const frame = el.closest(".application, .app");
  if ( !frame || (frame === self) || self.contains(frame) ) return false;
  const app = [...foundry.applications.instances.values(), ...Object.values(ui.windows ?? {})]
    .find(a => ((a.element instanceof HTMLElement) ? a.element : a.element?.[0]) === frame);
  // only windows with a frame move, never the sidebar, the controls or other parts of the interface
  const framed = (app instanceof foundry.applications.api.ApplicationV2) ? app.hasFrame : !!app?.popOut;
  if ( !framed || app.minimized || (typeof app.setPosition !== "function") ) return false;
  const a = frame.getBoundingClientRect();
  const b = self.getBoundingClientRect();
  const overlap = (a.right > b.left) && (a.left < b.right) && (a.bottom > b.top) && (a.top < b.bottom);
  if ( !overlap ) return false;
  const gap = 8;
  const roomRight = window.innerWidth - b.right - gap;
  const roomLeft = b.left - gap;
  const top = Math.max(0, Math.min(a.top, window.innerHeight - a.height));
  let left;
  if ( roomRight >= a.width ) left = b.right + gap;
  else if ( roomLeft >= a.width ) left = b.left - gap - a.width;
  else {
    // too wide for either side: a window that can be resized gets narrower beside the translator, so both stay readable
    const resizable = (app instanceof foundry.applications.api.ApplicationV2) ? !!app.options?.window?.resizable : !!app.options?.resizable;
    const room = Math.max(roomRight, roomLeft);
    if ( resizable && (room >= MIN_BESIDE) ) {
      left = (roomRight >= roomLeft) ? b.right + gap : 0;
      app.setPosition({left: Math.round(left), top: Math.round(top), width: Math.floor(room)});
      return true;
    }
    left = (roomRight >= roomLeft) ? Math.max(0, window.innerWidth - a.width) : 0;
  }
  app.setPosition({left: Math.round(left), top: Math.round(top)});
  return true;
}
