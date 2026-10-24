// Light/dark toggle shared by edonchain.art pages (same icons and labels as onchainusers.art).
// The choice is remembered per browser; the page still works if storage is unavailable.
(function () {
  const SUN = '<path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-14a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zm0 17a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1zM4.22 4.22a1 1 0 0 1 1.42 0l.7.7a1 1 0 1 1-1.41 1.42l-.71-.71a1 1 0 0 1 0-1.41zm12.73 12.73a1 1 0 0 1 1.41 0l.71.71a1 1 0 1 1-1.42 1.41l-.7-.7a1 1 0 0 1 0-1.42zM1 12a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2H2a1 1 0 0 1-1-1zm18 0a1 1 0 0 1 1-1h1a1 1 0 1 1 0 2h-1a1 1 0 0 1-1-1zM4.22 19.78a1 1 0 0 1 0-1.41l.71-.71a1 1 0 1 1 1.41 1.42l-.7.7a1 1 0 0 1-1.42 0zM16.95 6.34a1 1 0 0 1 0-1.41l.7-.71a1 1 0 1 1 1.42 1.41l-.71.71a1 1 0 0 1-1.41 0z"/>';
  const MOON = '<path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.5 5.5 0 0 1-7.54-7.54A9 9 0 0 0 12 3z"/>';
  const KEY = "ed-theme";

  function setTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    const icon = document.getElementById("themeIcon");
    const label = document.getElementById("themeLabel");
    if (icon) icon.innerHTML = mode === "dark" ? SUN : MOON;
    if (label) label.textContent = mode === "dark" ? "Light Mode" : "Dark Mode";
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  setTheme(saved === "light" ? "light" : "dark");

  const btn = document.getElementById("themeToggle");
  if (btn) btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  });
})();
