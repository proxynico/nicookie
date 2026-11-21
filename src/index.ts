import { homedir } from "node:os";

import { readChromium } from "./chromium.ts";
import { BROWSERS, hostKeysFor } from "./cookie.ts";
import type { Browser, Cookie, CookieQuery, CookieResult } from "./cookie.ts";
import { readSafari } from "./safari.ts";

export { BROWSERS };
export type { Browser, Cookie, CookieResult };

export interface GetCookiesOptions {
	/** The page whose cookies to return, such as `https://x.com/`. */
	url: string;
	/** More pages to include, such as a sign-in domain. */
	origins?: string[];
	/** Return only the cookies with these names. */
	names?: string[];
	/** Browsers to read, in this order. Every browser when omitted. */
	browsers?: readonly Browser[];
	/** One Chrome or Helium profile, by folder (`Profile 1`) or display name (`Work`). Every profile when omitted. */
	profile?: string;
	/** How long to wait for the macOS Keychain, in milliseconds. 3000 when omitted. */
	timeoutMs?: number;
}

/**
 * Reads the cookies a browser would send to `url` from the local Chrome, Helium
 * and Safari stores. Cookies come back in browser order, each naming its source;
 * a browser that could not be read adds a warning instead of failing the call.
 *
 * @throws TypeError when `url` or an entry of `origins` is not a URL.
 */
export async function getCookies(options: GetCookiesOptions): Promise<CookieResult> {
	const hosts = [options.url, ...(options.origins ?? [])].map((url) => new URL(url).hostname);
	const query: CookieQuery = {
		hostKeys: hostKeysFor(hosts),
		names: options.names?.length ? new Set(options.names) : null,
		// HOME first, so a test can point the readers at a made-up home folder.
		home: process.env["HOME"] ?? homedir(),
	};
	const result: CookieResult = { cookies: [], warnings: [] };
	for (const browser of new Set(options.browsers ?? BROWSERS)) {
		const { cookies, warnings } =
			browser === "safari"
				? readSafari(query)
				: await readChromium(browser, query, {
						profile: options.profile,
						timeoutMs: options.timeoutMs ?? 3000,
					});
		result.cookies.push(...cookies);
		result.warnings.push(...warnings);
	}
	return result;
}

/** A `Cookie` header value. When several cookies share a name, the first one wins. */
export function toCookieHeader(cookies: readonly Cookie[]): string {
	const byName = new Map<string, string>();
	for (const cookie of cookies) {
		if (!byName.has(cookie.name)) {
			byName.set(cookie.name, cookie.value);
		}
	}
	return [...byName].map(([name, value]) => `${name}=${value}`).join("; ");
}
