// Opening the side panel (home.html) from an extension page (welcome page, viewer tab).
// chrome.sidePanel.open() only works inside a user gesture, and an await before it can lose the
// gesture: so the window id is read when the page loads and open() is called straight from the click.
// If it still fails (an old Chrome, no gesture), home.html opens as a normal tab instead.

let windowId: number | undefined;
void chrome.windows.getCurrent().then(
  (w) => (windowId = w.id),
  () => undefined,
);

export function openSidePanel(): void {
  const fallback = () => void chrome.tabs.create({ url: chrome.runtime.getURL("home.html") });
  if (windowId === undefined || !chrome.sidePanel?.open) return fallback();
  chrome.sidePanel.open({ windowId }).catch(fallback);
}
