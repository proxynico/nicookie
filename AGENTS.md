# nicookie

nicookie reads the cookies Chrome, Helium and Safari hold for a site, on macOS under Bun, as a command and a library. It is Nico's own tool: it began as a fork of Sweet Cookie and no longer follows it. [README.md](README.md) owns what it reads, what it leaves out, and the command's options.

## Read when

| Task                                        | Read                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Change what a browser read returns or warns | [README.md](README.md), then the scenario in [tests/nicookie.test.ts](tests/nicookie.test.ts) that covers it |
| Add or update a package                     | The comment in [bunfig.toml](bunfig.toml) and [scripts/check-release-age.mjs](scripts/check-release-age.mjs) |

## Working rules

- **Scope is three browsers on macOS under Bun.** Add a browser, a platform or a runtime only when Nico asks for it. A Chromium browser is one entry in `TARGETS` in [src/chromium.ts](src/chromium.ts).
- **A cookie value appears only in the returned cookies.** Warnings, errors, logs, test output, commit messages and pull requests show names, counts and hashes.
- **Unreadable is a warning, never an empty success.** A browser, profile or value that cannot be read adds a warning that says why, and the command exits 1 when it found nothing.
- **There is no build.** `bin` and `exports` in `package.json` point at `src/`, so a consumer runs the committed TypeScript.
- **No runtime dependencies.** Development packages wait seven days after release, because this tool reads sign-in cookies.
- **`LICENSE` keeps Peter Steinberger's MIT notice.** The code began as his.

## Validate

- Run `bun run check` before every push. It formats, typechecks, lints and runs the tests with their coverage floor from `bunfig.toml`.
- Tests are full scenarios against a made-up home folder: real SQLite databases encrypted as Chrome encrypts them, a Safari cookie file, and a stand-in `security` command. Extend a scenario with more cases before adding a test. A test never reads a real browser store or the real Keychain.
- Fixture proof and live proof differ. To prove a read against a real browser, run `bun src/cli.ts <site> --browser <name>` on a Mac that has the browser, and report counts and names only. A live Chrome or Helium read needs someone at that Mac to allow the Keychain prompt once.

## Environment

- No environment file, secret or service. The readers find browsers under `HOME` and run `security` from `PATH`, which is how the tests redirect them.
- On the Mac mini, `~/bin/nicookie` runs `src/cli.ts` from the main checkout under Bun.

## Publish

- The default branch is `main`. Work lands by squash-merged pull request, and CI's one job, `ci`, runs `bun run check` on macOS.
- Pull requests merge by sudxhome's [merging.md](https://github.com/sudx-io/sudxhome/blob/main/merging.md). nicookie's risk path is `src/`, because it reads sign-in cookies: a pull request that changes it gets an independent check, and every other pull request merges on green CI.
- Nothing deploys. A consumer takes the repository as a Git dependency, so a merge reaches it when it updates its lockfile.
