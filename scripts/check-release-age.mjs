#!/usr/bin/env bun
// bun applies bunfig.toml's minimumReleaseAge only when it picks a version, so a
// version already in bun.lock installs without the check. This rechecks every
// registry version in bun.lock against npm's publish time, and fails on a version
// that is too new or has no publish time, as pnpm's strict release-age policy did.
import { existsSync, readFileSync } from "node:fs";
// Bun's own TOML parser, so the age is the value bun install enforces.
import bunfig from "../bunfig.toml";

function fail(message) {
	console.error(`Release-age check failed: ${message}`);
	process.exit(1);
}

// The publish times come from registry.npmjs.org, so installs must too.
if (bunfig.install?.registry || bunfig.install?.scopes) {
	fail("bunfig.toml points installs at another registry");
}
if (existsSync(new URL("../.npmrc", import.meta.url))) {
	fail("an .npmrc could point installs at another registry");
}

const ageSeconds = bunfig.install?.minimumReleaseAge;
if (!Number.isInteger(ageSeconds) || ageSeconds <= 0) {
	fail(
		`bunfig.toml's [install] minimumReleaseAge is not a positive number of seconds: ${ageSeconds}`,
	);
}
const minimumAgeMs = ageSeconds * 1000;

// bun.lock is JSON with trailing commas.
const lockText = readFileSync(new URL("../bun.lock", import.meta.url), "utf8").replace(
	/,(\s*[}\]])/g,
	"$1",
);
const lock = JSON.parse(lockText);
const entries = Object.values(lock.packages ?? {});
if (entries.length === 0) {
	fail("bun.lock lists no packages");
}

// The repository's own workspace packages are the only entries without a registry version.
const workspaceSpecs = new Set(
	Object.entries(lock.workspaces ?? {}).map(([path, { name }]) => `${name}@workspace:${path}`),
);

const versions = new Map();
for (const entry of entries) {
	const spec = Array.isArray(entry) ? entry[0] : undefined;
	if (typeof spec !== "string") {
		fail(`bun.lock has an entry it can't read: ${JSON.stringify(entry).slice(0, 80)}`);
	}
	if (workspaceSpecs.has(spec)) {
		continue;
	}
	const at = spec.lastIndexOf("@");
	const name = spec.slice(0, at);
	const version = spec.slice(at + 1);
	if (at <= 0 || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
		fail(`bun.lock has a spec that is neither a registry version nor a workspace: ${spec}`);
	}
	// An empty source means the default registry; anything else downloads from elsewhere.
	if (entry[1] !== "") {
		fail(`bun.lock fetches ${spec} from ${JSON.stringify(entry[1])}, not the default registry`);
	}
	const seen = versions.get(name) ?? new Set();
	seen.add(version);
	versions.set(name, seen);
}

const now = Date.now();
const problems = [];
const names = [...versions.keys()];
let next = 0;

async function checkNext() {
	while (next < names.length) {
		const name = names[next++];
		const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
		if (!response.ok) {
			problems.push(`${name}: registry answered ${response.status}`);
			continue;
		}
		const { time = {} } = await response.json();
		for (const version of versions.get(name)) {
			const published = Date.parse(time[version] ?? "");
			if (Number.isNaN(published)) {
				problems.push(`${name}@${version}: no publish time`);
			} else if (now - published < minimumAgeMs) {
				const days = ((now - published) / 86_400_000).toFixed(1);
				problems.push(`${name}@${version}: published ${days} days ago`);
			}
		}
	}
}

await Promise.all(Array.from({ length: 8 }, checkNext));

const count = [...versions.values()].reduce((sum, set) => sum + set.size, 0);
if (problems.length > 0) {
	console.error(`Release-age check failed for ${problems.length} of ${count} locked versions:`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	process.exit(1);
}
console.log(
	`Release-age check: all ${count} locked versions are at least ${ageSeconds} seconds old.`,
);
