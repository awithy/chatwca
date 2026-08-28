import type { IncomingMessage } from "node:http";

/**
 * Validate a browser Origin against the authority addressed by the upgrade.
 * Clients without Origin are intentionally accepted for direct/non-browser use.
 */
export function hasAllowedWebSocketOrigin(
  request: Pick<IncomingMessage, "headers">,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }

  const host = request.headers.host;
  if (typeof origin !== "string" || host === undefined) {
    return false;
  }

  try {
    const originUrl = new URL(origin);
    if (
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
      originUrl.username !== "" ||
      originUrl.password !== "" ||
      originUrl.pathname !== "/" ||
      originUrl.search !== "" ||
      originUrl.hash !== ""
    ) {
      return false;
    }

    // Parse Host with the Origin scheme so URL applies the same IPv6, casing,
    // and default-port normalization to both authorities.
    const hostUrl = new URL(`${originUrl.protocol}//${host}`);
    if (
      hostUrl.username !== "" ||
      hostUrl.password !== "" ||
      hostUrl.pathname !== "/" ||
      hostUrl.search !== "" ||
      hostUrl.hash !== ""
    ) {
      return false;
    }

    return originUrl.host === hostUrl.host;
  } catch {
    return false;
  }
}
