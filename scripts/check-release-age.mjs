#!/usr/bin/env bun
// bun applies bunfig.toml's minimumReleaseAge only when it picks a version, so a
// version already in bun.lock installs without the check. This rechecks every
// registry version in bun.lock against npm's publish time, and fails on a version
// that is too new or has no publish time, as pnpm's strict release-age policy did.
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const bunfig = readFileSync(new URL("bunfig.toml", root), "utf8");
const ageMatch = bunfig.match(/^\s*minimumReleaseAge\s*=\s*(\d+)/m);
if (!ageMatch) {
	console.error("bunfig.toml sets no [install] minimumReleaseAge");
	process.exit(1);
}
const minimumAgeMs = Number(ageMatch[1]) * 1000;

// bun.lock is JSON with trailing commas.
const lockText = readFileSync(new URL("bun.lock", root), "utf8").replace(/,(\s*[}\]])/g, "$1");
const lock = JSON.parse(lockText);

const versions = new Map();
for (const entry of Object.values(lock.packages ?? {})) {
	const spec = entry[0];
	const at = spec.lastIndexOf("@");
	const name = spec.slice(0, at);
	const version = spec.slice(at + 1);
	// Workspace, file, link and git entries carry no registry version.
	if (at <= 0 || !/^\d+\.\d+\.\d+/.test(version)) {
		continue;
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
	`Release-age check: all ${count} locked versions are at least ${ageMatch[1]} seconds old.`,
);
