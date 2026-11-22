/**
 * Constants and small helpers shared by the scripts of the module. The module runs on Foundry 13 and 14, so it uses
 * game.i18n instead of the v14 global _loc.
 */

/** The id of this module. */
export const MODULE_ID = "sephrals-translator";

/** The folder of the module's templates. */
export const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** The Foundry versions the module was verified against (see the self test). */
export const TESTED_VERSIONS = {core: "14.370"};

/**
 * Read a setting of this module.
 * @param {string} key
 * @returns {*}
 */
export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * Localize a key, with optional data. A count of one takes the singular wording (the same key with "One")
 * when the current language has it, so no message says "1 texts".
 * @param {string} key
 * @param {object} [data]
 * @returns {string}
 */
export function t(key, data) {
  if ( !data ) return game.i18n.localize(key);
  const one = (data.count === 1) && game.i18n.has(`${key}One`, false);
  return game.i18n.format(one ? `${key}One` : key, data);
}

/**
 * Localize a key in English, whatever the interface language: the texts a translator or reviewer posts on Discord or
 * GitHub are read by people of every language. A count of one takes the singular wording like t().
 * @param {string} key
 * @param {object} [data]
 * @returns {string}
 */
export function tEnglish(key, data = {}) {
  const source = (game.i18n.lang === "en") ? game.i18n.translations : (game.i18n._fallback ?? game.i18n.translations);
  const get = k => foundry.utils.getProperty(source, k);
  let text = ((data.count === 1) && (typeof get(`${key}One`) === "string")) ? get(`${key}One`) : get(key);
  if ( typeof text !== "string" ) text = t(key, data);
  return text.replace(/\{([^}]+)\}/g, (match, name) => ((name in data) ? String(data[name]) : match));
}

/**
 * Escape a value for HTML.
 * @param {*} value
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;",
    "'": "&#39;"})[ch]);
}

/**
 * Is a window open or on its way? While an application renders, its "rendered" flag is false, and a redraw asked
 * for in that moment would be lost.
 * @param {ApplicationV2|undefined} app
 * @returns {boolean}
 */
export function isShown(app) {
  const states = foundry.applications.api.ApplicationV2.RENDER_STATES;
  return !!app && ((app.state === states.RENDERED) || (app.state === states.RENDERING));
}

/**
 * Open Foundry's settings on the tab of this module.
 */
export async function openSettings() {
  const sheet = game.settings.sheet;
  await sheet.render({force: true});
  try {
    sheet.changeTab(MODULE_ID, "categories");
  } catch(err) {
    console.warn(`${MODULE_ID} | The settings have no tab for this module`, err);
  }
  sheet.bringToFront?.();
}

/**
 * Put a gear into the title bar of a window that opens the settings of this module.
 * @param {HTMLElement} frame   The window frame
 */
export function addSettingsGear(frame) {
  const header = frame?.querySelector(".window-header");
  if ( !header || header.querySelector(".stl-settings") ) return;
  const gear = document.createElement("button");
  gear.type = "button";
  gear.className = "header-control icon fa-solid fa-gear stl-settings";
  gear.dataset.tooltip = t("STL.gear");
  gear.setAttribute("aria-label", t("STL.gear"));
  gear.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    openSettings();
  });
  const anchor = header.querySelector("[data-action=toggleControls]") ?? header.querySelector("[data-action=close]");
  if ( anchor ) anchor.before(gear);
  else header.append(gear);
}
