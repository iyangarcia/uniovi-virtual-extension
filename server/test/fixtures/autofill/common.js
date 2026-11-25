// Shared by the auto-fill fixtures: a tiny "controlled input" model like React's. A field only counts
// as filled when an input event carried the value (assigning .value alone doesn't update state), and
// the confirm button records whether a script clicked it (auto-fill must never do that). Clicks from
// the test harness's real mouse (isTrusted) stand for the student and are not counted.
window.__state = {};
window.__confirmClicks = 0;
// A script ticking a checkbox (the AI's risk notice must stay the student's choice).
window.__untrustedChecks = 0;
for (const type of ["click", "change"]) {
  document.addEventListener(type, (e) => {
    if (!e.isTrusted && e.target instanceof HTMLInputElement && e.target.type === "checkbox") window.__untrustedChecks++;
  }, true);
}
window.guardConfirm = (btn) => {
  btn.addEventListener("click", (e) => {
    if (!e.isTrusted) window.__confirmClicks++;
  });
};
window.bindForm = (root) => {
  for (const el of root.querySelectorAll("input, textarea")) {
    el.addEventListener("input", () => {
      window.__state[el.dataset.field || el.name || el.id] = el.value;
      root.querySelector("[data-confirm]").disabled = !(window.__state.name && window.__state.url);
    });
  }
  window.guardConfirm(root.querySelector("[data-confirm]"));
};
window.later = (ms, fn) => setTimeout(fn, ms);
