export function isIPadOSChrome(userAgent: string): boolean {
  const isChromeOnIOS = /CriOS\//.test(userAgent);
  const isIPad = /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile\//.test(userAgent));
  return isChromeOnIOS && isIPad;
}

export function shouldUseEnvironmentCapture(userAgent?: string): boolean {
  const resolvedUserAgent = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  return !isIPadOSChrome(resolvedUserAgent);
}
