/**
 * Translator' part of the debug file of Sephral's modules. Fill describeState with what helps a bug report, without
 * personal texts.
 */

import {MODULE_ID, t} from "./config.mjs";
import {DebugTrace, registerDebugMenu, registerDebugProvider} from "./debug-file.mjs";

/** The open translator window, set by the window itself. */
export const runtime = {translator: null, review: null};

/** The recent decisions of the module. */
export const trace = new DebugTrace();

/**
 * What the module knows right now.
 * @returns {object}
 */
export function describeState() {
  // Counts only, never the texts of the translator
  const state = runtime.translator?.describe?.() ?? null;
  return {open: !!runtime.translator, module: state?.module ?? null, lang: state?.lang ?? null, counts: state?.counts ?? null,
    coverage: state?.coverage ?? null};
}

/**
 * The button in the settings and the module's part of the file. Call in "init".
 */
export function registerDebug() {
  registerDebugMenu(MODULE_ID, {name: "STL.DEBUG.Title", label: "STL.DEBUG.Save", hint: "STL.DEBUG.Hint"});
  registerDebugProvider({
    moduleId: MODULE_ID,
    label: () => t("STL.DEBUG.Entry"),
    notice: file => t("STL.DEBUG.Saved", {file}),
    recent: () => ({details: describeState()}),
    trace
  });
}
