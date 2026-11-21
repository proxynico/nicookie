import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Cookie, CookieQuery, CookieResult } from "./cookie.ts";

/** Where each Chromium browser keeps its profiles, and the Keychain entry that holds its cookie key. */
const TARGETS = {
	chrome: {
		label: "Chrome",
		root: "Google/Chrome",
		service: "Chrome Safe Storage",
		account: "Chrome",
	},
	helium: {
		label: "Helium",
		root: "net.imput.helium",
		service: "Helium Storage Key",
		account: "Helium",
	},
} as const;

type ChromiumBrowser = keyof typeof TARGETS;

/** The oldest cookie database layout read here: the first whose values carry a hash of their host. */
const MIN_DB_VERSION = 24;
const SAME_SITE = ["None", "Lax", "Strict"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export async function readChromium(
	browser: ChromiumBrowser,
	query: CookieQuery,
	options: { profile?: string | undefined; timeoutMs: number },
): Promise<CookieResult> {
	const target = TARGETS[browser];
	const root = path.join(query.home, "Library", "Application Support", target.root);
	if (!existsSync(root)) {
		return { cookies: [], warnings: [`${target.label} has no data at ${root}.`] };
	}
	const profiles = findProfiles(root, options.profile);
	if (profiles.length === 0) {
		const wanted = options.profile === undefined ? "" : ` named "${options.profile}"`;
		return { cookies: [], warnings: [`${target.label} has no profile${wanted} with cookies.`] };
	}

	let key: Buffer;
	try {
		const password = await keychainPassword(target, options.timeoutMs);
		// Chromium on macOS derives its AES-128 key from the Keychain password with these fixed values.
		key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	} catch (error) {
		return {
			cookies: [],
			warnings: [`Could not read ${target.label}'s key from the macOS Keychain: ${message(error)}`],
		};
	}

	const result: CookieResult = { cookies: [], warnings: [] };
	for (const profile of profiles) {
		const where = `${target.label} profile "${profile}"`;
		try {
			const { cookies, unreadable } = readProfile({ root, profile, browser, key, query });
			result.cookies.push(...cookies);
			if (unreadable > 0) {
				result.warnings.push(`${unreadable} cookie(s) in ${where} could not be read.`);
			}
		} catch (error) {
			result.warnings.push(`Could not read ${where}: ${message(error)}`);
		}
	}
	return result;
}

/** Profile folders that hold a cookie database, narrowed to `wanted` by folder or display name. */
function findProfiles(root: string, wanted: string | undefined): string[] {
	const folders = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "Cookies")))
		.map((entry) => entry.name)
		.toSorted();
	if (wanted === undefined) {
		return folders;
	}
	const displayNames = profileDisplayNames(root);
	return folders.filter((folder) => folder === wanted || displayNames.get(folder) === wanted);
}

/** Folder name to the name the browser shows, from the browser's `Local State` file. */
function profileDisplayNames(root: string): Map<string, string> {
	const names = new Map<string, string>();
	let state: unknown;
	try {
		state = JSON.parse(readFileSync(path.join(root, "Local State"), "utf8"));
	} catch {
		// Without the file a profile is still found by its folder name.
		return names;
	}
	if (typeof state !== "object" || state === null || !("profile" in state)) {
		return names;
	}
	const { profile } = state;
	if (typeof profile !== "object" || profile === null || !("info_cache" in profile)) {
		return names;
	}
	const cache = profile.info_cache;
	if (typeof cache !== "object" || cache === null) {
		return names;
	}
	const entries: [string, unknown][] = Object.entries(cache);
	for (const [folder, info] of entries) {
		if (
			typeof info === "object" &&
			info !== null &&
			"name" in info &&
			typeof info.name === "string"
		) {
			names.set(folder, info.name);
		}
	}
	return names;
}

async function keychainPassword(
	target: (typeof TARGETS)[ChromiumBrowser],
	timeoutMs: number,
): Promise<string> {
	const child = Bun.spawn(
		["security", "find-generic-password", "-w", "-s", target.service, "-a", target.account],
		// Passing the environment makes Bun look `security` up on the PATH as it is now.
		{ stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: process.env },
	);
	const [stdout, stderr, code] = await Promise.all([
		child.stdout.text(),
		child.stderr.text(),
		child.exited,
	]);
	if (child.signalCode !== null) {
		throw new Error(`no answer in ${timeoutMs} ms. A Keychain prompt may be waiting.`);
	}
	const password = stdout.trim();
	if (code !== 0 || password === "") {
		throw new Error(stderr.trim() || `security exited with ${code}`);
	}
	return password;
}

function readProfile(input: {
	root: string;
	profile: string;
	browser: ChromiumBrowser;
	key: Buffer;
	query: CookieQuery;
}): { cookies: Cookie[]; unreadable: number } {
	const source = path.join(input.root, input.profile, "Cookies");
	// A running browser holds the database open and keeps its newest writes in the
	// -wal file beside it, so read a copy of both.
	const copyDir = mkdtempSync(path.join(tmpdir(), "nicookie-"));
	try {
		const copy = path.join(copyDir, "Cookies");
		copyFileSync(source, copy);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(source + suffix)) {
				copyFileSync(source + suffix, copy + suffix);
			}
		}
		const db = new Database(copy, { readonly: true });
		try {
			return readRows(db, input);
		} finally {
			db.close();
		}
	} finally {
		rmSync(copyDir, { recursive: true, force: true });
	}
}

function readRows(
	db: Database,
	input: { profile: string; browser: ChromiumBrowser; key: Buffer; query: CookieQuery },
): { cookies: Cookie[]; unreadable: number } {
	const version: unknown = db
		.query("SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'")
		.values()[0]?.[0];
	if (typeof version !== "number" || version < MIN_DB_VERSION) {
		throw new Error(
			`its cookie database is version ${String(version)}, older than ${MIN_DB_VERSION}.`,
		);
	}

	const hostKeys = [...input.query.hostKeys];
	const names = input.query.names === null ? [] : [...input.query.names];
	// expires_utc counts microseconds from 1601, too large for a JavaScript number,
	// so SQLite turns it into Unix seconds. A partitioned cookie (top_frame_site_key)
	// is only valid inside one embedding site, which a replay cannot reproduce.
	const unixExpires = "expires_utc / 1000000 - 11644473600";
	const rows = db
		.query(
			`SELECT name, encrypted_value, host_key, path, is_secure, is_httponly, samesite,
				CASE WHEN expires_utc > 0 THEN ${unixExpires} END
			FROM cookies
			WHERE host_key IN (${placeholders(hostKeys)})
				AND top_frame_site_key = ''
				AND (expires_utc = 0 OR ${unixExpires} > unixepoch())
				${names.length > 0 ? `AND name IN (${placeholders(names)})` : ""}
			ORDER BY length(path) DESC, creation_utc`,
		)
		.values(...hostKeys, ...names);

	const cookies: Cookie[] = [];
	let unreadable = 0;
	for (const [name, encrypted, hostKey, cookiePath, secure, httpOnly, sameSite, expires] of rows) {
		if (
			typeof name !== "string" ||
			typeof hostKey !== "string" ||
			typeof cookiePath !== "string" ||
			!(encrypted instanceof Uint8Array)
		) {
			unreadable += 1;
			continue;
		}
		const value = decrypt(encrypted, input.key, hostKey);
		if (value === null) {
			unreadable += 1;
			continue;
		}
		const hostOnly = !hostKey.startsWith(".");
		const sameSiteName = typeof sameSite === "number" ? SAME_SITE[sameSite] : undefined;
		cookies.push({
			name,
			value,
			domain: hostOnly ? hostKey : hostKey.slice(1),
			hostOnly,
			path: cookiePath,
			...(typeof expires === "number" ? { expires } : {}),
			secure: secure === 1,
			httpOnly: httpOnly === 1,
			...(sameSiteName === undefined ? {} : { sameSite: sameSiteName }),
			source: { browser: input.browser, profile: input.profile },
		});
	}
	return { cookies, unreadable };
}

function placeholders(values: unknown[]): string {
	return values.map(() => "?").join(", ");
}

/**
 * A value is `v10`, then AES-128-CBC under an IV of 16 spaces. The plaintext
 * opens with the SHA-256 of the cookie's host, which proves the value was not
 * moved from another host and that the key is the right one.
 */
function decrypt(encrypted: Uint8Array, key: Buffer, hostKey: string): string | null {
	const data = Buffer.from(encrypted);
	if (data.subarray(0, 3).toString("latin1") !== "v10") {
		return null;
	}
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
		const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
		if (!plain.subarray(0, 32).equals(createHash("sha256").update(hostKey).digest())) {
			return null;
		}
		return UTF8.decode(plain.subarray(32));
	} catch {
		// A wrong key fails the padding check, and a damaged value fails UTF-8 decoding.
		return null;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
