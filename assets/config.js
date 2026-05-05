// APP_BASE wird aus der URL dieses Moduls abgeleitet:
// Wenn die App unter /rezepte/ läuft, ist die URL dieses Files
// http(s)://<host>/rezepte/assets/config.js — `new URL('../', ...)` ergibt
// dann '/rezepte/'. Single Source of Truth für den Mount-Point.
export const APP_BASE = new URL('../', import.meta.url).pathname;
