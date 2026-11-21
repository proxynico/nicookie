import { readFileSync } from "node:fs";
import path from "node:path";

import type { Cookie, CookieQuery, CookieResult } from "./cookie.ts";

/** Safari counts seconds from 2001-01-01; this shifts them to Unix seconds. */
const MAC_EPOCH_OFFSET = 978_307_200;
const SECURE = 1;
const HTTP_ONLY = 4;

export function readSafari(query: CookieQuery): CookieResult {
	const file = path.join(
		query.home,
		"Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
	);
	let stored: Cookie[];
	try {
		stored = decodeFile(readFileSync(file));
	} catch (error) {
		// A truncated file surfaces here as a RangeError from a read past its end.
		const reason = error instanceof Error ? error.message : String(error);
		return { cookies: [], warnings: [`Could not read Safari's cookies: ${reason}`] };
	}
	const now = Date.now() / 1000;
	const cookies = stored.filter(
		(cookie) =>
			query.hostKeys.has(cookie.hostOnly ? cookie.domain : `.${cookie.domain}`) &&
			(query.names === null || query.names.has(cookie.name)) &&
			(cookie.expires === undefined || cookie.expires > now),
	);
	return { cookies, warnings: [] };
}

/** `cook`, a page count, each page's size, then the pages. Counts and sizes here are big-endian. */
function decodeFile(file: Buffer): Cookie[] {
	if (file.toString("latin1", 0, 4) !== "cook") {
		throw new Error("the file is not in Safari's cookie format.");
	}
	const pageCount = file.readUInt32BE(4);
	const cookies: Cookie[] = [];
	let pageStart = 8 + pageCount * 4;
	for (let page = 0; page < pageCount; page += 1) {
		const pageSize = file.readUInt32BE(8 + page * 4);
		cookies.push(...decodePage(file.subarray(pageStart, pageStart + pageSize)));
		pageStart += pageSize;
	}
	return cookies;
}

/** A page is a cookie count, then each cookie's offset within the page. Little-endian from here on. */
function decodePage(page: Buffer): Cookie[] {
	const cookies: Cookie[] = [];
	const cookieCount = page.readUInt32LE(4);
	for (let index = 0; index < cookieCount; index += 1) {
		const cookie = decodeCookie(page.subarray(page.readUInt32LE(8 + index * 4)));
		if (cookie !== null) {
			cookies.push(cookie);
		}
	}
	return cookies;
}

function decodeCookie(record: Buffer): Cookie | null {
	const size = record.readUInt32LE(0);
	const flags = record.readUInt32LE(8);
	const text = (offsetAt: number): string => {
		const start = record.readUInt32LE(offsetAt);
		const end = record.indexOf(0, start);
		return start > 0 && end !== -1 && end < size ? record.toString("utf8", start, end) : "";
	};
	const rawDomain = text(16);
	const name = text(20);
	if (name === "" || rawDomain === "") {
		return null;
	}
	const hostOnly = !rawDomain.startsWith(".");
	const expiry = record.readDoubleLE(40);
	return {
		name,
		value: text(28),
		domain: (hostOnly ? rawDomain : rawDomain.slice(1)).toLowerCase(),
		hostOnly,
		path: text(24) || "/",
		...(expiry > 0 ? { expires: Math.round(expiry + MAC_EPOCH_OFFSET) } : {}),
		secure: (flags & SECURE) !== 0,
		httpOnly: (flags & HTTP_ONLY) !== 0,
		source: { browser: "safari" },
	};
}
