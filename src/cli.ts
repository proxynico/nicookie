#!/usr/bin/env bun
import { parseArgs } from "node:util";

import { BROWSERS, getCookies, toCookieHeader } from "./index.ts";
import type { Browser } from "./index.ts";

const USAGE = `Usage: nicookie <domain-or-url> [options]

Prints the cookies Chrome, Helium and Safari hold for a site, on macOS.

Options:
  --browser <name>     Browser to read: ${BROWSERS.join(", ")}. Repeat or comma-separate. Default: all.
  --profile <name>     One Chrome or Helium profile, by folder or display name. Default: all.
  --name <name>        Only cookies with this name. Repeat or comma-separate.
  --origin <url>       Another site to include. Repeat or comma-separate.
  --format <format>    json (default) or header.
  --timeout-ms <ms>    How long to wait for the macOS Keychain. Default: 3000.
  -h, --help           Show this help.

Exits 1 when no cookie is found. Warnings go to stderr.
`;

interface Output {
	write(text: string): unknown;
}

export async function runCli(
	args: string[],
	io: { stdout: Output; stderr: Output } = process,
): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				browser: { type: "string", multiple: true, default: [] },
				profile: { type: "string" },
				name: { type: "string", multiple: true, default: [] },
				origin: { type: "string", multiple: true, default: [] },
				format: { type: "string", default: "json" },
				"timeout-ms": { type: "string" },
				help: { type: "boolean", short: "h", default: false },
			},
		});
		if (values.help) {
			io.stdout.write(USAGE);
			return 0;
		}
		const [target, ...extra] = positionals;
		if (target === undefined || extra.length > 0) {
			throw new Error("Give one domain or URL.");
		}
		if (values.format !== "json" && values.format !== "header") {
			throw new Error(`Unknown --format: ${values.format}`);
		}
		const browsers = list(values.browser).map(toBrowser);
		const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
		if (timeoutMs !== undefined && !(timeoutMs > 0)) {
			throw new Error(`Invalid --timeout-ms: ${values["timeout-ms"]}`);
		}

		const { cookies, warnings } = await getCookies({
			url: toUrl(target),
			origins: list(values.origin).map(toUrl),
			names: list(values.name),
			...(browsers.length > 0 ? { browsers } : {}),
			...(values.profile === undefined ? {} : { profile: values.profile }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});
		for (const warning of warnings) {
			io.stderr.write(`warning: ${warning}\n`);
		}
		io.stdout.write(
			values.format === "header"
				? `Cookie: ${toCookieHeader(cookies)}\n`
				: `${JSON.stringify(cookies, null, 2)}\n`,
		);
		return cookies.length > 0 ? 0 : 1;
	} catch (error) {
		io.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** Flattens repeated and comma-separated option values. */
function list(values: string[]): string[] {
	return values.flatMap((value) => value.split(",")).filter((item) => item !== "");
}

function toBrowser(name: string): Browser {
	const browser = BROWSERS.find((known) => known === name);
	if (browser === undefined) {
		throw new Error(`Unknown --browser: ${name}`);
	}
	return browser;
}

function toUrl(target: string): string {
	return target.includes("://") ? target : `https://${target}/`;
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2));
}
