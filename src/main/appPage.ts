// The app window's own page: `file://…/renderer/index.html`, or the dev
// server's URL in development. Anything else is a foreign page.
export function sameAppPage(url: string, appUrl: string): boolean {
  try {
    const a = new URL(url)
    const b = new URL(appUrl)
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  } catch {
    return false
  }
}
