# opencode-browser-plugin

Browser control tools for [opencode](https://opencode.ai) that let a **text-only LLM** see and operate a real Chromium-based browser.

The model receives a compact textual snapshot of the page (URL, title, visible text, headings, interactive elements with refs like `e12`) and can click, type, scroll, hover, switch tabs and run JavaScript. No vision model is required.

## Features

- Text-first snapshots designed for models that cannot process images.
- Stable element refs (`e1`, `e2`, ...) that stay valid until the next snapshot.
- Clicks and typing by ref or CSS selector.
- Text extraction from the rendered DOM, including headings and form state.
- Automatic Chrome / Edge / Brave detection on Windows, macOS and Linux.
- Headed (visible) or headless mode.
- Multiple tabs: list, create, switch, close.
- Console errors included in snapshots for easier debugging.
- Optional PNG screenshots for humans or vision-capable models.
- No npm dependencies: uses the Chrome DevTools Protocol directly.
- Separate temporary browser profile and a random local debugging port.

## Requirements

- opencode
- Google Chrome, Microsoft Edge, Brave or another Chromium-based browser

## Installation

Copy `browser.ts` into the opencode plugins directory and restart opencode:

| Scope | Path |
| --- | --- |
| Global (Windows) | `%USERPROFILE%\.config\opencode\plugins\browser.ts` |
| Global (macOS/Linux) | `~/.config/opencode/plugins/browser.ts` |
| Project | `.opencode/plugin/browser.ts` |

No entry in `opencode.json` is required. The plugin is discovered automatically.

## Usage

Just ask the model to use the browser, for example:

> Open example.com and summarize the page.

The model should follow this loop:

1. `browser_open` — launch the browser and navigate.
2. `browser_snapshot` — read the page as text and get element refs.
3. `browser_click` / `browser_type` — interact using a ref.
4. `browser_snapshot` — read the updated page (action tools already return a compact snapshot).

If a model does not choose the tools on its own, mention them explicitly, or add a line to your opencode instructions:

> For browser tasks use browser_open, browser_snapshot and browser_click/browser_type.

## Tools

| Tool | Description |
| --- | --- |
| `browser_open` | Launch a browser and optionally navigate to a URL. |
| `browser_goto` | Navigate the current tab. |
| `browser_snapshot` | Read the page as text with element refs. |
| `browser_click` | Click an element by ref or CSS selector. |
| `browser_type` | Fill an input, textarea, contenteditable or select. |
| `browser_press` | Press a key or key combination. |
| `browser_scroll` | Scroll by pixels or jump to top/bottom. |
| `browser_hover` | Hover an element to open menus. |
| `browser_tabs` | List, create, switch or close tabs. |
| `browser_wait` | Wait for time or for a selector to appear. |
| `browser_eval` | Evaluate JavaScript in the page. |
| `browser_screenshot` | Save a PNG screenshot to disk. |
| `browser_history` | Go back, forward or reload. |
| `browser_close` | Close the browser and remove its temporary profile. |

## Configuration

Environment variables:

| Variable | Description |
| --- | --- |
| `OPENCODE_BROWSER_HEADLESS=1` | Start headless by default. |
| `OPENCODE_BROWSER_PATH` | Path to the browser executable. |
| `CHROME_PATH` | Fallback path to the browser executable. |

`browser_open` also accepts `headless`, `executablePath` and `restart` arguments.

## How it works

The plugin launches the browser with a random `--remote-debugging-port` bound to `127.0.0.1` and a temporary `--user-data-dir`. It connects to the page target over WebSocket and speaks the Chrome DevTools Protocol.

`browser_snapshot` walks the DOM, assigns `data-oc-ref` attributes to interactive elements, and returns rendered text plus a structured element list. Screenshots are saved to disk and are not returned to text-only models unless `attach` is explicitly enabled.

## Security notes

- Each launch uses an isolated temporary profile that is removed on `browser_close` and on opencode exit.
- The debugging port is random and bound to localhost.
- `browser_eval` executes arbitrary JavaScript in the page. Only use these tools with prompts and websites you trust.
- Do not commit tokens, cookies or personal data into this repository.

## License

MIT
