/* ==========================================================================
 * Theme management: multiple colour schemes, applied by setting a
 * [data-theme] attribute on <html>. Persisted to localStorage and applied
 * before first paint to avoid a flash of the wrong theme.
 * ========================================================================== */

export const THEMES = [
  { id: "system", name: "跟随系统", swatch: ["#d0d5dd", "#333b49"] },
  { id: "light", name: "浅色", swatch: ["#f7f8fa", "#e4e7eb", "#6366f1"] },
  { id: "dark", name: "深色", swatch: ["#111318", "#262b36", "#818cf8"] },
  { id: "dracula", name: "Dracula", swatch: ["#282a36", "#44475a", "#bd93f9"] },
  { id: "nord", name: "Nord", swatch: ["#2e3440", "#434c5e", "#88c0d0"] },
  { id: "one-dark", name: "One Dark", swatch: ["#282c34", "#3b4049", "#61afef"] },
  { id: "material", name: "Material", swatch: ["#263238", "#37474f", "#80cbc4"] },
  { id: "solarized", name: "Solarized", swatch: ["#fdf6e3", "#e9e0bf", "#268bd2"] },
  { id: "github", name: "GitHub", swatch: ["#22272e", "#353f4b", "#539bf5"] },
  { id: "catppuccin", name: "Catppuccin", swatch: ["#1e1e2e", "#3a3a51", "#89b4fa"] },
  { id: "high-contrast", name: "翠绿", swatch: ["#ffffff", "#e9ebef", "#12b76a"] },
];

export const SWATCH = {
  system: ["#d0d5dd", "#333b49"],
  light: ["#f7f8fa", "#e4e7eb", "#6366f1"],
  dark: ["#111318", "#262b36", "#818cf8"],
  dracula: ["#282a36", "#44475a", "#bd93f9"],
  nord: ["#2e3440", "#434c5e", "#88c0d0"],
  "one-dark": ["#282c34", "#3b4049", "#61afef"],
  material: ["#263238", "#37474f", "#80cbc4"],
  solarized: ["#fdf6e3", "#e9e0bf", "#268bd2"],
  github: ["#22272e", "#353f4b", "#539bf5"],
  catppuccin: ["#1e1e2e", "#3a3a51", "#89b4fa"],
  "high-contrast": ["#ffffff", "#e9ebef", "#12b76a"],
};

const KEY = "opencode-web.theme";

export function getTheme() {
  return localStorage.getItem(KEY) || "system";
}

export function setTheme(id) {
  localStorage.setItem(KEY, id);
  applyTheme(id);
}

export function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id);
}

export function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Apply immediately on module load so the correct theme is present before
// the rest of the app paints (prevents dark-mode flash).
applyTheme(getTheme());
