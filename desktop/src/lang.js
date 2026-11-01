// The app's current language (settings.json `language`, set from the console; else the system's) and `t` for the
// main process — the words are in i18n.js.
"use strict";

const { app } = require("electron");
const { readSettings } = require("./settings");
const { pickLanguage, translator, pageText } = require("./i18n");

const PRODUCT = "My Mate Geny";

function language() {
  let locale = "";
  try {
    locale = app.getLocale();
  } catch {
    /* before ready */
  }
  return pickLanguage(readSettings().language, locale);
}

/** t("trayQuit"), t("hotkeyBody", { key }) — {product} is filled in */
function t(key, vars) {
  return translator(language())(key, { product: PRODUCT, ...vars });
}

module.exports = { language, t, pageText: () => pageText(language()) };
