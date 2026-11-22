/**
 * Self test: what the module relies on in Foundry, its storage and its texts.
 */

import {MODULE_ID, TESTED_VERSIONS, esc, t} from "./config.mjs";
import {listModules} from "./modules.mjs";
import {CHECKS_LIB_VERSION, checkValue, safeMergeTranslations, sourceHash} from "./translate-checks.mjs";
import {normalizeLang, parseImport} from "./translator-logic.mjs";
import {DISCORD_URL} from "./translator-logic.mjs";

/**
 * Run all checks.
 * @returns {Promise<{problems: string[], checks: number}>}
 */
async function checkAll() {
  const problems = [];
  let checks = 0;
  const check = (ok, key, data) => {
    checks++;
    if ( !ok ) problems.push(game.i18n.has(key) ? t(key, data) : key);
  };
  check(typeof foundry.applications?.api?.DialogV2 === "function", "STL.SELFTEST.Dialog");
  check(typeof foundry.applications?.api?.HandlebarsApplicationMixin === "function", "STL.SELFTEST.Handlebars");
  check(typeof foundry.utils?.saveDataToFile === "function", "STL.SELFTEST.Save");
  check(Number.isInteger(CHECKS_LIB_VERSION) && checkValue("Send {count}", "Sende {count}").errors.length === 0
    && checkValue("Send {count}", "Sende").errors.length === 1, "STL.SELFTEST.Checks");
  check(sourceHash("hello") === sourceHash("hello") && /^[0-9a-f]{8}$/.test(sourceHash("hello")), "STL.SELFTEST.Hash");
  // The merge writes into a copy, never into the live strings
  const probe = {Probe: {Item: {text: "a"}}};
  const applied = safeMergeTranslations(probe, ["Probe"], new Map([["Probe.Item.text", "b"], ["__proto__.x", "c"], ["Other.y", "d"]]));
  check((applied.length === 1) && (probe.Probe.Item.text === "b") && !({}).x && !probe.Other, "STL.SELFTEST.Merge");
  check(normalizeLang("pt_br") === "pt-BR" && normalizeLang("../x") === null, "STL.SELFTEST.Language");
  const own = await fetch(new URL("../lang/en.json", import.meta.url)).then(r => (r.ok ? r.json() : null)).catch(() => null);
  check(!!own && parseImport(JSON.stringify(own), own, "de").ok, "STL.SELFTEST.OwnFile");
  check(!!game.modules.get(MODULE_ID)?.api?.open && listModules().length > 0, "STL.SELFTEST.Modules");
  check(!!game.settings.settings.has(`${MODULE_ID}.drafts`) && DISCORD_URL.startsWith("https://"), "STL.SELFTEST.Storage");
  const keys = ["STL.gear", "STL.SELFTEST.Title", "STL.Title", "STL.Window.module", "STL.Check.placeholder-mismatch", "STL.State.live"];
  const missing = keys.filter(key => !game.i18n.has(key));
  check(!missing.length, "STL.SELFTEST.Texts", {keys: missing.join(", ")});
  return {problems, checks};
}

/**
 * Run the self test and report the result.
 * @param {object} [options]
 * @param {boolean} [options.report=true]
 * @returns {Promise<{problems: string[], checks: number}>}
 */
export async function runSelfTest({report = true} = {}) {
  const {problems, checks} = await checkAll();
  const summary = problems.length ? t("STL.SELFTEST.Problems", {problems: problems.length, checks})
    : t("STL.SELFTEST.Passed", {checks});
  if ( problems.length ) ui.notifications.warn(summary, {permanent: true});
  else ui.notifications.info(summary);
  if ( report ) {
    const versions = t("STL.SELFTEST.Version", {current: game.version, tested: TESTED_VERSIONS.core});
    let content = `<h3>${esc(t("STL.SELFTEST.Title"))}</h3><p>${esc(summary)}</p><p><small>${esc(versions)}</small></p>`;
    if ( problems.length ) content += `<ul>${problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul>`;
    await ChatMessage.implementation.create({content, whisper: [game.user.id],
      speaker: {alias: game.modules.get(MODULE_ID).title}});
  }
  return {problems, checks};
}

/**
 * Tell the GM once when Foundry is newer than the version the module was verified against.
 */
export function noticeNewVersions() {
  if ( !game.user.isGM ) return;
  if ( !foundry.utils.isNewerVersion(game.version, TESTED_VERSIONS.core) ) return;
  const signature = `core ${game.version}`;
  if ( game.settings.get(MODULE_ID, "acknowledgedVersions") === signature ) return;
  game.settings.set(MODULE_ID, "acknowledgedVersions", signature);
  ui.notifications.info(t("STL.SELFTEST.NewVersions", {versions: signature}), {permanent: true});
}
