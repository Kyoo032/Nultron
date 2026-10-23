export const THEME_BOOT_FILE = "theme-boot.js";

export function themeBootScript(storageKey: string): string {
  const key = JSON.stringify(storageKey);
  return `(function(){try{var d=document.documentElement;var l=localStorage.getItem(${key})!=="dark";d.classList.toggle("light",l);d.classList.toggle("dark",!l)}catch(e){}})();\n`;
}
