/**
 * Opening the translator: from the settings menu, the chat command /translate and the API.
 */

import {runtime} from "./debug.mjs";
import {listModules} from "./modules.mjs";
import {TranslatorApp} from "./translator-app.mjs";
import {parseTranslateCommand} from "./translator-logic.mjs";

/**
 * Open the translator window (or bring the open one to the front).
 * @param {{module?: string, lang?: string}} [options]   A module id and a language code to start with
 * @returns {Promise<TranslatorApp>}
 */
export async function openTranslator(options = {}) {
  const open = runtime.translator;
  if ( open?.rendered ) {
    open.bringToFront?.();
    await open.switchTo(options);
    return open;
  }
  const app = new TranslatorApp({module: options.module ?? null, lang: options.lang ?? null});
  await app.render({force: true});
  await app.ready;
  return app;
}

/**
 * The chat hook for "/translate [module] [language]".
 * @param {ChatLog} chatLog
 * @param {string} message
 * @returns {boolean|void}   false stops Foundry from posting the command
 */
export function onChatMessage(chatLog, message) {
  const command = parseTranslateCommand(message, listModules());
  if ( !command ) return;
  openTranslator({module: command.module ?? undefined, lang: command.lang ?? undefined});
  return false;
}
