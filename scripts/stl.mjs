import {MODULE_ID, TESTED_VERSIONS, setting} from "./config.mjs";
import {registerDebug, runtime} from "./debug.mjs";
import {saveDebugFile} from "./debug-file.mjs";
import {registerHubModule} from "./hub.mjs";
import {applyModuleLanguage} from "./language.mjs";
import {onChatMessage, openTranslator} from "./open.mjs";
import {noticeNewVersions, runSelfTest} from "./selftest.mjs";
import {changeLanguage, registerSettings} from "./settings.mjs";
import {describeUse, onSharedChanged, registerUse} from "./use.mjs";
import {openReview} from "./review-app.mjs";

// A translation in use goes into Foundry's translations at i18nInit, before the first window is drawn
registerUse();

/** Redraw what the module shows after a language or look change. */
function redraw() {
  const app = runtime.translator;
  if ( app?.rendered ) app.render();
}

Hooks.once("init", () => {
  registerHubModule({moduleId: MODULE_ID, tested: TESTED_VERSIONS});
  registerSettings({
    language: value => changeLanguage(value, redraw),
    redraw,
    shared: onSharedChanged
  });
  // No usage statistics: this module makes no network requests at all
  registerDebug();
  game.modules.get(MODULE_ID).api = {
    /**
     * Open the translator (a module id and a language code are optional).
     * @param {{module?: string, lang?: string}} [options]
     */
    open: options => openTranslator(options ?? {}),
    /** The open translator window, or null. */
    get app() {
      return runtime.translator;
    },
    /**
     * Open the review of a submission file (the parsed JSON of the file a translator handed in).
     * @param {object} data
     */
    review: data => openReview(data),
    /** The open review window, or null. */
    get reviewApp() {
      return runtime.review;
    },
    /** The translations in use in this browser (module, language, source, number of texts). */
    get inUse() {
      return describeUse();
    },
    /** Check the module. */
    runSelfTest,
    /** Save the debug file of Sephral's modules (GM). */
    saveDebugFile: messageId => saveDebugFile(messageId ?? null, {moduleId: MODULE_ID})
  };
});

/** Applying a fixed module language loads its file; the rest of "ready" waits for it. */
let languageReady = Promise.resolve();

Hooks.once("i18nInit", () => {
  languageReady = applyModuleLanguage(setting("uiLanguage"));
});

/** The chat command /translate [module] [language] opens the translator. */
Hooks.on("chatMessage", onChatMessage);

Hooks.once("ready", async () => {
  await languageReady;
  noticeNewVersions();
});
