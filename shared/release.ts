// Where students get the extension and how it checks for updates (GitHub Releases + GitHub Pages).
// The repository must be public for Pages and for the unauthenticated releases API (user step).
export const GITHUB_REPO = "iyangarcia/uniovi-virtual-extension";
/** Download page (docs/index.html served by GitHub Pages). */
export const DOWNLOAD_PAGE = "https://iyangarcia.github.io/uniovi-virtual-extension/";
/** Unauthenticated API (60 requests/hour per IP): fine for one check a day. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
/** Release asset name produced by `npm run package`. */
export const zipName = (version: string) => `uniovi-virtual-${version}.zip`;
