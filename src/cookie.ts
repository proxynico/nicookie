export const BROWSERS = ["chrome", "helium", "safari"] as const;
export type Browser = (typeof BROWSERS)[number];

export interface Cookie {
	name: string;
	value: string;
	/** Hostname, without a leading dot. */
	domain: string;
	/** True when the cookie belongs to `domain` alone, false when subdomains get it too. */
	hostOnly: boolean;
	path: string;
	/** Unix seconds. Absent on a session cookie. */
	expires?: number;
	secure: boolean;
	httpOnly: boolean;
	sameSite?: "Strict" | "Lax" | "None";
	source: { browser: Browser; profile?: string };
}

export interface CookieResult {
	cookies: Cookie[];
	/** What could not be read, and why. Never holds a cookie value. */
	warnings: string[];
}

/** What a browser reader filters by. */
export interface CookieQuery {
	/** Stored domains that apply, as {@link hostKeysFor} spells them. */
	hostKeys: Set<string>;
	/** Cookie names to keep, or null for all. */
	names: Set<string> | null;
	/** Where to look for browsers, in place of the user's home folder. */
	home: string;
}

/**
 * The stored domains whose cookies a browser would send to `hosts`, spelled as
 * browsers store them: a bare host for a host-only cookie, a leading dot for
 * one shared with subdomains. `a.x.com` gives `a.x.com`, `.a.x.com` and `.x.com`.
 */
export function hostKeysFor(hosts: string[]): Set<string> {
	const keys = new Set<string>();
	for (const host of hosts) {
		keys.add(host);
		const labels = host.split(".");
		// Stop at two labels: no browser stores a cookie for a bare top-level domain.
		for (let start = 0; start === 0 || labels.length - start >= 2; start += 1) {
			keys.add(`.${labels.slice(start).join(".")}`);
		}
	}
	return keys;
}
