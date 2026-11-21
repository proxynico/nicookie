# nicookie

nicookie reads the cookies that Chrome, Helium and Safari hold for a site. It runs on macOS under [Bun](https://bun.sh), as a command and as a TypeScript library with no dependencies. Local tools use it to act with a session you already signed in to.

```console
$ nicookie x.com --browser safari --name ct0 --format header
Cookie: ct0=4f1c…
```

## Use the command

From a checkout, run `bun src/cli.ts`, or run `bun link` once to put `nicookie` on your `PATH`.

```bash
nicookie x.com                                   # every browser, every profile, as JSON
nicookie x.com --browser chrome --profile Work   # one browser, one profile
nicookie x.com --origin twitter.com --name auth_token,ct0 --format header
```

| Option              | Meaning                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--browser <name>`  | `chrome`, `helium` or `safari`. Repeat it or separate names with commas. The default is all three.                             |
| `--profile <name>`  | One Chrome or Helium profile, by folder (`Profile 1`) or by the name the browser shows (`Work`). The default is every profile. |
| `--name <name>`     | Only the cookies with this name. Repeat it or separate names with commas.                                                      |
| `--origin <url>`    | Another site to include, such as a sign-in domain.                                                                             |
| `--format <format>` | `json`, the default, or `header`.                                                                                              |
| `--timeout-ms <ms>` | How long to wait for the macOS Keychain. The default is 3000.                                                                  |

The command prints cookies to stdout and warnings to stderr. It exits 1 when it finds no cookie, so a script cannot take an empty result for a session.

## Use the library

```bash
bun add github:proxynico/nicookie
```

```ts
import { getCookies, toCookieHeader } from "nicookie";

const { cookies, warnings } = await getCookies({
	url: "https://x.com/",
	origins: ["https://twitter.com/"],
	names: ["auth_token", "ct0"],
	browsers: ["helium", "safari"],
});

for (const warning of warnings) console.warn(warning);
const header = toCookieHeader(cookies); // "auth_token=…; ct0=…"
```

`getCookies` returns the cookies in the order of `browsers`. Each cookie names its `source`: the browser and, for Chrome and Helium, the profile. A browser or profile that cannot be read adds a line to `warnings`, and the other browsers still return their cookies. A warning never holds a cookie value. `getCookies` throws a `TypeError` only when `url` or an origin is not a URL.

`toCookieHeader` keeps the first cookie of each name. Within one profile the cookie with the longest path comes first, as it does in a browser.

The option and cookie types are in [`src/index.ts`](src/index.ts) and [`src/cookie.ts`](src/cookie.ts).

## What it reads

| Browser | Cookie store                                                                       | Needs                                           |
| ------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Chrome  | `~/Library/Application Support/Google/Chrome/<profile>/Cookies`                    | The `Chrome Safe Storage` Keychain entry        |
| Helium  | `~/Library/Application Support/net.imput.helium/<profile>/Cookies`                 | The `Helium Storage Key` Keychain entry         |
| Safari  | `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies` | Full Disk Access for the app that runs nicookie |

- **Keychain.** The first Chrome or Helium read makes macOS ask whether `security` may use the entry. Choose **Always Allow**. Until someone answers, the read ends after `timeoutMs` with a warning.
- **A running browser.** nicookie reads a copy of the database and its write-ahead log, so the browser can stay open.
- **Matching.** A cookie is returned when the browser would send it to the host: the host's own cookies, and the cookies its parent domains share with subdomains. Expired cookies are left out. Paths and the `Secure` flag are not checked against the URL.

## What it leaves out

- Partitioned cookies. Such a cookie is valid only inside one embedding site, which a replay cannot reproduce.
- Chrome and Helium cookie databases older than version 24, which Chrome 130 introduced. A value in a newer database carries a hash of its host, and nicookie checks that hash.
- A value it cannot decrypt, or whose host hash does not match. The profile's warning counts them.
- Windows, Linux, Node.js and every other browser.

## Develop

```bash
bun install --frozen-lockfile
bun run check   # format, types, lint, tests with coverage
```

The tests build a made-up home folder with real cookie databases and a stand-in `security` command. They never read your browsers or your Keychain.

## Credit and license

nicookie began as a fork of [Sweet Cookie](https://github.com/steipete/sweet-cookie) by Peter Steinberger and no longer follows it. MIT. See [LICENSE](LICENSE).
