// The app's version and release date (package.json, raised by scripts/bump.mjs at each publish; built in by scripts/build.mjs),
// shown in the footer and in Settings so you can see which version a device has loaded.

declare const __APP_VERSION__: string, __RELEASE_DATE__: string;

export function versionText(): string {
  const day = __RELEASE_DATE__ ? new Date(`${__RELEASE_DATE__}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `${__APP_VERSION__}${day ? ` (${day})` : ''}`;
}
