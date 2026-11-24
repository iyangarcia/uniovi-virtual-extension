// Shared by the auto-fill fixtures: a tiny "controlled input" model like React's. A field only counts
// as filled when an input event carried the value (assigning .value alone doesn't update state), and
// the confirm button records whether anything clicked it (auto-fill must never do that).
window.__state = {};
window.__confirmClicks = 0;
window.bindForm = (root) => {
  for (const el of root.querySelectorAll("input, textarea")) {
    el.addEventListener("input", () => {
      window.__state[el.dataset.field || el.name || el.id] = el.value;
      root.querySelector("[data-confirm]").disabled = !(window.__state.name && window.__state.url);
    });
  }
  root.querySelector("[data-confirm]").addEventListener("click", () => window.__confirmClicks++);
};
window.later = (ms, fn) => setTimeout(fn, ms);
