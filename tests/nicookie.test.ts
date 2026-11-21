// Every test builds a made-up home folder holding real cookie stores: SQLite
// databases encrypted the way Chrome encrypts them, a Safari cookie file, and a
// stand-in `security` command that answers for the macOS Keychain. HOME and PATH
// point nicookie at that folder, so no test touches a real browser or Keychain.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCli } from "../src/cli.ts";
import { getCookies, toCookieHeader } from "../src/index.ts";
import type { Cookie } from "../src/index.ts";

const FUTURE = 4_102_444_800; // 2100-01-01
const PAST = 1_000_000_000; // 2001-09-09
const CHROME_PASSWORD = "chrome-keychain-password";
const HELIUM_PASSWORD = "helium-keychain-password";
const KEYCHAIN = `case "$4/$6" in
	"Chrome Safe Storage/Chrome") echo "${CHROME_PASSWORD}" ;;
	"Helium Storage Key/Helium") echo "${HELIUM_PASSWORD}" ;;
	*) echo "The specified item could not be found in the keychain." >&2; exit 44 ;;
esac`;
const X = { url: "https://x.com/" };

const realEnv = { HOME: process.env["HOME"], PATH: process.env["PATH"] };
let home = "";

beforeEach(() => {
	home = mkdtempSync(path.join(tmpdir(), "nicookie-test-home-"));
	process.env["HOME"] = home;
	process.env["PATH"] = `${path.join(home, "bin")}:${realEnv.PATH}`;
	fakeSecurity(KEYCHAIN);
});

afterEach(() => {
	process.env["HOME"] = realEnv.HOME;
	process.env["PATH"] = realEnv.PATH;
	rmSync(home, { recursive: true, force: true });
});

/** Installs a shell script as the `security` command nicookie will find first. */
function fakeSecurity(script: string): void {
	const file = path.join(home, "bin", "security");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `#!/bin/sh\n${script}\n`);
	chmodSync(file, 0o755);
}

interface StoredCookie {
	host: string;
	name: string;
	value: string;
	path?: string;
	/** Unix seconds, or 0 for a session cookie. */
	expires?: number;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: number;
	/** The embedding site of a partitioned cookie. */
	partition?: string;
	/** The host the value is bound to, when it should differ from `host`. */
	boundTo?: string;
	/** The three bytes ahead of the ciphertext. */
	prefix?: string;
}

function encrypt(cookie: StoredCookie, password: string): Buffer {
	const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	const hostHash = createHash("sha256")
		.update(cookie.boundTo ?? cookie.host)
		.digest();
	return Buffer.concat([
		Buffer.from(cookie.prefix ?? "v10"),
		cipher.update(Buffer.concat([hostHash, Buffer.from(cookie.value)])),
		cipher.final(),
	]);
}

const BROWSER_ROOTS = { chrome: "Google/Chrome", helium: "net.imput.helium" };

function browserRoot(browser: keyof typeof BROWSER_ROOTS): string {
	return path.join(home, "Library", "Application Support", BROWSER_ROOTS[browser]);
}

/** Writes one profile's cookie database, with the table layout Chrome 142 uses. */
function writeProfile(input: {
	browser: keyof typeof BROWSER_ROOTS;
	profile: string;
	password: string;
	cookies: StoredCookie[];
	version?: number;
}): Database {
	const dir = path.join(browserRoot(input.browser), input.profile);
	mkdirSync(dir, { recursive: true });
	const db = new Database(path.join(dir, "Cookies"));
	db.run("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)");
	db.run("INSERT INTO meta VALUES ('version', ?)", [String(input.version ?? 24)]);
	db.run(`CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,
		top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
		encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,
		is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL,
		has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL,
		samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL,
		last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
		has_cross_site_ancestor INTEGER NOT NULL)`);
	addCookies(db, input.cookies, input.password);
	return db;
}

function addCookies(db: Database, cookies: StoredCookie[], password: string): void {
	const insert = db.query(`INSERT INTO cookies VALUES
		((SELECT count(*) FROM cookies), ?, ?, ?, '', ?, ?, ?, ?, ?, 0, 1, 1, 1, ?, 2, 443, 0, 0, 0)`);
	for (const cookie of cookies) {
		const expires = cookie.expires ?? FUTURE;
		insert.run(
			cookie.host,
			cookie.partition ?? "",
			cookie.name,
			encrypt(cookie, password),
			cookie.path ?? "/",
			// Chrome counts microseconds from 1601.
			expires === 0 ? 0n : (BigInt(expires) + 11_644_473_600n) * 1_000_000n,
			cookie.secure === false ? 0 : 1,
			cookie.httpOnly === true ? 1 : 0,
			cookie.sameSite ?? -1,
		);
	}
}

interface SafariCookie {
	domain: string;
	name: string;
	value: string;
	path?: string;
	expires?: number;
	flags?: number;
}

/** One page of Safari's cookie file format. */
function safariPage(cookies: SafariCookie[]): Buffer {
	const records = cookies.map((cookie) => {
		const header = Buffer.alloc(56);
		const texts = [cookie.domain, cookie.name, cookie.path ?? "/", cookie.value].map((text) =>
			Buffer.from(`${text}\0`),
		);
		let offset = header.length;
		for (const [index, text] of texts.entries()) {
			header.writeUInt32LE(offset, 16 + index * 4);
			offset += text.length;
		}
		header.writeUInt32LE(offset, 0);
		header.writeUInt32LE(cookie.flags ?? 0, 8);
		// Safari counts seconds from 2001.
		header.writeDoubleLE(cookie.expires === undefined ? 0 : cookie.expires - 978_307_200, 40);
		return Buffer.concat([header, ...texts]);
	});
	const header = Buffer.alloc(8 + records.length * 4 + 4);
	header.writeUInt32BE(0x100, 0);
	header.writeUInt32LE(records.length, 4);
	let offset = header.length;
	for (const [index, record] of records.entries()) {
		header.writeUInt32LE(offset, 8 + index * 4);
		offset += record.length;
	}
	return Buffer.concat([header, ...records]);
}

function writeSafari(content: Buffer | SafariCookie[][]): void {
	const file = path.join(
		home,
		"Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	if (Buffer.isBuffer(content)) {
		writeFileSync(file, content);
		return;
	}
	const pages = content.map(safariPage);
	const header = Buffer.alloc(8 + pages.length * 4);
	header.write("cook");
	header.writeUInt32BE(pages.length, 4);
	for (const [index, page] of pages.entries()) {
		header.writeUInt32BE(page.length, 8 + index * 4);
	}
	writeFileSync(file, Buffer.concat([header, ...pages]));
}

/** One line per cookie, enough to tell them apart: `browser/profile name=value @domain`. */
function summary(cookies: Cookie[]): string[] {
	return cookies.map(
		({ source, name, value, domain }) =>
			`${source.browser}/${source.profile ?? "-"} ${name}=${value} @${domain}`,
	);
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const code = await runCli(args, {
		stdout: { write: (text) => (stdout += text) },
		stderr: { write: (text) => (stderr += text) },
	});
	return { code, stdout, stderr };
}

test("reads the cookies each browser would send to a site", async () => {
	writeProfile({
		browser: "chrome",
		profile: "Default",
		password: CHROME_PASSWORD,
		cookies: [
			{ host: ".x.com", name: "auth_token", value: "chrome-auth", httpOnly: true, sameSite: 0 },
			{ host: "x.com", name: "ct0", value: "chrome-ct0", expires: 0, secure: false, sameSite: 1 },
			{ host: ".x.com", name: "lang", value: "", sameSite: 2 },
			{ host: ".x.com", name: "lang", value: "en-für-✓", path: "/i/api" },
			{ host: ".twitter.com", name: "auth_token", value: "chrome-twitter-auth" },
			{ host: "api.x.com", name: "api_only", value: "api-host" },
			{ host: ".api.x.com", name: "api_tree", value: "api-domain" },
			{ host: ".other.com", name: "auth_token", value: "other-site" },
			{ host: ".notx.com", name: "auth_token", value: "lookalike" },
			{ host: ".com", name: "auth_token", value: "whole-tld" },
			{ host: ".x.com", name: "old", value: "expired", expires: PAST },
			{ host: ".x.com", name: "embed", value: "partitioned", partition: "https://embed.example" },
		],
	}).close();
	writeProfile({
		browser: "chrome",
		profile: "Profile 1",
		password: CHROME_PASSWORD,
		cookies: [{ host: ".x.com", name: "auth_token", value: "work-auth" }],
	}).close();
	writeFileSync(
		path.join(browserRoot("chrome"), "Local State"),
		JSON.stringify({
			profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } },
		}),
	);
	// A browser folder without a cookie database is not a profile.
	mkdirSync(path.join(browserRoot("chrome"), "Crashpad"));
	writeProfile({
		browser: "helium",
		profile: "Default",
		password: HELIUM_PASSWORD,
		cookies: [{ host: ".x.com", name: "auth_token", value: "helium-auth" }],
	}).close();
	writeSafari([
		[
			{ domain: ".x.com", name: "auth_token", value: "safari-auth", expires: FUTURE, flags: 5 },
			{ domain: "x.com", name: "ct0", value: "safari-ct0", flags: 1 },
			{ domain: ".X.com", name: "old", value: "expired", expires: PAST },
			{ domain: ".other.com", name: "auth_token", value: "other-site" },
		],
		[
			{ domain: "api.x.com", name: "api_only", value: "safari-api", path: "/v2", flags: 4 },
			{ domain: "api.x.com", name: "auth_token", value: "safari-api-auth", path: "/v2/deep" },
		],
	]);

	// Everything for x.com, in browser order, longest path first within a profile.
	const all = await getCookies(X);
	expect(all.warnings).toEqual([]);
	expect(all.cookies).toEqual([
		{
			name: "lang",
			value: "en-für-✓",
			domain: "x.com",
			hostOnly: false,
			path: "/i/api",
			expires: FUTURE,
			secure: true,
			httpOnly: false,
			source: { browser: "chrome", profile: "Default" },
		},
		{
			name: "auth_token",
			value: "chrome-auth",
			domain: "x.com",
			hostOnly: false,
			path: "/",
			expires: FUTURE,
			secure: true,
			httpOnly: true,
			sameSite: "None",
			source: { browser: "chrome", profile: "Default" },
		},
		{
			name: "ct0",
			value: "chrome-ct0",
			domain: "x.com",
			hostOnly: true,
			path: "/",
			secure: false,
			httpOnly: false,
			sameSite: "Lax",
			source: { browser: "chrome", profile: "Default" },
		},
		{
			name: "lang",
			value: "",
			domain: "x.com",
			hostOnly: false,
			path: "/",
			expires: FUTURE,
			secure: true,
			httpOnly: false,
			sameSite: "Strict",
			source: { browser: "chrome", profile: "Default" },
		},
		{
			name: "auth_token",
			value: "work-auth",
			domain: "x.com",
			hostOnly: false,
			path: "/",
			expires: FUTURE,
			secure: true,
			httpOnly: false,
			source: { browser: "chrome", profile: "Profile 1" },
		},
		{
			name: "auth_token",
			value: "helium-auth",
			domain: "x.com",
			hostOnly: false,
			path: "/",
			expires: FUTURE,
			secure: true,
			httpOnly: false,
			source: { browser: "helium", profile: "Default" },
		},
		{
			name: "auth_token",
			value: "safari-auth",
			domain: "x.com",
			hostOnly: false,
			path: "/",
			expires: FUTURE,
			secure: true,
			httpOnly: true,
			source: { browser: "safari" },
		},
		{
			name: "ct0",
			value: "safari-ct0",
			domain: "x.com",
			hostOnly: true,
			path: "/",
			secure: true,
			httpOnly: false,
			source: { browser: "safari" },
		},
	]);
	expect(toCookieHeader(all.cookies)).toBe("lang=en-für-✓; auth_token=chrome-auth; ct0=chrome-ct0");
	expect(toCookieHeader([])).toBe("");

	// A subdomain gets its own cookies and its parents' shared ones, never a parent's host-only one.
	const api = await getCookies({ url: "https://api.x.com/1.1/x.json", browsers: ["chrome"] });
	expect(summary(api.cookies)).toEqual([
		"chrome/Default lang=en-für-✓ @x.com",
		"chrome/Default auth_token=chrome-auth @x.com",
		"chrome/Default lang= @x.com",
		"chrome/Default api_only=api-host @api.x.com",
		"chrome/Default api_tree=api-domain @api.x.com",
		"chrome/Profile 1 auth_token=work-auth @x.com",
	]);
	const safariApi = await getCookies({ url: "https://api.x.com/", browsers: ["safari"] });
	// Safari's file holds these shortest path first; they come back longest path first.
	expect(safariApi.cookies.map((cookie) => [cookie.name, cookie.path, cookie.httpOnly])).toEqual([
		["auth_token", "/v2/deep", false],
		["api_only", "/v2", true],
		["auth_token", "/", true],
	]);
	expect(toCookieHeader(safariApi.cookies)).toBe("auth_token=safari-api-auth; api_only=safari-api");

	// Narrowing by name, extra site, browser and profile.
	const named = await getCookies({ ...X, names: ["ct0", "missing"] });
	expect(summary(named.cookies)).toEqual([
		"chrome/Default ct0=chrome-ct0 @x.com",
		"safari/- ct0=safari-ct0 @x.com",
	]);
	const both = await getCookies({
		...X,
		origins: ["https://twitter.com/"],
		names: ["auth_token"],
		browsers: ["safari", "chrome", "safari"],
		profile: "Default",
	});
	expect(summary(both.cookies)).toEqual([
		"safari/- auth_token=safari-auth @x.com",
		"chrome/Default auth_token=chrome-auth @x.com",
		"chrome/Default auth_token=chrome-twitter-auth @twitter.com",
	]);
	for (const profile of ["Profile 1", "Work"]) {
		const work = await getCookies({ ...X, browsers: ["chrome"], profile, names: [] });
		expect(summary(work.cookies)).toEqual(["chrome/Profile 1 auth_token=work-auth @x.com"]);
		expect(work.warnings).toEqual([]);
	}
	expect(await getCookies({ url: "https://nothing.example/" })).toEqual({
		cookies: [],
		warnings: [],
	});
	// A site that is not a URL is the caller's mistake, so it throws instead of warning.
	for (const bad of [{ url: "x.com" }, { ...X, origins: ["not a url"] }]) {
		const failure: unknown = await getCookies(bad).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TypeError);
	}
});

test("says what it could not read and still returns the rest", async () => {
	// Nothing installed: each browser reports where it looked.
	const empty = await getCookies(X);
	expect(empty.cookies).toEqual([]);
	expect(empty.warnings).toEqual([
		`Chrome has no data at ${browserRoot("chrome")}.`,
		`Helium has no data at ${browserRoot("helium")}.`,
		expect.stringMatching(/^Could not read Safari's cookies: ENOENT.*Cookies\.binarycookies/),
	]);

	// A browser folder that cannot be listed stops that browser only.
	mkdirSync(path.dirname(browserRoot("helium")), { recursive: true });
	writeFileSync(browserRoot("helium"), "a file where the folder should be");
	const unlistable = await getCookies({ ...X, browsers: ["helium", "safari"] });
	expect(unlistable.cookies).toEqual([]);
	expect(unlistable.warnings).toEqual([
		expect.stringMatching(/^Could not list Helium's profiles: ENOTDIR/),
		expect.stringMatching(/^Could not read Safari's cookies: ENOENT/),
	]);
	rmSync(browserRoot("helium"));

	// A browser folder with no profile in it, and a profile name nothing matches.
	mkdirSync(browserRoot("helium"), { recursive: true });
	const helium = await getCookies({ ...X, browsers: ["helium"] });
	expect(helium).toEqual({ cookies: [], warnings: ["Helium has no profile with cookies."] });

	const db = writeProfile({
		browser: "chrome",
		profile: "Default",
		password: CHROME_PASSWORD,
		cookies: [
			{ host: ".x.com", name: "auth_token", value: "chrome-auth" },
			{ host: ".x.com", name: "moved", value: "from-another-host", boundTo: ".evil.example" },
			{ host: ".x.com", name: "app_bound", value: "newer-scheme", prefix: "v20" },
			{ host: ".x.com", name: "odd", value: "stored-with-a-binary-path" },
		],
	});
	db.run("UPDATE cookies SET path = x'2f' WHERE name = 'odd'");
	const chrome = { ...X, browsers: ["chrome"] as const };
	expect(await getCookies({ ...chrome, profile: "Work" })).toEqual({
		cookies: [],
		warnings: ['Chrome has no profile named "Work" with cookies.'],
	});

	// A value bound to another host, under a scheme not read here, or in a row of the wrong
	// shape is counted, not returned.
	const mixed = await getCookies(chrome);
	expect(summary(mixed.cookies)).toEqual(["chrome/Default auth_token=chrome-auth @x.com"]);
	expect(mixed.warnings).toEqual(['3 cookie(s) in Chrome profile "Default" could not be read.']);

	// A running browser keeps the database open, with its newest cookie only in the -wal file.
	db.run("PRAGMA journal_mode = WAL");
	addCookies(db, [{ host: ".x.com", name: "fresh", value: "from-the-wal" }], CHROME_PASSWORD);
	expect(readdirSync(path.join(browserRoot("chrome"), "Default"))).toContain("Cookies-wal");
	const copiesBefore = readdirSync(tmpdir()).filter((name) => /^nicookie-[^t]/.test(name));
	const live = await getCookies({ ...chrome, names: ["fresh"] });
	expect(summary(live.cookies)).toEqual(["chrome/Default fresh=from-the-wal @x.com"]);
	expect(live.warnings).toEqual([]);
	// The copy it read from is gone again.
	expect(readdirSync(tmpdir()).filter((name) => /^nicookie-[^t]/.test(name))).toEqual(copiesBefore);
	db.close();

	// The Keychain answers with another password: nothing decrypts, and nothing is returned as if it had.
	fakeSecurity('echo "not-the-password"');
	expect(await getCookies(chrome)).toEqual({
		cookies: [],
		warnings: ['5 cookie(s) in Chrome profile "Default" could not be read.'],
	});

	// The Keychain refuses, has nothing, hangs on a prompt, or is not there at all.
	fakeSecurity(KEYCHAIN.replace("Chrome Safe Storage", "Renamed"));
	writeSafari([[{ domain: ".x.com", name: "auth_token", value: "safari-auth" }]]);
	const refused = await getCookies({ ...X, browsers: ["chrome", "safari"] });
	expect(summary(refused.cookies)).toEqual(["safari/- auth_token=safari-auth @x.com"]);
	expect(refused.warnings).toEqual([
		"Could not read Chrome's key from the macOS Keychain: The specified item could not be found in the keychain.",
	]);
	fakeSecurity("exit 3");
	expect((await getCookies(chrome)).warnings).toEqual([
		"Could not read Chrome's key from the macOS Keychain: security exited with 3",
	]);
	fakeSecurity("exec sleep 5");
	const started = Date.now();
	expect(await getCookies({ ...chrome, timeoutMs: 150 })).toEqual({
		cookies: [],
		warnings: [
			"Could not read Chrome's key from the macOS Keychain: no answer in 150 ms. A Keychain prompt may be waiting.",
		],
	});
	expect(Date.now() - started).toBeLessThan(3000);
	rmSync(path.join(home, "bin"), { recursive: true });
	process.env["PATH"] = path.join(home, "bin");
	expect((await getCookies(chrome)).warnings).toEqual([
		expect.stringMatching(/^Could not read Chrome's key from the macOS Keychain: .*security/),
	]);
	process.env["PATH"] = `${path.join(home, "bin")}:${realEnv.PATH}`;
	fakeSecurity(KEYCHAIN);

	// One unreadable profile does not hide the others.
	writeProfile({
		browser: "chrome",
		profile: "Profile 1",
		password: CHROME_PASSWORD,
		cookies: [{ host: ".x.com", name: "auth_token", value: "too-old" }],
		version: 23,
	}).close();
	mkdirSync(path.join(browserRoot("chrome"), "Profile 2"));
	writeFileSync(path.join(browserRoot("chrome"), "Profile 2", "Cookies"), "not a database");
	for (const localState of ["{ broken", "[]", '{"profile":7}', '{"profile":{"info_cache":7}}']) {
		writeFileSync(path.join(browserRoot("chrome"), "Local State"), localState);
		expect(await getCookies({ ...chrome, profile: "Default", names: ["auth_token"] })).toEqual({
			cookies: [expect.objectContaining({ value: "chrome-auth" })],
			warnings: [],
		});
	}
	const profiles = await getCookies({ ...chrome, names: ["auth_token"] });
	expect(summary(profiles.cookies)).toEqual(["chrome/Default auth_token=chrome-auth @x.com"]);
	expect(profiles.warnings).toEqual([
		'Could not read Chrome profile "Profile 1": its cookie database is version 23, older than 24.',
		expect.stringMatching(/^Could not read Chrome profile "Profile 2": /),
	]);

	// A Safari file that is something else, or cut short.
	const safari = { ...X, browsers: ["safari"] as const };
	writeSafari(Buffer.from("not a cookie file"));
	expect(await getCookies(safari)).toEqual({
		cookies: [],
		warnings: ["Could not read Safari's cookies: the file is not in Safari's cookie format."],
	});
	writeSafari([[{ domain: ".x.com", name: "auth_token", value: "safari-auth" }]]);
	const whole = await getCookies(safari);
	expect(whole.cookies).toHaveLength(1);
	const file = path.join(
		home,
		"Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
	);
	writeFileSync(file, Buffer.from(await Bun.file(file).arrayBuffer()).subarray(0, 40));
	const cut = await getCookies(safari);
	expect(cut.cookies).toEqual([]);
	expect(cut.warnings).toEqual([expect.stringMatching(/^Could not read Safari's cookies: /)]);
	// A record with no name or no domain is skipped.
	writeSafari([
		[
			{ domain: "", name: "nameless-domain", value: "a" },
			{ domain: ".x.com", name: "", value: "b" },
			{ domain: ".x.com", name: "kept", value: "c" },
		],
	]);
	expect(summary((await getCookies(safari)).cookies)).toEqual(["safari/- kept=c @x.com"]);
});

test("the nicookie command prints cookies as JSON or as a header", async () => {
	writeProfile({
		browser: "chrome",
		profile: "Default",
		password: CHROME_PASSWORD,
		cookies: [
			{ host: ".x.com", name: "auth_token", value: "chrome-auth" },
			{ host: ".x.com", name: "ct0", value: "chrome-ct0" },
			{ host: ".twitter.com", name: "guest_id", value: "chrome-guest" },
		],
	}).close();
	writeSafari([[{ domain: ".x.com", name: "auth_token", value: "safari-auth" }]]);

	// A bare domain, all browsers: JSON on stdout, the missing browser on stderr.
	const all = await cli("x.com");
	expect(all.code).toBe(0);
	expect(all.stderr).toBe(`warning: Helium has no data at ${browserRoot("helium")}.\n`);
	expect(all.stdout.endsWith("]\n")).toBe(true);
	const printed: unknown = JSON.parse(all.stdout);
	expect(printed).toEqual((await getCookies(X)).cookies);
	expect(printed).toHaveLength(3);

	// A header, with every option spelled each way it can be.
	const header = await cli("https://x.com/home", "--format", "header", "--browser", "chrome");
	expect(header).toEqual({
		code: 0,
		stdout: "Cookie: auth_token=chrome-auth; ct0=chrome-ct0\n",
		stderr: "",
	});
	const narrowed = await cli(
		"x.com",
		"--format=header",
		"--browser=safari,chrome",
		"--browser",
		"chrome",
		"--origin",
		"twitter.com,https://x.com/",
		"--name",
		"auth_token",
		"--name=guest_id,,",
		"--profile",
		"Default",
		"--timeout-ms",
		"5000",
	);
	expect(narrowed).toEqual({
		code: 0,
		stdout: "Cookie: auth_token=safari-auth; guest_id=chrome-guest\n",
		stderr: "",
	});

	// Nothing found exits 1, so a script cannot mistake it for a login.
	expect(await cli("nothing.example", "--browser", "chrome")).toEqual({
		code: 1,
		stdout: "[]\n",
		stderr: "",
	});
	expect(
		await cli("x.com", "--browser", "chrome", "--profile", "Work", "--format", "header"),
	).toEqual({
		code: 1,
		stdout: "Cookie: \n",
		stderr: 'warning: Chrome has no profile named "Work" with cookies.\n',
	});

	// Help, and every way to get the command wrong.
	const help = await cli("--help");
	expect(help.code).toBe(0);
	expect(help.stderr).toBe("");
	expect(help.stdout).toStartWith("Usage: nicookie <domain-or-url> [options]\n");
	expect(help.stdout).toContain("chrome, helium, safari");
	expect((await cli("-h")).stdout).toBe(help.stdout);
	const mistakes: [string[], RegExp][] = [
		[[], /^error: Give one domain or URL\.\n$/],
		[["x.com", "twitter.com"], /^error: Give one domain or URL\.\n$/],
		[["x.com", "--browser", "firefox"], /^error: Unknown --browser: firefox\n$/],
		[["x.com", "--format", "yaml"], /^error: Unknown --format: yaml\n$/],
		[["x.com", "--timeout-ms", "soon"], /^error: Invalid --timeout-ms: soon\n$/],
		[["x.com", "--timeout-ms", "0"], /^error: Invalid --timeout-ms: 0\n$/],
		[["x.com", "--all-profiles"], /^error: .*--all-profiles/],
		[["x.com", "--profile"], /^error: .*--profile/],
		[["http://[bad"], /^error: /],
	];
	for (const [args, expected] of mistakes) {
		const result = await cli(...args);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(expected);
	}

	// The command as installed: its own process, started through the file's `#!` line.
	const child = Bun.spawn(
		[path.join(import.meta.dir, "../src/cli.ts"), "x.com", "--browser", "chrome", "--name", "ct0"],
		{ stdout: "pipe", stderr: "pipe", env: process.env },
	);
	const [stdout, stderr, code] = await Promise.all([
		child.stdout.text(),
		child.stderr.text(),
		child.exited,
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual([
		expect.objectContaining({ name: "ct0", value: "chrome-ct0" }),
	]);
});
