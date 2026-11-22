# Sephral’s Translator: Manual

Translator is a window in which anybody can translate a module by Sephral into their language and see the result at once in the real windows of that module. This page is the technical reference.

## Settings

All settings belong to this device.

* *Module language* follows Foundry’s language, or forces German or English for Translator’s own windows.
* *Look* switches the windows between warm paper (Signature) and dark (Foundry).
* *Open translator* (a settings menu, open to every player, not only to the GM) opens the window.
* *Self test* (GM) and *Save debug file* are the usual buttons of every Sephral module.

The drafts are kept in a hidden client setting (`drafts`), see Drafts below. Two more hidden settings say where a translation is used outside the window: `use` (client, module id to language) and `shared` (world, written by a GM), see Using a translation below.

## Opening the translator

* The button *Open translator* in the module settings.
* The chat command `/translate [module] [language]`. Both words are optional and may come in either order. A module is found by its id (`sephrals-roll-requests`), the short id (`roll-requests`) or a part of its title, a language by its code. `/translate tavern pt-BR` opens Tavern Games for Brazilian Portuguese. Foundry 14 hands the HTML of its chat editor to the hook, Translator reads only the text of it.
* The API: `game.modules.get("sephrals-translator").api.open({module, lang})`. When the window is open it switches to the module and language.

## The window

The top row has the module picker (the installed and active modules of Sephral, each with its progress in words for the chosen language), the language and the progress bar. The language is picked from a list: about 40 languages Foundry communities translate into (with the codes Foundry modules use, `cn` for simplified Chinese, `zh-TW` for traditional), the languages Foundry knows in this world and the ones the module ships. Each is named in the interface language and in itself, followed by its code, and a ✓ marks the languages the module already comes with. English, the source language, is not offered. *Other language...* opens a field for any other code of letters with an optional region (`es-419`). Anything else is refused there with a message. The default is the language of Foundry, unless that is English.

The list on the left shows the texts of the module. Each text has a key, its name in the language file (for example `SRR.Window.Title`). The list has a filter by status, a search in keys, English texts, translations and the German texts, and a group picker (the second part of the key). Every row shows its status:

| Status | Meaning |
| --- | --- |
| Open | nothing typed yet, Foundry shows the English text |
| Done | a translation without errors or warnings |
| To check | marked by the translator with *Mark this text as to be checked* |
| English changed | the English text is not the one the translation was written for |
| Warning | for example a text much longer than the English one |
| Error | the text breaks a hard rule, see Checks |

The pane on the right shows the key, a recommended length (the length of the English text), the English text, the German text for orientation (when the module has one and the language is not German), the field for the translation, buttons that insert the placeholders of the English text at the cursor, the checks, hints and the preview state. A text with a count (`{count}`, `{n}`, `{total}`) shows a hint to word it so it reads right for one and for many.

If the module already ships a file for the chosen language, it is loaded as the starting point (after a check like an import) when there is no draft yet.

While no text is selected, the pane shows the short way through: pick a text, type, Ctrl+Enter to the next one, submit.

### Moving through the texts

* **Ctrl+Enter** (Cmd+Enter on a Mac) in the field, or the button *Next open text*, selects the next text that still wants work (open, error, English changed, to check) in the order of the list, wrapping around. When the list has none left, the next one of the whole module is taken and a filter or search that hides it is reset. The cursor stays in the field.
* **Alt+Up / Alt+Down** in the field select the previous or next text of the list.
* **Up / Down** in the list move the selection, **Enter** puts the cursor into the field.
* When the last text of the module is translated, the report line says so once and points to *Submit*.

### Picking a text on screen

The crosshair next to the search starts picking: the next click on a text anywhere in Foundry selects its key in the list (a dashed frame shows what is under the pointer). The click only picks, it does not press the button or open the sheet it lands on. Escape or a second click on the crosshair stops. Translator compares the text of the element, its tooltip and label, the chosen option of a select, then its parents (up to three levels) with the current texts of the module, whole texts first. A text of another module or of Foundry itself is not picked, the report line says so. When several keys have the same words, the first is selected and the report line says how many.

### Earlier translations of the same English

Under the field, *Already translated elsewhere* offers up to three translations people already made for the same English text: other texts of this module, drafts of other modules in this browser and the files the modules ship in the language (read once per language in the background). *Use* puts one into the field. This is the work of people, never a machine translation.

When the text just typed has the same English as other texts of the module that have no translation yet, *Use there too* gives them the same text (for words like *Close* or *too much* that appear in several places).

## Live preview

Texts are written into `game.i18n.translations` of this browser only. Nothing is saved to the module files, nothing is sent to other clients. Only the keys that change are written, with a hardened merge (`safeMergeTranslations` of the shared checks library: flat list, only inside the namespace of the chosen module, `__proto__`, `constructor` and `prototype` skipped, no recursive merge). An empty field shows the English text. A text with an error that could act as markup (tags, entities, template braces, links, control or invisible characters) stays out of the preview, because `ui.notifications` inserts text as HTML.

After the last key stroke (200 ms) the window draws again what shows the old text: the windows of the module that contain it, the scene controls, the chat messages, then an in place patch for what no render rebuilds (open context menus, toasts, cards built by hand). The translator’s own windows are never drawn again, so focus and cursor stay in the field. The window title is updated after a render, the label and hint a setting copied into its DataField are reset, the scene controls are rebuilt with `reset`, chat messages with `ui.chat.updateMessage`.

Per key the window shows one of four states:

* **Live** the text is on screen now (found in the page) or an open window looked it up. It changes while you type.
* **Live on the map** the module draws the text on the canvas, redraws it on the refresh hook and names the key through `api.translatorRefreshKeys` (see below), and a scene is open. It changes on the map while you type, wherever the map shows it. *Show this text* is off for these keys, the page does not contain canvas text.
* **Open to see** not on screen right now (the first time you select such a key, Translator draws the open windows of the module once to learn which keys they look up, a window loses unsaved input then). A window that looked a key up counts only while it is open. The button below depends on where the text lives:
  * a setting of the module (its name, hint or one of its choices) or a settings menu: *Open settings* opens Foundry's settings on the tab of the module. A world setting a player may not change gets a hint instead of the button.
  * else *Open window* looks for the window: first the one that showed the key before, then the ways the module offers to open a window: its sample windows (see below), functions of its API whose name starts with `open` and that need no argument, and its settings menus except the self test, the debug file and the other action menus. The best name match comes first ("Lines" for `STC.Lines.title`), on a tie a sample window. Each one runs while the keys it looks up are recorded. When the key is not on screen yet, the tabs of the new window are clicked one by one (only tab buttons, they change nothing), and the tab that showed it is remembered. A window that does not show the key is closed again. What was learned is kept for the session, so the next text of the same window opens at once, on its tab.
  * a text the code shows in a notification, a chat message or a question gets *Show an example* instead (a chat text of a module with sample windows is looked for there first, *Open window* falls back to the example): the text appears in that kind of place, only in this browser, with sample values in its placeholders (`{count}` 3, `{name}` Ada, `{module}` the module). The notification is a real one, the question a real dialog, the chat message is rendered like a real one into the chat log (or a small window when the chat is not open) and never saved, it goes after 30 seconds.
  * when no window shows the text on its own, the button goes and a hint says where the text appears, from the code around the key: a window only players see, a window the module opens only in certain situations, or no hint at all. Once every way to open a window was tried, such texts get the hint at once.
  * the last fallback, for such texts and for texts that show after a reload: *Show the code* shows where the module uses the key, up to three places with file, line and three lines around it, the line with the key marked. A key built from parts is found by its prefix. This needs the file browser like the states above (GMs and trusted players).
* **After reload** Foundry fixes the text at start (self test, debug and language files, canvas labels) and the module does not redraw it on the refresh hook (see below). Estimated from the files of the module, which the file browser may list (GMs and trusted players). Without that right every key that is not on screen is shown as *open to see*.

### Sample windows

Where a module cannot show a window, card or state out of the box (no fight, no photos, no votes yet), Sephral's modules offer sample windows: real windows of the module filled with made-up data that is held in memory. Nothing in them is saved, sent or counted, buttons that would change something only say so, and a banner on top marks them. The field *Sample windows* in the header lists those of the chosen module, grouped; choosing one opens it next to the translator and outlines the selected text in it. *Open window* uses them too. A module offers them through `api.samples()` (`[{id, label, group, open}]`).

### Modules that cannot run in this world

A module of Sephral made for another game system, or one that needs a module that is not active here (Crucible Combat Pulse and Crucible Sheet & Quickbar need the system Crucible, Lunar Almanac and Vista Portrait Switcher the module Ember), shows no window in this world. Installed modules that need a missing module are in the module list with *needs the module ...*: a notice above the texts says that they can be translated and handed in, but not seen in place, and the hint of every text says the same instead of looking for a window (*Show the code* still works). Modules made for another game system are left out of the world by Foundry itself; the translator finds them through the file browser (GMs and trusted players) and lists them at the end under *Only in another world*, not selectable. Open the translator in a world that has what they need.

The selected text is outlined wherever it shows, as long as it is selected, and the outline follows windows that are drawn again or opened later. A short text (below 12 characters) counts only as a whole text, so *Story* is not found inside every longer text. *Show this text* (only offered when there is a place to show) also switches to a hidden tab, opens a closed section, brings back a minimized window and scrolls the place into view. *Open window*, *Open settings* and *Show this text* move a window that overlaps the translator next to it, to the side with room, so neither hides the other.

When the user changes the *Module language* of the module being translated, the module loads its file again and overwrites the preview. Translator notices that (a poll every 1.5 seconds and the setting hook), takes the new clean strings as the snapshot and applies the draft again. Closing the translator, or switching to another module or language, puts the strings back that were in memory before the first change and draws the affected windows again.

Hook for modules with texts that no re-render reaches (labels drawn on the canvas, strings cached at start): `Hooks.on("sephrals-translator.refresh", ({module, moduleId, namespace, roots, keys}) => ...)`. It is called after every applied preview change (debounced, with the changed keys) and once after the preview is put back on close or switch (with all keys of the module). `keys` are full keys like `SMP.Player.privateOf`. A module that listens announces it with `game.modules.get(id).api.translatorRefresh = true`. Translator then no longer shows its keys as *After reload*, but as *Live* or *Open to see*. A module that also offers `api.translatorRefreshKeys = key => boolean` names the keys it draws on the canvas, Translator shows them as *Live on the map* while a scene is open. The listener should redraw only the objects its keys affect and stay inert when the translator is absent (the hook is never called then). Sephral’s Map Pins, Token Wardrobe and Map Knowledge listen.

## Using a translation

The picker *Use* in the footer says where the translation of the chosen module and language counts:

| Choice | Effect |
| --- | --- |
| Only while this window is open | the preview: closing the translator brings back the module's usual texts |
| Always, in my Foundry | this browser uses the stored draft from now on, also after a reload. Only this user sees it (client setting `use`, module id to language) |
| For everyone in this world (GM) | a copy of the texts goes into the world setting `shared`, every browser in the world uses it. Later changes are copied when the GM closes the translator or switches the module |

Only texts without errors are used, checked again in every browser against the English text Foundry loaded, and only keys under the module's namespace (a short prefix like `SRR`, `FOLIO` or `scbr`) that have an English text. One module uses one language: choosing *Always* for another language replaces the first.

Order per module: the user's own choice first, then the shared one. The shared one is not used where the user picked a fixed language for that module (its *Module language* setting is not *Follow Foundry*). A player sees in the picker when the GM shares a translation and can choose *Always, in my Foundry* to use an own one.

When it is applied: at `i18nInit`, right after Foundry loaded its translations, so the first window drawn already shows the texts. At `ready` the texts are put back if a module loaded its own language file over them, and again when the *Module language* of a module changes. A change of the world setting is applied at once in every browser (windows drawn from then on show it, the refresh hook tells modules that draw on the canvas), fully after a reload. While the translator has a module open, the window decides. When it closes, the texts in use stay and the others go back to what Foundry showed before.

`api.inUse` lists what this browser uses (module, language, source, number of texts).

## Checks

All checks come from `scripts/translate-checks.mjs`, a shared checks library of Sephral’s modules. They run while you type and show their result next to the field. Hard errors: a different set of placeholders (`{name}`, `{{x}}`, `%s`), tags that differ from the English ones, `<` or `>` without a tag in English, entities, template braces and Foundry links (`@UUID[...]`, `[[...]]`) that differ, web addresses that are not in the English text, control, bidirectional override and invisible characters, texts over 10000 characters. Warnings: identical to English, much longer or shorter, spaces at the edges, a script that does not fit the language, semicolons and dashes. The messages are localized by their code (`STL.Check.<code>`).

A pseudo localization such as `[[Send]]` is an enricher in Foundry’s syntax and therefore an error. For tests use `«Send»` or `XX Send XX`.

## Drafts

The draft of a module and language is saved after every change (700 ms later) and when the window closes, in the client setting `drafts` (one JSON text for all modules and languages). Every access is in try/catch, the window works when browser storage is empty or blocked. Per translated key the draft keeps the 8 hexadecimal characters of the source hash (FNV-1a of the English text, `sourceHash`), the English text of that time, and the review mark. A stored draft is reduced to valid keys, texts and hashes when it is read.

When the English text of a key changed, the row shows *English changed*, and the pane shows the old English text next to the new one. *My translation still fits* stores the new hash. The reliable backup is the export.

The draft also keeps the earlier submissions of the module and language (`history`, newest first): time, module version, the way (Discord or GitHub) and the number of texts. The texts that were submitted are kept for the newest three, the list holds ten. While there is a submission with texts, the filter *Changed since submitted* lists the keys whose text differs from it (changed, added or no longer translated), and the pane shows the submitted text above the field when it differs.

## Export and import

*Export JSON* saves `lang/<code>.json` with the nesting and order of `en.json` and only the translated keys. Keys with errors are left out and listed in the line above the footer.

*Import* takes a file with the file picker or by drag and drop onto the window: a language file, a submission file of the translator (see Submit, one of another module is refused) or a review file (see Review). The file is checked like a hostile input: it must be a JSON object under 2 MB, keys must exist in the English file, every text goes through the checks, texts with errors are rejected one by one and listed, `__proto__`, `constructor` and `prototype` entries are skipped. Accepted texts are merged into the draft. The report is shown as text.

## Submit

Translations are submitted on Sephral’s Discord server, in the channel `#translations` (`DISCORD_URL` and `DISCORD_CHANNEL` in `scripts/translator-logic.mjs`), or as an issue on the module’s GitHub page (from `bugs` or `url` of its `module.json`, only `https://github.com/...`). The module sends nothing itself and has no server. Your browser saves the file, you post it.

*Submit...* opens the dialog. It starts with the one rule: translations are made by hand, machine translation and AI tools are not allowed, not even for a draft (Foundry VTT's policy on AI generated content applies to everything that ships with a module). It needs two checkboxes (every text translated by hand by the translator or people working with them, no machine translation and no AI, and the licence to publish and adapt it) and a choice for the credits: *Credit me as* with a name (typing a name picks it) or *Keep me anonymous* (then no name goes into the file or the message). A note is optional. Name (60 characters) and note (500) may have no line break and no web address. A line under the form says what is still missing while the two buttons are off. Texts with errors block handing in. When nothing changed since the last submission, a line says so (handing in again is allowed). Below the intro, *Open directly* has links to Sephral's Discord and the issues of the module on GitHub.

*Submit on Discord* and *Submit on GitHub* then:

1. save the submission file `<module>-<lang>-<date>-<time>.json` (in the downloads),
2. put the text of the message into a field and copy it (browsers allow copying only on https or localhost, otherwise the text is selected to copy by hand),
3. open Discord (the server invite) or the new issue page of the module with title and text filled in, in a new tab,
4. show the steps: join the server (the first time: confirm the rules with ✅ in `#start-here` and pick your language in `#pick-your-languages`, only then `#translations` shows), open `#translations`, drag in the file and paste the text, or drag the file into the issue and click Create.

After handing in, a link to the page (Discord or the prefilled issue page) is shown as text and as the button *open again*: real links, so they work where the browser blocked the new tab. The message is always in English, whatever the language of Foundry, so everyone in the channel or the issue can read it. It names the module, its version, the language and the number of texts, repeats the two confirmations, the credit (*Credit as: name* or *Credit: anonymous*) and the note when given. The submission file:

```json
{"format": "sephrals-translation", "v": 1, "module": "sephrals-roll-requests", "moduleVersion": "1.0.6", "lang": "ru",
 "createdAt": "2026-11-22T10:00:00.000Z", "credit": {"name": "optional"},
 "attest": {"reviewed": true, "license": true, "machine": "none"}, "consent": "t1", "note": "",
 "keys": {"SRR.Window.Title": "..."}, "src": {"SRR.Window.Title": "a1b2c3d4"}}
```

`src` holds the hash of the English text each translation was written for, so the reviewer sees which texts went stale. `attest.machine` is always `none`. Sephral reads this file when reviewing the translation. *Import* takes it back. The file holds your texts, the module and its version, the language, the time, and your name and note if you gave them. Nothing else.

*Your submissions* below the form lists the earlier submissions of this module and language (see Drafts) with *Save as file* while the texts are kept. To change or withdraw a submission, write in the channel or the issue.

## Review

The first translation of a module into a language is read by a reviewer, a second person who speaks the language. The Translator helps both sides.

**The reviewer** clicks *Review a submission...* in the translator window and opens the submission file of the translation (from its post in the review queue on Discord). The translator window closes, the review window opens:

* The head names module, version, language and translator, followed by the one rule: read and judge by yourself, no machine translation and no AI tools.
* While the window is open, the submitted texts show in the real windows of the module (the same live preview as in the translator, but a text that could break a window as markup stays English). The selected text is outlined where it appears, and *Show this text*, *Open window* and *Open settings* work as in the translator.
* The list holds only the texts of the submission, with the filters *To review*, *OK* and *Needs change* and a search. The pane shows the English text, the German text for orientation, the submitted text and the results of the checks.
* *OK* or *Needs change* per text. *OK* moves on to the next text without a verdict. A text marked *Needs change* stays selected for an optional better wording (checked like a translation, an error is shown at once) and a remark. Writing a wording or a remark marks the text *Needs change* unless it was marked already.
* The state is kept in this browser (client setting `reviews`, by module, language and time of the submission, the newest 20), so you can go on later.
* *Save review file* downloads `<module>-<lang>-<date>-<time>-review.json`:

```json
{"format": "sephrals-translation-review", "v": 1, "module": "sephrals-roll-requests", "moduleVersion": "1.0.6", "lang": "ru",
 "submission": "2026-11-22T10:00:00.000Z", "translator": "", "reviewer": "", "createdAt": "...",
 "result": "approved | changes | partial", "counts": {"texts": 312, "ok": 300, "change": 12, "open": 0},
 "attest": {"byHand": true}, "items": {"SRR.Window.Title": {"verdict": "change", "suggestion": "...", "comment": "..."}}}
```

* *Copy text for the post* copies a short text in English for the post of this translation in the review queue: the result, the counts and the first texts to change (below 2000 characters, the full list is in the file).

**The translator** imports the review file with *Import*. Notes of another module or language are refused, a suggestion with an error keeps only its remark (the wording is dropped), an OK without a remark is left out. The filter *Review notes* lists the texts with a note, the list marks them with a dot, and the pane shows the note with *Take the suggestion* (puts it into the field and the live preview) and *Done* (removes the note). The notes are kept in the draft. The translation is then submitted again as usual.

## Security

Everything foreign (English, German, drafts, imported files, messages of the checks) is set with `textContent` or `.value`, never `innerHTML`. The Handlebars templates use `{{ }}` only. The merge into Foundry’s translations is the hardened one described above. The module makes no network requests: submitting opens Discord or GitHub in a new tab (`noopener`, `noreferrer`), and you attach the file yourself. It has no way to download texts from Sephral either: a translation reaches players only through the repository and a release.

## Self test

`api.runSelfTest()` checks the Foundry functions the module uses (dialogs, templates, saving a file), the checks library, the hash, the safe merge, the language code check, the module’s own language file and the draft storage. `TESTED_VERSIONS` in `scripts/config.mjs` holds the verified Foundry version.

## Debug file

For bug reports, the GM saves one file about all of Sephral’s modules in this world: `Save debug file` in the module settings, or `Save Debug File (Sephral’s Modules)` in the context menu of a chat message.

The file contains chat text and whispers. Check it before you share it. The part of Translator holds only counts, the module id and the language code, never the translated texts.

## Sephral’s Modules

The first button in the module settings, *Sephral’s Modules* (GMs only), opens one window for all of Sephral's modules in the world: the version, self test, settings, manual and demo video of each, a button that switches on an installed module that is off (Foundry then reloads the world for everyone), and the debug file. Below, *More from Sephral* lists other modules that fit the game system of the world, shown only after a click, each with its demo video and an *Install* button. Foundry installs modules only on its setup screen, so the button copies the module's link (manifest URL) and shows the steps with a short clip. When the GM launches the world again, the window opens once with the new module and its *Enable* button. The list is part of the module. Only a video you start is loaded, from the module page on GitHub. If the GM agreed to the usage statistics, the window also counts how it is used: opened, the other modules shown, a video or install link of one of them, a module installed or switched on from it. It never records which module.

## Macro API

`game.modules.get("sephrals-translator").api`:

| Member | Purpose |
| --- | --- |
| `open({module, lang})` | open the translator, or switch the open one (returns the window) |
| `app` | the open translator window, or `null` |
| `review(data)` | open the review window for a submission file (the parsed JSON), closes the translator window |
| `reviewApp` | the open review window, or `null` (`setVerdict(key, verdict, {suggestion, comment})`, `file()`, `message()`, `saveFile()`) |
| `inUse` | the translations this browser uses outside the window: `[{module, lang, source, keys}]`, source `me` or `world` |
| `runSelfTest(options)` | check the module |
| `saveDebugFile(messageId)` | save the debug file of Sephral’s modules (GM) |

The window has `describe()` (module, language, counts per status, coverage in words), `exportDraft()`, `goNext(dir)` (the next open text, returns its key), `togglePick()`, `pickFrom(element)` (the keys that show the text of an element, the first is selected) and `openSample(id)` (a sample window of the chosen module).

## Usage statistics

Translator does **not** carry the shared usage library and makes no network requests at all. It counts nothing and sends nothing.
