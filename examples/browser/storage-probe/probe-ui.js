// SPDX-License-Identifier: MIT
/**
 * Language and theme for a page with no build step.
 *
 * The probe came from an application that had a shared brand module for this;
 * that module is GPL-3.0 and this package is MIT, so it could not travel. What
 * it actually did for this page was two things — remember a language and a
 * theme — and both are short enough to own.
 *
 * The pre-paint script in the page sets `<html lang>` and `data-theme` before
 * the first frame, so switching later only has to keep them in step.
 */

const LANGS = ["en", "de"];
const KEY_LANG = "storage-probe:lang";
const KEY_THEME = "storage-probe:theme";

const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked site data: a preference that cannot be kept
    // is not a reason to stop working.
  }
};

/** The smallest store that `subscribe` callers need, and nothing else. */
function createStore(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(value);
      return () => listeners.delete(listener);
    },
  };
}

const startingLang = LANGS.includes(document.documentElement.lang)
  ? document.documentElement.lang
  : "en";

export const lang = createStore(startingLang);

lang.subscribe((code) => {
  document.documentElement.lang = code;
  remember(KEY_LANG, code);
});

export function setLang(code) {
  if (LANGS.includes(code)) lang.set(code);
}

export const theme = createStore(document.documentElement.dataset.theme || "system");

theme.subscribe((choice) => {
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  remember(KEY_THEME, choice);
});

/** What the reader sees now, with "system" resolved against the OS. */
function shownTheme() {
  const choice = theme.get();
  if (choice !== "system") return choice;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const FLAG = { en: "🇬🇧", de: "🇩🇪" };
const LABEL = {
  en: { lang: "Auf Deutsch lesen", theme: "Switch theme" },
  de: { lang: "Read in English", theme: "Darstellung wechseln" },
};

/**
 * Two buttons, top right: the other language, and the other theme.
 *
 * Each says what it will do rather than what is on, because a toggle that
 * names its current state reads as a claim about the page.
 */
export function mountControls(target = document.body) {
  const bar = document.createElement("div");
  bar.className = "page-controls";

  const langButton = document.createElement("button");
  langButton.type = "button";
  langButton.className = "chip";
  langButton.addEventListener("click", () => setLang(lang.get() === "en" ? "de" : "en"));

  const themeButton = document.createElement("button");
  themeButton.type = "button";
  themeButton.className = "chip";
  themeButton.addEventListener("click", () =>
    theme.set(shownTheme() === "dark" ? "light" : "dark"),
  );

  const paint = () => {
    const other = lang.get() === "en" ? "de" : "en";
    langButton.textContent = FLAG[other];
    langButton.setAttribute("aria-label", LABEL[lang.get()].lang);
    langButton.title = LABEL[lang.get()].lang;
    themeButton.textContent = shownTheme() === "dark" ? "☀" : "☾";
    themeButton.setAttribute("aria-label", LABEL[lang.get()].theme);
    themeButton.title = LABEL[lang.get()].theme;
  };

  lang.subscribe(paint);
  theme.subscribe(paint);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);

  bar.append(langButton, themeButton);
  target.prepend(bar);
  return bar;
}
