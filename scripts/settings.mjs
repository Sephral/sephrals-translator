/**
 * Settings of the module. Like in every Sephral module, all options appear in Foundry's settings dialog under this
 * module, starting with the module language.
 */

import {MODULE_ID} from "./config.mjs";
import {FOLLOW_FOUNDRY, applyModuleLanguage} from "./language.mjs";
import {runSelfTest} from "./selftest.mjs";
import {openTranslator} from "./open.mjs";

/**
 * The settings of the module, in the order they appear in the settings dialog.
 * @type {Record<string, object>}
 */
export const SETTINGS = {
  uiLanguage: {type: String, default: FOLLOW_FOUNDRY, scope: "client", onChange: "language", choices: {
    [FOLLOW_FOUNDRY]: "STL.LANGUAGE.default", de: "STL.LANGUAGE.de", en: "STL.LANGUAGE.en"}},
  theme: {type: String, default: "signature", scope: "client", onChange: "redraw", choices: {
    signature: "STL.SETTINGS.theme.signature", foundry: "STL.SETTINGS.theme.foundry"}}
};

/**
 * Register all settings of the module and its menus.
 * @param {{language: Function, redraw: Function, shared: Function}} handlers
 */
export function registerSettings(handlers) {
  for ( const [key, def] of Object.entries(SETTINGS) ) {
    game.settings.register(MODULE_ID, key, {
      name: `STL.SETTINGS.${key}.name`,
      hint: `STL.SETTINGS.${key}.hint`,
      scope: def.scope ?? "world",
      config: true,
      type: def.type,
      choices: def.choices,
      default: def.default,
      onChange: def.onChange ? value => handlers[def.onChange]?.(value) : undefined
    });
  }
  game.settings.register(MODULE_ID, "acknowledgedVersions", {scope: "client", config: false, type: String, default: ""});
  // The drafts of all modules and languages with their earlier submissions (one JSON text in the browser of this user)
  game.settings.register(MODULE_ID, "drafts", {scope: "client", config: false, type: String, default: "{}"});
  // Translations in use outside the window: in this browser (module id to language), and shared by a GM with the world
  game.settings.register(MODULE_ID, "use", {scope: "client", config: false, type: String, default: "{}"});
  // The reviews this browser works on (review window), by module, language and submission time
  game.settings.register(MODULE_ID, "reviews", {scope: "client", config: false, type: String, default: "{}"});
  game.settings.register(MODULE_ID, "shared", {scope: "world", config: false, type: String, default: "{}",
    onChange: () => handlers.shared?.()});
  game.settings.registerMenu(MODULE_ID, "translator", {
    name: "STL.MENU.Title",
    label: "STL.MENU.Open",
    hint: "STL.MENU.Hint",
    icon: "fa-solid fa-language",
    type: TranslatorMenu,
    restricted: false
  });
  game.settings.registerMenu(MODULE_ID, "selfTest", {
    name: "STL.SELFTEST.Title",
    label: "STL.SELFTEST.Run",
    hint: "STL.SELFTEST.Hint",
    icon: "fa-solid fa-stethoscope",
    type: SelfTestMenu,
    restricted: true
  });
}

/** The menu button which opens the translator. It is open to every player. */
class TranslatorMenu extends foundry.applications.api.ApplicationV2 {
  /** @override */
  async render() {
    await openTranslator();
    return this;
  }
}

/** The menu button which runs the self test. Foundry only accepts application classes as menus. */
class SelfTestMenu extends foundry.applications.api.ApplicationV2 {
  /** @override */
  async render() {
    if ( game.user.isGM ) await runSelfTest();
    return this;
  }
}

/**
 * Switch the module strings when the user picks another module language, then redraw.
 * @param {string} value
 * @param {Function} redraw
 */
export function changeLanguage(value, redraw) {
  applyModuleLanguage(value).then(() => {
    redraw();
    if ( game.settings.sheet?.rendered ) game.settings.sheet.render();
  });
}
