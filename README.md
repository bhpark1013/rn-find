# rn-find

Find and tap React Native elements **by the text you can see**, through the Hermes inspector that Metro already exposes for every dev build.

```sh
npx rn-find tap 'Upload'                 # real touch on the button labelled "Upload"
npx rn-find find '^\d+ items$' --plain   # where is that counter, and is it pressable?
npx rn-find wait 'Saved' --timeout 8000  # block until the toast is on screen
npx rn-find type 'Search' 'nike'         # feed a TextInput without a keyboard
```

No `testID`s. No SDK inside the app. No MCP server. One file per concern, zero dependencies, Node 22+.

## Why

Driving a simulator from a script or an AI agent usually means one of three things:

- **Accessibility tree** (`idb ui describe-all`, XCUITest, Maestro). The app decides what it exports. In practice bottom sheets, FlashList rows and anything without an `accessibilityLabel` come back as *zero nodes*, and you fall back to guessing coordinates from a screenshot.
- **`testID` everywhere.** Works, but only after you retrofit every button in the app and keep doing so.
- **Screenshots + OCR / vision.** Slow, flaky on Korean/Japanese text, and it can't tell two buttons at the same y apart.

There is a fourth source of truth that already exists in every dev build: the **React fiber tree**. It contains everything that is rendered, with the real `<Text>` children, and Metro exposes a Chrome DevTools Protocol socket to the Hermes runtime that renders it. `rn-find` evaluates a small script over that socket, walks the fiber roots via the React DevTools hook, measures the matches with `measureInWindow`, and hands the coordinates to `idb` (iOS) or `adb` (Android) for a real touch. Or skips the touch entirely and calls `onPress` / `onChangeText` in place.

## Install

```sh
npm i -g rn-find          # or: npx rn-find …
```

Requirements

- A **dev build** of the app connected to Metro (Expo dev-client or bare RN debug build). Release builds have no inspector. Both the old (Paper) and the New Architecture (Fabric / Bridgeless) are supported.
- iOS touches: [`idb`](https://fbidb.io) — `brew tap facebook/fb && brew install idb-companion && pipx install fb-idb`
- Android touches: `adb` on PATH (experimental — coordinates are converted with `wm density`, tested less than iOS)
- `press`, `type` (without `--native`), `find`, `wait` need neither idb nor adb.

## Commands

| Command | What it does |
|---|---|
| `find <regex>` | List on-screen elements whose text / placeholder / value / accessibilityLabel / testID matches. JSON by default, `--plain` for one line each. |
| `tap <regex>` | Native touch at the centre of the match (`--index N` for the Nth in reading order). |
| `press <regex>` | Call the nearest `onPress` **inside the app**. No coordinates, no idb. Bypasses the native gesture pipeline, so use `tap` when you need to test that. |
| `type <regex> <text>` | Call the TextInput's `onChangeText`/`onChange` with the text. Any Unicode, no keyboard. `--native` taps and types through the OS instead (ASCII only on iOS). |
| `wait <regex>` | Poll until a match is on screen. Exit 1 on `--timeout` (default 15 s). |
| `targets` | Apps currently attached to Metro. |

Options: `--metro <url>` (or `$RN_METRO_URL`, default `http://localhost:8081`), `--device <name|udid|serial>` (or `$RN_DEVICE`; a simulator name also selects the Metro target), `--platform ios|android`, `--all` (include off-screen matches), `--screen 402x874`, `--flags i`.

Exit codes: `0` ok · `1` not found / usage · `3` Metro or app unreachable · `4` idb/adb failed. Errors go to stderr, results to stdout, so it composes:

```sh
rn-find find '원$' --plain | awk -F'\t' '{print $4}'   # every price on screen
rn-find tap 'Next' && rn-find wait 'Confirm' && rn-find tap 'Confirm'
```

## What it sees and what it skips

- Matches host `Text` children (strings, numbers, or arrays of them, so `"Total: " + n` works), `TextInput` value → placeholder → label, then `accessibilityLabel`, then `testID`.
- Skips subtrees that `react-native-screens` marks inactive (the other tabs, the previous stack screen) and `display: 'none'`. Opacity is ignored on purpose: Reanimated animates it natively and the JS props lie.
- Drops matches whose centre is outside the screen (a collapsed bottom sheet is "rendered" 800 pt below the fold) unless `--all`.
- Sorts by y then x, so `--index 1` is "the second one from the top".
- Walks the whole tree. A 7,000-fiber screen resolves in about 140 ms end to end (see below).

## How it compares

Everything below also reads the fiber tree through Metro. The difference is what they match on and what you must add to the app. (Observed against a production Expo app with ~6,400 fibers and almost no testIDs, September 2026.)

| | rn-find | [metro-mcp](https://github.com/steve228uk/metro-mcp) 0.15 | [ExecBro](https://github.com/igorzheludkov/execbro) | [react-native-mcp-kit](https://github.com/pranko17/react-native-mcp-kit) |
|---|---|---|---|---|
| Shape | CLI, 0 deps | MCP server, 88 tools | MCP server | MCP server + CLI |
| App changes | none | none | none (optional SDK) | **required**: `McpProvider` + Babel plugin |
| Tap by visible `<Text>` | yes | no — `tap_element` matches `accessibilityLabel`/`testID`, then falls back to the accessibility tree | via accessibility props, then OCR | yes |
| Traversal | whole tree | capped at 5,000 fibers (`traversal.complete=false` on our app) | not documented | whole tree |
| Off-screen filtering, reading-order index | yes | no | ? | ? |
| Call `onPress` / `onChangeText` directly | yes | no | ? | ? |
| Logs, network, navigation, profiling | no | yes, extensively | logs, network | yes |

Pick metro-mcp or ExecBro when you want an agent to *debug* an app (console, requests, Redux). Pick rn-find when you want a script or an agent to *operate* an app that was never instrumented for testing.

### Benchmark

The task every UI-automation tool has to do first: **locate an element on the current screen**. Wall-clock per call, M-series Mac, iPhone 17 simulator, a real production RN app (~4,000–7,000 fibers), each figure the median of 3–5 runs. rn-find figures include Node start-up; metro-mcp is measured with its daemon already warm.

| Tool | Find an element | vs rn-find | Sees unlabeled UI? |
|---|---|---|---|
| **rn-find** (`find`) | **~145 ms** | — | **yes** — reads the React tree |
| accessibility tree (`idb ui describe-all`) | ~314 ms | 2.2× slower | no — only what the app exported |
| metro-mcp `tap_element` by coordinates | ~1,000 ms | ~7× slower | n/a (you supply coords) |
| metro-mcp `tap_element` by label | ~1,900 ms, **fails** | ~13× slower | no — falls back to the accessibility tree |
| screenshot + OCR / vision | ~200 ms + seconds of model inference | many× slower | fuzzy — ambiguous on CJK / overlapping text |

**Two honest caveats on those numbers.** First, on elements the accessibility tree *does* expose (a labelled button), `idb` is actually competitive per call — sometimes a hair faster than rn-find's fiber walk. rn-find's decisive win is on the elements it **misses entirely**: custom tab bars, gorhom bottom sheets (which come back as *zero nodes*), icon buttons, FlashList rows. There the old path isn't 2× slower, it's a screenshot plus a human or a vision model reading coordinates off it — seconds, per element. Second, these are tool-execution times; agent reasoning time is excluded and dwarfs them either way.

**Why rn-find is fast.** It sends a single `Runtime.evaluate` over the Hermes inspector Metro already exposes; that one round-trip walks the fiber tree in-process and returns every rendered element with coordinates. No daemon, no CDP proxy, no per-element query. metro-mcp interposes an MCP daemon and a CDP proxy, so each call is several JSON-RPC round-trips and `tap_element` resolves-then-taps; `idb` re-serializes the whole XCUITest accessibility tree every call and can only see what the app chose to export; screenshot tools pay for image encoding plus model inference. The deeper reason is the source of truth: other tools read what the app *exported* (accessibility tree) or the *pixels* (screenshot) — both lossy projections — while rn-find reads the React tree the app actually rendered, which is why it is both faster and complete.

## Limitations

- Hermes accepts **one** debugger client. If Chrome DevTools / React DevTools is attached, rn-find fails to connect (exit 3). Each rn-find call connects and disconnects, so it never blocks anything else for long.
- Dev builds only. This is not a replacement for Detox/Maestro in CI against release builds.
- Coordinates are logical points from `measureInWindow`. Elements under a native modal that React doesn't know about (system alerts, share sheets) are invisible to it — use idb/adb directly for those.
- `press`/`type` call your handlers with a minimal synthetic event (`{ nativeEvent: {} }` / `{ nativeEvent: { text } }`). Handlers that read more from the event need `tap` / `--native`.

## Development

```sh
npm test              # pure-function tests (node:test)
RN_METRO_URL=http://localhost:8081 node bin/rn-find.js find '.' --plain
```

MIT © bhpark1013
