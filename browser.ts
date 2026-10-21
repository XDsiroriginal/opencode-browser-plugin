import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFileSync, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type LogEntry = { level: string; text: string; at: number }

type TargetInfo = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

type SnapshotData = {
  url: string
  title: string
  viewport: { width: number; height: number; scrollY: number; scrollHeight: number }
  text: string
  textLength: number
  headings: Array<{ level: number; text: string }>
  elements: Array<Record<string, any>>
  totalElements: number
}

type SnapshotOptions = {
  maxTextChars?: number
  maxElements?: number
}

type ActionOptions = SnapshotOptions & { snapshot?: boolean }

type BrowserOptions = {
  headless?: boolean
  executablePath?: string
  width?: number
  height?: number
  timeoutMs?: number
  overlay?: boolean
}

const SYSTEM_HINT = `# Browser control (text only)

You cannot see images. Use browser_snapshot to "see" a web page: it returns the URL, title, visible text, headings and interactive elements with refs like e12.
Refs are valid until the next snapshot; action tools already return a fresh compact snapshot, otherwise call browser_snapshot again after the page changes.
Use browser_click / browser_type with a ref (or a CSS selector when you know it). Prefer text snapshots over screenshots.
A small overlay panel in the bottom-right corner of the browser shows live activity and lets the user chat with the model in real time. You can control it with browser_overlay.`

const OVERLAY_BINDING = "__opencodeBrowserBridge"
const OVERLAY_GLOBAL = "__OPENCODE_BROWSER_OVERLAY__"

type OverlayMessage = { role: "user" | "assistant" | "system"; text: string; pending?: boolean }
type OverlayActivity = { text: string; level: "info" | "browser" | "tool" | "error"; at: number }
type OverlayPayload =
  | { kind: "activity"; text: string; level: OverlayActivity["level"]; at: number }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; done: boolean }
  | { kind: "system"; text: string }
  | { kind: "status"; text: string; busy: boolean }
  | { kind: "url"; url: string }
  | { kind: "restore"; messages: OverlayMessage[]; activity: OverlayActivity[]; busy: boolean; status: string; visible: boolean; url: string }
  | { kind: "show" }
  | { kind: "hide" }
  | { kind: "clear" }

function overlayBootstrap(token) {
  try {
    if (window.top && window.top !== window) return
  } catch (error) {
    return
  }
  var GLOBAL = "__OPENCODE_BROWSER_OVERLAY__"
  var BINDING = "__opencodeBrowserBridge"
  var HOST_ID = "__opencode-browser-overlay-host"
  var TOKEN = String(token || "")
  var bridge = typeof window[BINDING] === "function" ? window[BINDING] : null
  var stringify = JSON.stringify
  var existing = window[GLOBAL]
  if (existing && typeof existing.apply === "function") return
  if (document.getElementById(HOST_ID)) return

  var state = { messages: [], activity: [], busy: false, status: "готово", visible: true, url: location.href }
  var host
  var root
  var els
  var currentAssistant = null
  var minimized = false

  function pad(value) {
    return (value < 10 ? "0" : "") + value
  }

  function clock(at) {
    var date = at ? new Date(at) : new Date()
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
  }

  function send(payload) {
    try {
      var fn = bridge
      if (typeof fn !== "function" && typeof window[BINDING] === "function") fn = window[BINDING]
      if (typeof fn !== "function") return false
      var message = payload && typeof payload === "object" ? payload : {}
      message.token = TOKEN
      fn(stringify(message))
      return true
    } catch (error) {
      return false
    }
  }

  function scrollToEnd(element) {
    if (element) element.scrollTop = element.scrollHeight
  }

  function renderMessage(message) {
    var element = document.createElement("div")
    element.className = "msg " + message.role + (message.pending ? " pending" : "")
    element.textContent = message.text || (message.pending ? "…" : "")
    els.chat.appendChild(element)
    return element
  }

  function trimMessages() {
    while (state.messages.length > 40) state.messages.shift()
  }

  function addMessage(role, text, pending) {
    var message = { role: role, text: text || "", pending: !!pending }
    state.messages.push(message)
    trimMessages()
    var element = renderMessage(message)
    if (role === "assistant") currentAssistant = element
    else currentAssistant = null
    scrollToEnd(els.chat)
    return element
  }

  function setAssistant(text, done) {
    if (!currentAssistant) currentAssistant = addMessage("assistant", "", true)
    currentAssistant.textContent = text || (done ? "(нет ответа)" : "…")
    currentAssistant.classList.toggle("pending", !done && !text)
    var last = state.messages[state.messages.length - 1]
    if (last && last.role === "assistant") {
      last.text = text || ""
      last.pending = !done
    } else {
      state.messages.push({ role: "assistant", text: text || "", pending: !done })
      trimMessages()
    }
    scrollToEnd(els.chat)
  }

  function renderActivity(entry) {
    var line = document.createElement("div")
    line.className = "line " + (entry.level || "browser")
    line.textContent = clock(entry.at) + "  " + (entry.text || "")
    els.activity.appendChild(line)
    while (els.activity.childNodes.length > 80) els.activity.removeChild(els.activity.firstChild)
  }

  function addActivity(text, level, at) {
    var entry = { text: String(text || ""), level: level || "browser", at: at || Date.now() }
    state.activity.push(entry)
    while (state.activity.length > 80) state.activity.shift()
    renderActivity(entry)
    scrollToEnd(els.activity)
  }

  function setStatus(text, busy) {
    state.status = text || (busy ? "модель отвечает…" : "готово")
    state.busy = !!busy
    els.status.textContent = state.status
    els.dot.classList.toggle("on", !state.busy)
    els.input.disabled = state.busy
    els.send.disabled = state.busy
    els.input.placeholder = state.busy ? "модель отвечает…" : "Написать нейросети…"
  }

  function setUrl(url) {
    state.url = url || location.href
    els.url.textContent = state.url
    els.url.title = state.url
  }

  function clearAll() {
    state.messages = []
    state.activity = []
    currentAssistant = null
    els.chat.innerHTML = ""
    els.activity.innerHTML = ""
  }

  function restore(payload) {
    state.messages = Array.isArray(payload.messages) ? payload.messages.slice(-40) : []
    state.activity = Array.isArray(payload.activity) ? payload.activity.slice(-80) : []
    state.busy = !!payload.busy
    state.status = payload.status || (state.busy ? "модель отвечает…" : "готово")
    state.visible = payload.visible !== false
    state.url = payload.url || location.href
    els.chat.innerHTML = ""
    els.activity.innerHTML = ""
    currentAssistant = null
    for (var i = 0; i < state.messages.length; i += 1) {
      var message = state.messages[i]
      var element = renderMessage(message)
      if (message.role === "assistant") currentAssistant = element
      else currentAssistant = null
    }
    for (var j = 0; j < state.activity.length; j += 1) renderActivity(state.activity[j])
    setStatus(state.status, state.busy)
    setUrl(state.url)
    host.classList.toggle("hidden", !state.visible)
    scrollToEnd(els.chat)
    scrollToEnd(els.activity)
  }

  function apply(payload) {
    if (!payload || typeof payload !== "object") return
    if (payload.kind === "show") {
      state.visible = true
      host.classList.remove("hidden")
      return
    }
    if (payload.kind === "hide") {
      state.visible = false
      host.classList.add("hidden")
      return
    }
    if (payload.kind === "restore") {
      restore(payload)
      return
    }
    if (payload.kind === "activity") {
      addActivity(payload.text, payload.level, payload.at)
      return
    }
    if (payload.kind === "user") {
      addMessage("user", payload.text, false)
      return
    }
    if (payload.kind === "assistant") {
      setAssistant(payload.text, !!payload.done)
      return
    }
    if (payload.kind === "system") {
      addMessage("system", payload.text, false)
      return
    }
    if (payload.kind === "status") {
      setStatus(payload.text, !!payload.busy)
      return
    }
    if (payload.kind === "url") {
      setUrl(payload.url)
      return
    }
    if (payload.kind === "clear") {
      clearAll()
    }
  }

  function onSubmit(event) {
    if (event) event.preventDefault()
    var text = (els.input.value || "").trim()
    if (!text || state.busy) return
    els.input.value = ""
    var ok = send({ type: "chat", text: text })
    if (!ok) {
      addMessage("system", "Нет связи с opencode. Перезапустите opencode и плагин.", false)
      return
    }
    setStatus("модель отвечает…", true)
  }

  function init() {
    if (window[GLOBAL] || document.getElementById(HOST_ID)) return
    host = document.createElement("div")
    host.id = HOST_ID
    host.setAttribute("data-opencode-browser-overlay", "1")
    root = host.attachShadow({ mode: "closed" })
    var css = [
      ":host { all: initial; position: fixed; right: 14px; bottom: 14px; width: 370px; max-width: calc(100vw - 28px); display: block; z-index: 2147483647; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 12px; line-height: 1.45; color: #e8e8ea; contain: layout style; }",
      ":host(.hidden) { display: none; }",
      "*, *::before, *::after { box-sizing: border-box; }",
      ".panel { display: flex; flex-direction: column; width: 100%; max-height: min(540px, 58vh); background: rgba(18, 18, 22, 0.95); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; box-shadow: 0 14px 44px rgba(0, 0, 0, 0.5); overflow: hidden; backdrop-filter: blur(12px); }",
      ".head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255, 255, 255, 0.05); cursor: pointer; user-select: none; }",
      ".dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex: none; box-shadow: 0 0 8px rgba(245, 158, 11, 0.7); }",
      ".dot.on { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.7); }",
      ".title { font-weight: 600; font-size: 12px; white-space: nowrap; }",
      ".status { color: #9ca3af; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".spacer { flex: 1; }",
      ".btn { background: transparent; border: 0; color: #cbd5e1; cursor: pointer; font-family: inherit; font-size: 14px; line-height: 1; padding: 2px 5px; border-radius: 6px; }",
      ".btn:hover { background: rgba(255, 255, 255, 0.1); }",
      ".url { padding: 0 10px 7px; color: #93c5fd; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
      ".activity { border-top: 1px solid rgba(255, 255, 255, 0.08); max-height: 104px; overflow: auto; padding: 6px 10px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; color: #a7b0bd; }",
      ".activity .line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }",
      ".activity .line.error { color: #fca5a5; }",
      ".activity .line.info { color: #86efac; }",
      ".activity .line.tool { color: #c4b5fd; }",
      ".chat { border-top: 1px solid rgba(255, 255, 255, 0.08); max-height: 190px; overflow: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }",
      ".msg { padding: 6px 8px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; max-width: 100%; }",
      ".msg.user { align-self: flex-end; background: #2563eb; color: #fff; }",
      ".msg.assistant { align-self: flex-start; background: rgba(255, 255, 255, 0.08); color: #f1f5f9; }",
      ".msg.system { align-self: center; color: #9ca3af; font-size: 10px; text-align: center; }",
      ".msg.pending { color: #9ca3af; font-style: italic; }",
      ".composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid rgba(255, 255, 255, 0.08); }",
      ".input { flex: 1; min-width: 0; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.14); color: #fff; border-radius: 8px; padding: 6px 8px; font: inherit; outline: none; }",
      ".input:focus { border-color: #3b82f6; }",
      ".input:disabled { opacity: 0.5; }",
      ".send { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 0 10px; cursor: pointer; font-size: 14px; }",
      ".send:disabled { opacity: 0.5; cursor: default; }",
      ".panel.minimized .url, .panel.minimized .activity, .panel.minimized .chat, .panel.minimized .composer { display: none; }",
    ].join("\n")
    try {
      var sheet = new CSSStyleSheet()
      sheet.replaceSync(css)
      root.adoptedStyleSheets = [sheet]
    } catch (error) {
      var style = document.createElement("style")
      style.textContent = css
      root.appendChild(style)
    }
    var panel = document.createElement("div")
    panel.className = "panel"
    panel.innerHTML = [
      '<div class="head">',
      '<span class="dot"></span>',
      '<span class="title">opencode browser</span>',
      '<span class="status">подключение…</span>',
      '<span class="spacer"></span>',
      '<button class="btn min" type="button" title="Свернуть">–</button>',
      '<button class="btn clear" type="button" title="Очистить">×</button>',
      "</div>",
      '<div class="url"></div>',
      '<div class="activity"></div>',
      '<div class="chat"></div>',
      '<form class="composer"><input class="input" type="text" placeholder="Написать нейросети…" autocomplete="off" spellcheck="false"><button class="send" type="submit" title="Отправить">→</button></form>',
    ].join("")
    root.appendChild(panel)
    els = {
      panel: panel,
      head: panel.querySelector(".head"),
      dot: panel.querySelector(".dot"),
      status: panel.querySelector(".status"),
      url: panel.querySelector(".url"),
      activity: panel.querySelector(".activity"),
      chat: panel.querySelector(".chat"),
      form: panel.querySelector(".composer"),
      input: panel.querySelector(".input"),
      send: panel.querySelector(".send"),
    }
    els.form.addEventListener("submit", onSubmit)
    els.head.addEventListener("click", function (event) {
      if (event.target === els.min || event.target === els.clear) return
      minimized = !minimized
      panel.classList.toggle("minimized", minimized)
    })
    els.min = panel.querySelector(".min")
    els.clear = panel.querySelector(".clear")
    els.min.addEventListener("click", function (event) {
      event.stopPropagation()
      minimized = !minimized
      panel.classList.toggle("minimized", minimized)
    })
    els.clear.addEventListener("click", function (event) {
      event.stopPropagation()
      clearAll()
      send({ type: "clear" })
    })
    ;["keydown", "keyup", "keypress", "pointerdown", "mousedown", "mouseup", "click", "submit", "input"].forEach(function (type) {
      host.addEventListener(type, function (event) {
        event.stopPropagation()
      })
    })
    host.addEventListener("wheel", function (event) {
      event.stopPropagation()
    }, { passive: true })
    function attachHost() {
      if (document.documentElement && !host.isConnected) document.documentElement.appendChild(host)
    }
    attachHost()
    if (document.documentElement) new MutationObserver(attachHost).observe(document.documentElement, { childList: true })
    window[GLOBAL] = {
      apply: apply,
      show: function () { apply({ kind: "show" }) },
      hide: function () { apply({ kind: "hide" }) },
    }
    setStatus("готово", false)
    setUrl(location.href)
    var lastHref = location.href
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href
        setUrl(lastHref)
      }
    }, 1000)
    function announceReady() {
      if (!send({ type: "ready" })) setTimeout(announceReady, 500)
    }
    announceReady()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true })
  else init()
}

function overlaySource(token: string): string {
  return `(${overlayBootstrap.toString()})(${JSON.stringify(token)})`
}

const OVERLAY_SYSTEM = `You are the assistant inside the opencode browser overlay panel. The user chats with you in a small panel in the corner of the browser while a real Chromium browser is open. The browser is already running: use browser_snapshot before interacting with the page, and never close the browser. Use only browser_* tools; do not call shell, SSH, file, web-fetch, or other tools. You can use the browser_* tools to inspect and control that browser. browser_snapshot returns the page as text because you cannot see images. Keep replies short and practical; the panel is small. Reply in the user's language. Do not describe internal tool plumbing unless asked.`

const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_goto",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_hover",
  "browser_tabs",
  "browser_wait",
  "browser_eval",
  "browser_screenshot",
  "browser_history",
  "browser_overlay",
]

const OVERLAY_ALLOWED = new Set(BROWSER_TOOL_NAMES.filter((name) => !["browser_open", "browser_close", "browser_overlay"].includes(name)))

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.BROWSER_PATH,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe") : undefined,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Chromium", "Application", "chrome.exe") : undefined,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].filter(Boolean) as string[]

function findBrowser(explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Browser executable not found: ${explicit}`)
    return explicit
  }
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      continue
    }
  }
  throw new Error("No Chromium-based browser found. Set the CHROME_PATH env variable or pass executablePath to browser_open.")
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a debug port"))))
    })
  })
}

function killTreeSync(pid?: number) {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 })
    } else {
      process.kill(pid, "SIGKILL")
    }
  } catch {
    return
  }
}

function normalizeUrl(input: string): string {
  const value = (input || "").trim()
  if (!value) return "about:blank"
  try {
    if (fs.existsSync(value)) return pathToFileURL(path.resolve(value)).href
  } catch {
    return "about:blank"
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i.test(value)) return `http://${value}`
  if (/^[^\s\\]+\.[^\s\\]{2,}([/?#]|$)/.test(value)) return `https://${value}`
  return `https://${value}`
}

function cleanText(value: unknown, max = 200): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

async function wsText(data: any): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as any)
  if (data && typeof data.text === "function") return await data.text()
  return String(data)
}

async function http(url: string, init?: any, timeout = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function cdpErrorMessage(details: any): string {
  const exception = details?.exception
  if (exception?.description) return exception.description
  if (details?.text) return details.text
  return "JavaScript evaluation failed"
}

class Cdp {
  private ws: any
  private nextId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private handlers = new Map<string, Set<(params: any) => void>>()
  closed = false

  private constructor(ws: any) {
    this.ws = ws
    ws.addEventListener("message", async (event: any) => {
      let message: any
      try {
        message = JSON.parse(await wsText(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`))
        else pending.resolve(message.result)
        return
      }
      if (typeof message.method === "string") {
        const listeners = this.handlers.get(message.method)
        if (!listeners) return
        for (const listener of listeners) {
          try {
            listener(message.params)
          } catch {
            continue
          }
        }
      }
    })
    ws.addEventListener("close", () => {
      this.closed = true
      for (const pending of this.pending.values()) pending.reject(new Error("Browser connection closed"))
      this.pending.clear()
    })
    ws.addEventListener("error", () => {
      this.closed = true
    })
  }

  static connect(url: string, timeout = 15000): Promise<Cdp> {
    const ws = new (globalThis as any).WebSocket(url)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          return
        }
        reject(new Error(`Timed out connecting to DevTools at ${url}`))
      }, timeout)
      const onOpen = () => {
        clearTimeout(timer)
        cleanup()
        resolve(new Cdp(ws))
      }
      const onError = () => {
        clearTimeout(timer)
        cleanup()
        reject(new Error(`Failed to connect to DevTools at ${url}`))
      }
      const cleanup = () => {
        ws.removeEventListener("open", onOpen)
        ws.removeEventListener("error", onError)
      }
      ws.addEventListener("open", onOpen)
      ws.addEventListener("error", onError)
    })
  }

  send<T = any>(method: string, params: any = {}, timeout = 30000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser connection is closed"))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools command timed out: ${method}`))
      }, timeout)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  on(method: string, listener: (params: any) => void): () => void {
    let listeners = this.handlers.get(method)
    if (!listeners) {
      listeners = new Set()
      this.handlers.set(method, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners!.delete(listener)
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close()
    } catch {
      return
    }
  }
}

class BrowserSession {
  options: Required<Pick<BrowserOptions, "headless" | "width" | "height" | "timeoutMs" | "overlay">> & { executablePath?: string }
  private proc?: ChildProcess
  private port?: number
  private cdp?: Cdp
  private targetId?: string
  private profile?: string
  private browserName = "Chromium"
  private logs: LogEntry[] = []
  private starting?: Promise<void>
  private exitHandler?: () => void
  private overlayToken = randomUUID()
  private overlayInjected = false
  private overlayReady = false
  private overlayVisible = true
  private overlayBusy = false
  private overlayStatus = "готово"
  private overlayUrl = "about:blank"
  private overlayMessages: OverlayMessage[] = []
  private overlayActivities: OverlayActivity[] = []
  onChat?: (text: string) => void

  constructor(options: BrowserOptions = {}) {
    this.options = {
      headless: options.headless ?? false,
      width: options.width ?? 1280,
      height: options.height ?? 900,
      timeoutMs: options.timeoutMs ?? 25000,
      overlay: options.overlay ?? true,
      executablePath: options.executablePath,
    }
  }

  private isRunning() {
    return !!(this.proc && this.proc.exitCode === null && this.port)
  }

  private async ensure() {
    if (this.cdp && !this.cdp.closed) return
    if (!this.starting) {
      this.starting = this.startInternal().finally(() => {
        this.starting = undefined
      })
    }
    await this.starting
  }

  private async startInternal() {
    if (this.isRunning()) {
      try {
        await this.connectPage()
        return
      } catch {
        await this.close()
      }
    }
    await this.launch()
  }

  async launch() {
    if (this.isRunning() && this.cdp && !this.cdp.closed) return
    await this.close()
    const executable = findBrowser(this.options.executablePath)
    const port = await freePort()
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-"))
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-popup-blocking",
      "--disable-features=Translate,OptimizationHints,MediaRouter,ChromeWhatsNewUI",
      "--metrics-recording-only",
      "--mute-audio",
      "--hide-crash-restore-bubble",
      `--window-size=${this.options.width},${this.options.height}`,
      "--window-position=40,40",
    ]
    if (this.options.headless) args.push("--headless=new")
    args.push("about:blank")

    const proc = spawn(executable, args, { stdio: "ignore", windowsHide: true })
    this.proc = proc
    this.port = port
    this.profile = profile
    this.exitHandler = () => killTreeSync(proc.pid)
    process.once("exit", this.exitHandler)

    try {
      const version = await this.waitForDevtools(port, proc)
      this.browserName = cleanText(version?.Browser || path.basename(executable), 80)
      await this.connectPage()
      this.noteActivity(`browser started: ${this.browserName} (${this.options.headless ? "headless" : "headed"})`, "info")
    } catch (error) {
      this.kill()
      throw error
    }
  }

  private async waitForDevtools(port: number, proc: ChildProcess) {
    const deadline = Date.now() + this.options.timeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`Browser exited during startup (code ${proc.exitCode}). Try executablePath or restart=true.`)
      }
      try {
        const response = await http(`http://127.0.0.1:${port}/json/version`, undefined, 1500)
        if (response.ok) return await response.json()
      } catch (error) {
        lastError = error
      }
      await sleep(200)
    }
    throw new Error(`Browser DevTools did not start on port ${port}: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timeout")}`)
  }

  private async listTargets(): Promise<TargetInfo[]> {
    if (!this.port) return []
    const response = await http(`http://127.0.0.1:${this.port}/json/list`, undefined, 5000)
    if (!response.ok) throw new Error(`Could not list browser tabs (HTTP ${response.status})`)
    const data = (await response.json()) as TargetInfo[]
    return Array.isArray(data) ? data.filter((target) => target.type === "page") : []
  }

  private async newTarget(url: string): Promise<TargetInfo> {
    if (!this.port) throw new Error("Browser is not running")
    const response = await http(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }, 10000)
    if (!response.ok) throw new Error(`Could not open a new tab (HTTP ${response.status})`)
    return (await response.json()) as TargetInfo
  }

  private async connectPage() {
    const targets = await this.listTargets()
    const target = targets.find((item) => item.id === this.targetId) || targets[0] || (await this.newTarget("about:blank"))
    await this.attach(target)
  }

  private async attach(target: TargetInfo) {
    if (!target.webSocketDebuggerUrl) throw new Error("Tab has no DevTools endpoint")
    this.cdp?.close()
    this.cdp = undefined
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    this.cdp = cdp
    this.targetId = target.id
    this.logs = []
    this.overlayInjected = false
    this.overlayReady = false
    if (target.url) this.overlayUrl = target.url
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Log.enable")
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined)
    cdp.on("Runtime.bindingCalled", (params) => {
      if (params?.name !== OVERLAY_BINDING) return
      let message: any
      try {
        message = JSON.parse(params.payload)
      } catch {
        return
      }
      if (!message || typeof message !== "object") return
      if (message.token !== this.overlayToken) return
      if (message.type === "ready") {
        this.overlayReady = true
        this.restoreOverlay()
      } else if (message.type === "chat" && typeof message.text === "string") {
        this.onChat?.(message.text)
      } else if (message.type === "clear") {
        this.overlayMessages = []
        this.overlayActivities = []
      }
    })
    cdp.on("Page.javascriptDialogOpening", (params) => {
      this.noteActivity(`dialog: ${cleanText(params?.message, 160)}`, "info")
      void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined)
    })
    cdp.on("Page.frameNavigated", (params) => {
      const frame = params?.frame
      if (frame?.parentId) return
      this.logs = []
      this.overlayReady = false
      if (frame?.url && frame.url !== this.overlayUrl) {
        this.overlayUrl = frame.url
        this.noteActivity(`→ ${frame.url}`, "browser")
      }
    })
    cdp.on("Page.loadEventFired", () => {
      void this.installOverlay()
    })
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params?.args || [])
        .map((arg: any) => arg?.value ?? arg?.description ?? arg?.type ?? "")
        .join(" ")
      const level = String(params?.type || "log")
      this.pushLog(level, text)
      if (/^(error|assert)$/i.test(level)) this.noteActivity(`console: ${text}`, "error")
    })
    cdp.on("Log.entryAdded", (params) => {
      const entry = params?.entry
      if (!entry) return
      const text = `${entry.text || ""}${entry.url ? ` (${entry.url})` : ""}`
      this.pushLog(String(entry.level || "info"), text)
      if (/^(error|assert)$/i.test(String(entry.level || ""))) this.noteActivity(`console: ${text}`, "error")
    })
    await this.installOverlay()
  }

  private overlayPayload(payload: OverlayPayload) {
    if (!this.options.overlay || !this.overlayReady || !this.cdp) return
    const expression = `(() => { const overlay = window.${OVERLAY_GLOBAL}; if (!overlay || typeof overlay.apply !== "function") return false; overlay.apply(${JSON.stringify(payload)}); return true })()`
    this.eval<boolean>(expression, false)
      .then((ok) => {
        if (!ok) this.overlayReady = false
      })
      .catch(() => {
        this.overlayReady = false
      })
  }

  private restoreOverlay() {
    this.overlayPayload({
      kind: "restore",
      messages: this.overlayMessages,
      activity: this.overlayActivities,
      busy: this.overlayBusy,
      status: this.overlayStatus,
      visible: this.overlayVisible,
      url: this.overlayUrl,
    })
  }

  private async installOverlay() {
    if (!this.options.overlay || !this.cdp) return
    try {
      const source = overlaySource(this.overlayToken)
      if (!this.overlayInjected) {
        await this.cdp.send("Runtime.addBinding", { name: OVERLAY_BINDING }).catch(() => undefined)
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }).catch(() => undefined)
        this.overlayInjected = true
      }
      await this.eval(source, false)
    } catch {
      return
    }
  }

  noteActivity(text: string, level: OverlayActivity["level"] = "browser") {
    if (!this.options.overlay) return
    const entry: OverlayActivity = { text: cleanText(text, 400), level, at: Date.now() }
    if (!entry.text) return
    this.overlayActivities.push(entry)
    if (this.overlayActivities.length > 80) this.overlayActivities.shift()
    this.overlayPayload({ kind: "activity", text: entry.text, level: entry.level, at: entry.at })
  }

  noteError(text: string) {
    this.noteActivity(`error: ${text}`, "error")
  }

  appendUserMessage(text: string) {
    const last = this.overlayMessages[this.overlayMessages.length - 1]
    if (last && last.role === "assistant" && last.pending) last.pending = false
    this.overlayMessages.push({ role: "user", text })
    if (this.overlayMessages.length > 40) this.overlayMessages.shift()
    this.overlayPayload({ kind: "user", text })
  }

  appendSystemMessage(text: string) {
    this.overlayMessages.push({ role: "system", text })
    if (this.overlayMessages.length > 40) this.overlayMessages.shift()
    this.overlayPayload({ kind: "system", text })
  }

  failAssistant(text: string) {
    const last = this.overlayMessages[this.overlayMessages.length - 1]
    if (last && last.role === "assistant" && last.pending) {
      this.streamAssistant(last.text ? `${last.text}\n\nОшибка: ${text}` : `Ошибка: ${text}`, true)
      return
    }
    this.appendSystemMessage(`Ошибка: ${text}`)
  }

  streamAssistant(text: string, done: boolean) {
    let last = this.overlayMessages[this.overlayMessages.length - 1]
    if (!last || last.role !== "assistant" || last.pending === false) {
      last = { role: "assistant", text: "", pending: true }
      this.overlayMessages.push(last)
      if (this.overlayMessages.length > 40) this.overlayMessages.shift()
    }
    last.text = text
    last.pending = !done
    this.overlayPayload({ kind: "assistant", text, done })
  }

  setChatBusy(busy: boolean, status?: string) {
    this.overlayBusy = busy
    this.overlayStatus = status || (busy ? "модель отвечает…" : "готово")
    this.overlayPayload({ kind: "status", text: this.overlayStatus, busy })
  }

  private setOverlayVisible(visible: boolean) {
    this.overlayVisible = visible
    this.overlayPayload({ kind: visible ? "show" : "hide" })
  }

  async overlay(action: "show" | "hide" | "toggle" | "status" = "status") {
    if (!this.options.overlay) return "Overlay: disabled"
    if (action === "status" && (!this.cdp || !this.proc)) {
      return `Overlay: enabled, browser not running, ${this.overlayVisible ? "visible" : "hidden"}`
    }
    await this.ensure()
    await this.installOverlay()
    if (action === "show") this.setOverlayVisible(true)
    else if (action === "hide") this.setOverlayVisible(false)
    else if (action === "toggle") this.setOverlayVisible(!this.overlayVisible)
    return `Overlay: ${this.options.overlay ? "enabled" : "disabled"}, ${this.overlayVisible ? "visible" : "hidden"}, ready=${this.overlayReady}\nURL: ${this.overlayUrl}`
  }

  private pushLog(level: string, text: string) {
    const value = cleanText(text, 600)
    if (!value) return
    this.logs.push({ level, text: value, at: Date.now() })
    if (this.logs.length > 60) this.logs.splice(0, this.logs.length - 60)
  }

  private async eval<T = any>(expression: string, awaitPromise = true): Promise<T> {
    if (!this.cdp) throw new Error("Browser tab is not connected")
    const result = await this.cdp.send<any>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result?.exceptionDetails) throw new Error(cdpErrorMessage(result.exceptionDetails))
    const value = result?.result?.value
    if (value === undefined && result?.result?.type === "undefined") return undefined as T
    return value as T
  }

  private async waitReady(timeout = 10000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.cdp?.closed) throw new Error("Browser tab was closed")
      try {
        const state = await this.eval<string>("document.readyState", false)
        if (state === "complete") return
      } catch {
        return
      }
      await sleep(100)
    }
  }

  private async waitForPossibleNavigation(beforeUrl: string) {
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      try {
        const href = await this.eval<string>("location.href", false)
        if (href !== beforeUrl) break
      } catch {
        break
      }
      await sleep(100)
    }
    await this.waitReady(8000).catch(() => undefined)
    await sleep(150)
  }

  async open(options: { url?: string; headless?: boolean; executablePath?: string; restart?: boolean } = {}) {
    const wasRunning = this.isRunning() && !!this.cdp && !this.cdp.closed
    const apply = !wasRunning || options.restart === true
    if (apply && options.headless !== undefined) this.options.headless = options.headless
    if (apply && options.executablePath) this.options.executablePath = options.executablePath
    if (options.restart) await this.close()
    await this.ensure()
    const note = !apply && (options.headless !== undefined || options.executablePath)
      ? "\n(already running; restart=true applies headless/executablePath changes)"
      : ""
    if (options.url) await this.goto(options.url)
    const info = await this.eval<any>("({url: location.href, title: document.title})", false).catch(() => ({ url: "about:blank", title: "" }))
    return `Browser: ${this.browserName} (${this.options.headless ? "headless" : "headed"}) port ${this.port}${note}\nURL: ${info?.url || "about:blank"}\nTITLE: ${cleanText(info?.title) || "(none)"}`
  }

  async goto(url: string) {
    await this.ensure()
    const target = normalizeUrl(url)
    let loaded = false
    const off = this.cdp!.on("Page.loadEventFired", () => {
      loaded = true
    })
    try {
      const result = await this.cdp!.send<any>("Page.navigate", { url: target })
      if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
      const deadline = Date.now() + this.options.timeoutMs
      while (!loaded && Date.now() < deadline) await sleep(100)
      await this.waitReady(8000).catch(() => undefined)
      await sleep(150)
    } finally {
      off()
    }
    return target
  }

  async history(action: "back" | "forward" | "reload"): Promise<string> {
    await this.ensure()
    const before = await this.eval<string>("location.href", false).catch(() => "")
    await this.eval(action === "reload" ? "location.reload()" : `history.${action}()`, false)
    this.noteActivity(`history ${action}`)
    await sleep(300)
    await this.waitForPossibleNavigation(before)
    return this.snapshot({ maxTextChars: 1500, maxElements: 50 })
  }

  async snapshot(options: SnapshotOptions = {}): Promise<string> {
    await this.ensure()
    const maxTextChars = Math.max(200, Math.min(options.maxTextChars ?? 6000, 40000))
    const maxElements = Math.max(1, Math.min(options.maxElements ?? 120, 400))
    const script = `(() => {
      const MAX_TEXT = ${maxTextChars + 500};
      const MAX_ELEMENTS = 400;
      document.querySelectorAll('[data-oc-ref]').forEach((el) => el.removeAttribute('data-oc-ref'));
      const inline = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      };
      const labelOf = (el) => {
        const aria = el.getAttribute('aria-label') || el.getAttribute('title');
        if (aria) return aria.replace(/\\s+/g, ' ').trim().slice(0, 120);
        if (el.labels && el.labels.length) return Array.from(el.labels).map((label) => inline(label)).filter(Boolean).join(' ').slice(0, 120);
        if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').slice(0, 120);
        return inline(el).slice(0, 120);
      };
      const selector = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=switch],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
      const nodes = Array.from(document.querySelectorAll(selector));
      const elements = [];
      let index = 0;
      for (const el of nodes) {
        if (index >= MAX_ELEMENTS) break;
        index += 1;
        const ref = 'e' + index;
        el.setAttribute('data-oc-ref', ref);
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const entry = {
          ref,
          tag,
          type: tag === 'input' ? (el.getAttribute('type') || 'text') : (el.getAttribute('role') || ''),
          name: labelOf(el),
          visible: visible(el),
          offscreen: rect.bottom < 0 || rect.top > (window.innerHeight || 0) || rect.right < 0 || rect.left > (window.innerWidth || 0),
        };
        if (el.disabled) entry.disabled = true;
        if (el.checked !== undefined) entry.checked = !!el.checked;
        if (el.readOnly) entry.readonly = true;
        if (el.required) entry.required = true;
        if (tag === 'a' && el.getAttribute('href')) entry.href = el.getAttribute('href').slice(0, 180);
        if (tag === 'input' || tag === 'textarea') {
          const value = el.type === 'password' ? '***' : String(el.value || '');
          if (value) entry.value = value.slice(0, 100);
          const placeholder = el.getAttribute('placeholder');
          if (placeholder) entry.placeholder = placeholder.slice(0, 100);
        }
        if (tag === 'select') {
          entry.options = Array.from(el.options).slice(0, 25).map((option) => ({
            value: String(option.value).slice(0, 80),
            label: String(option.label || option.text || '').slice(0, 80),
            selected: option.selected,
          }));
        }
        if (el.getAttribute('aria-expanded') !== null) entry.expanded = el.getAttribute('aria-expanded');
        elements.push(entry);
      }
      const rawText = document.body ? (document.body.innerText || '') : (document.documentElement ? (document.documentElement.innerText || '') : '');
      const bodyText = rawText.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, MAX_TEXT);
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role=heading]')).slice(0, 30).map((heading) => {
        const aria = Number(heading.getAttribute('aria-level'));
        const inferred = heading.tagName === 'H1' ? 1 : heading.tagName === 'H2' ? 2 : heading.tagName === 'H3' ? 3 : 4;
        return { level: aria || inferred, text: inline(heading).slice(0, 160) };
      }).filter((heading) => heading.text);
      return {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollY: Math.round(window.scrollY),
          scrollHeight: Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0),
        },
        text: bodyText,
        textLength: rawText.length,
        headings,
        elements,
        totalElements: elements.length,
      };
    })()`
    const data = await this.eval<SnapshotData>(script, false)
    if (data.url && data.url !== this.overlayUrl) {
      this.overlayUrl = data.url
      this.overlayPayload({ kind: "url", url: data.url })
    }
    return this.formatSnapshot(data, maxTextChars, maxElements)
  }

  private formatSnapshot(data: SnapshotData, maxTextChars: number, maxElements: number): string {
    const lines: string[] = []
    lines.push(`URL: ${data.url || "about:blank"}`)
    lines.push(`TITLE: ${cleanText(data.title) || "(none)"}`)
    const viewport = data.viewport || { width: 0, height: 0, scrollY: 0, scrollHeight: 0 }
    lines.push(`VIEWPORT: ${viewport.width}x${viewport.height}, scrollY=${viewport.scrollY}/${viewport.scrollHeight}`)
    if (data.headings?.length) {
      lines.push("HEADINGS:")
      for (const heading of data.headings) lines.push(`  h${heading.level} ${cleanText(heading.text, 160)}`)
    }
    let text = String(data.text || "")
    if (text.length > maxTextChars) text = `${text.slice(0, maxTextChars)}\n...[${text.length - maxTextChars} chars truncated]`
    lines.push("PAGE TEXT:")
    lines.push(text || "(empty)")
    const visibleElements = (data.elements || []).filter((element) => element.visible)
    const shown = visibleElements.slice(0, maxElements)
    lines.push(`INTERACTIVE ELEMENTS (${shown.length} of ${visibleElements.length} visible, ${data.totalElements} detected):`)
    if (!shown.length) lines.push("  (none)")
    for (const element of shown) {
      const tag = element.tag
      const kind = tag === "input" ? `input:${element.type || "text"}` : element.type ? `${tag}[${element.type}]` : tag
      const flags: string[] = []
      if (element.offscreen) flags.push("offscreen")
      if (element.disabled) flags.push("disabled")
      if (element.checked) flags.push("checked")
      if (element.readonly) flags.push("readonly")
      if (element.required) flags.push("required")
      if (element.expanded !== undefined) flags.push(`expanded=${element.expanded}`)
      if (element.value !== undefined && element.value !== "") flags.push(`value="${cleanText(element.value, 100)}"`)
      if (element.placeholder) flags.push(`placeholder="${cleanText(element.placeholder, 100)}"`)
      if (element.href) flags.push(`href=${cleanText(element.href, 180)}`)
      if (element.options?.length) {
        const options = element.options.map((option: any) => `${option.value}${option.selected ? "*" : ""}`).join("|")
        flags.push(`options=[${cleanText(options, 220)}]`)
      }
      lines.push(`  [${element.ref}] <${kind}> "${cleanText(element.name, 120)}"${flags.length ? ` ${flags.join(" ")}` : ""}`)
    }
    if (visibleElements.length > shown.length) lines.push(`  ...${visibleElements.length - shown.length} more not shown`)
    const errors = this.logs.filter((entry) => /^(error|assert)$/i.test(entry.level)).slice(-5)
    if (errors.length) {
      lines.push("CONSOLE ERRORS:")
      for (const entry of errors) lines.push(`  ${cleanText(entry.text, 400)}`)
    }
    return lines.join("\n")
  }

  private lookupCode(ref: string | undefined, selector: string | undefined): string {
    return `const REF = ${JSON.stringify(ref || null)};
      const SEL = ${JSON.stringify(selector || null)};
      let el = null;
      if (REF) el = document.querySelector('[data-oc-ref="' + String(REF).replace(/"/g, '') + '"]');
      else if (SEL) el = document.querySelector(SEL);
      if (!el) throw new Error(REF ? 'Ref ' + REF + ' not found (page changed?). Run browser_snapshot again.' : 'Selector not found: ' + SEL);`
  }

  private async actionSnapshot(label: string, options: ActionOptions, extra?: string) {
    if (options.snapshot === false) return `${label}${extra ? `\n${extra}` : ""}\n(no snapshot; call browser_snapshot to see the page)`
    await this.waitReady(5000).catch(() => undefined)
    await sleep(200)
    const snapshot = await this.snapshot({
      maxTextChars: options.maxTextChars ?? 1500,
      maxElements: options.maxElements ?? 50,
    })
    return `${label}${extra ? `\n${extra}` : ""}\n\n${snapshot}`
  }

  async click(options: ActionOptions & { ref?: string; selector?: string }): Promise<string> {
    await this.ensure()
    if (!options.ref && !options.selector) throw new Error("Provide ref (from browser_snapshot) or selector")
    const before = await this.eval<string>("location.href", false).catch(() => "")
    const info = await this.eval<any>(`(() => {
      ${this.lookupCode(options.ref, options.selector)}
      if (el.disabled) throw new Error('Element is disabled');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) throw new Error('Element is not visible');
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        tag: el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      };
    })()`, false)
    await sleep(60)
    const x = Number(info.x)
    const y = Number(info.y)
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
    this.noteActivity(`click <${info.tag}> "${cleanText(info.name)}"`)
    await this.waitForPossibleNavigation(before)
    return this.actionSnapshot(`Clicked <${info.tag}> "${cleanText(info.name)}"`, options)
  }

  async type(options: ActionOptions & { ref?: string; selector?: string; text: string; append?: boolean; submit?: boolean }): Promise<string> {
    await this.ensure()
    if (!options.ref && !options.selector) throw new Error("Provide ref (from browser_snapshot) or selector")
    if (typeof options.text !== "string") throw new Error("text is required")
    const before = await this.eval<string>("location.href", false).catch(() => "")
    const info = await this.eval<any>(`(() => {
      ${this.lookupCode(options.ref, options.selector)}
      const TEXT = ${JSON.stringify(options.text)};
      const APPEND = ${options.append ? "true" : "false"};
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });
      const tag = el.tagName.toLowerCase();
      const labels = el.labels && el.labels.length ? Array.from(el.labels).map((label) => label.innerText || '').join(' ') : '';
      const name = (el.getAttribute('aria-label') || labels || el.getAttribute('placeholder') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (tag === 'select') {
        const wanted = String(TEXT).trim();
        const options = Array.from(el.options);
        const match = options.find((option) => option.value === wanted) || options.find((option) => String(option.label || option.text || '').trim().toLowerCase() === wanted.toLowerCase());
        if (!match) throw new Error('Option not found. Available: ' + options.map((option) => option.value).slice(0, 30).join(', '));
        el.value = match.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { kind: 'select', tag, name, selected: match.value };
      }
      if (!APPEND) {
        if (el.isContentEditable) {
          el.textContent = '';
        } else if (tag === 'input' || tag === 'textarea') {
          const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, '');
        } else {
          throw new Error('Element <' + tag + '> is not editable');
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { kind: 'text', tag, name, password: tag === 'input' && el.type === 'password' };
    })()`, false)
    if (info.kind !== "select") {
      await sleep(50)
      await this.cdp!.send("Input.insertText", { text: options.text })
    }
    if (options.submit) {
      await sleep(80)
      await this.pressKey("Enter")
      await this.waitForPossibleNavigation(before)
    } else if (info.kind === "select") {
      await this.waitForPossibleNavigation(before)
    } else {
      await sleep(100)
    }
    const typed = info.password ? "***" : JSON.stringify(options.text)
    const label = info.kind === "select"
      ? `Selected "${cleanText(info.selected)}" in <select> "${cleanText(info.name)}"`
      : `Typed ${typed} into <${info.tag}> "${cleanText(info.name)}"`
    this.noteActivity(info.kind === "select" ? `select "${cleanText(info.selected)}"` : `type ${typed} → <${info.tag}> "${cleanText(info.name)}"`)
    return this.actionSnapshot(label, options)
  }

  private async pressKey(key: string) {
    const parts = key.split("+").map((part) => part.trim()).filter(Boolean)
    const main = parts.pop() || ""
    let modifiers = 0
    for (const part of parts) {
      const lower = part.toLowerCase()
      if (lower === "alt") modifiers |= 1
      else if (lower === "ctrl" || lower === "control") modifiers |= 2
      else if (lower === "meta" || lower === "cmd" || lower === "win") modifiers |= 4
      else if (lower === "shift") modifiers |= 8
    }
    const special: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
      enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      tab: { key: "Tab", code: "Tab", keyCode: 9 },
      escape: { key: "Escape", code: "Escape", keyCode: 27 },
      esc: { key: "Escape", code: "Escape", keyCode: 27 },
      backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      delete: { key: "Delete", code: "Delete", keyCode: 46 },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      home: { key: "Home", code: "Home", keyCode: 36 },
      end: { key: "End", code: "End", keyCode: 35 },
      pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
      pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
      space: { key: " ", code: "Space", keyCode: 32, text: " " },
    }
    const known = special[main.toLowerCase()]
    const isChar = main.length === 1
    const payload: any = known
      ? { key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode, nativeVirtualKeyCode: known.keyCode, modifiers, text: known.text, unmodifiedText: known.text }
      : { key: main, code: isChar ? `Key${main.toUpperCase()}` : main, modifiers }
    if (!known && !isChar) throw new Error(`Unknown key: ${key}`)
    if (!known && isChar && !modifiers) {
      payload.text = main
      payload.unmodifiedText = main
    }
    await this.cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", ...payload })
    await this.cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", ...payload })
  }

  async press(options: ActionOptions & { key: string }): Promise<string> {
    await this.ensure()
    if (!options.key) throw new Error("key is required")
    const before = await this.eval<string>("location.href", false).catch(() => "")
    await this.pressKey(options.key)
    this.noteActivity(`press ${options.key}`)
    if (/enter|return|space/i.test(options.key)) await this.waitForPossibleNavigation(before)
    else await sleep(150)
    return this.actionSnapshot(`Pressed ${options.key}`, options)
  }

  async scroll(options: ActionOptions & { dy?: number; to?: "top" | "bottom" }): Promise<string> {
    await this.ensure()
    if (options.to === "top" || options.to === "bottom") {
      await this.eval(`window.scrollTo({ top: ${options.to === "top" ? 0 : "document.documentElement.scrollHeight"}, behavior: 'instant' })`, false)
    } else {
      const viewport = await this.eval<any>("({ width: innerWidth, height: innerHeight })", false)
      const dy = options.dy ?? 600
      await this.cdp!.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(Number(viewport?.width || 800) / 2),
        y: Math.round(Number(viewport?.height || 600) / 2),
        deltaX: 0,
        deltaY: dy,
        modifiers: 0,
      })
    }
    await sleep(250)
    this.noteActivity(`scroll ${options.to || `${options.dy ?? 600}px`}`)
    return this.actionSnapshot(`Scrolled ${options.to || `${options.dy ?? 600}px`}`, options)
  }

  async hover(options: ActionOptions & { ref?: string; selector?: string }): Promise<string> {
    await this.ensure()
    if (!options.ref && !options.selector) throw new Error("Provide ref (from browser_snapshot) or selector")
    const info = await this.eval<any>(`(() => {
      ${this.lookupCode(options.ref, options.selector)}
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) };
    })()`, false)
    await sleep(50)
    await this.cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(info.x), y: Number(info.y) })
    await sleep(250)
    this.noteActivity(`hover <${info.tag}> "${cleanText(info.name)}"`)
    return this.actionSnapshot(`Hovered <${info.tag}> "${cleanText(info.name)}"`, options)
  }

  async tabs(options: { action?: "list" | "new" | "switch" | "close"; index?: number; id?: string; url?: string } = {}): Promise<string> {
    await this.ensure()
    const action = options.action || "list"
    this.noteActivity(`tabs ${action}${options.url ? ` ${options.url}` : ""}`)
    if (action === "new") {
      const target = await this.newTarget(normalizeUrl(options.url || "about:blank"))
      await this.attach(target)
      await this.waitReady(5000).catch(() => undefined)
    } else if (action === "switch") {
      const targets = await this.listTargets()
      const target = options.id ? targets.find((item) => item.id === options.id) : options.index ? targets[options.index - 1] : undefined
      if (!target) throw new Error("Tab not found. Use browser_tabs action=list to see tabs.")
      await this.attach(target)
      await this.waitReady(5000).catch(() => undefined)
    } else if (action === "close") {
      const targets = await this.listTargets()
      const target = options.id
        ? targets.find((item) => item.id === options.id)
        : options.index
          ? targets[options.index - 1]
          : targets.find((item) => item.id === this.targetId) || targets[0]
      if (!target) throw new Error("Tab not found")
      await http(`http://127.0.0.1:${this.port}/json/close/${target.id}`, undefined, 5000).catch(() => undefined)
      if (target.id === this.targetId) {
        this.cdp?.close()
        this.cdp = undefined
        const remaining = (await this.listTargets()).filter((item) => item.id !== target.id)
        if (remaining[0]) await this.attach(remaining[0])
        else await this.connectPage()
      }
    }
    const targets = await this.listTargets()
    const lines = targets.map((target, index) => {
      const marker = target.id === this.targetId ? "*" : " "
      return `${marker} ${index + 1}. ${cleanText(target.title) || "(untitled)"} — ${cleanText(target.url, 300)}`
    })
    return `TABS:\n${lines.join("\n") || "(none)"}\n(* = active)`
  }

  async waitFor(options: { ms?: number; selector?: string; timeoutMs?: number }): Promise<string> {
    await this.ensure()
    if (options.selector) {
      const timeout = Math.max(500, Math.min(options.timeoutMs ?? 10000, 120000))
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const found = await this.eval<boolean>(`!!document.querySelector(${JSON.stringify(options.selector)})`, false).catch(() => false)
        if (found) {
          this.noteActivity(`selector appeared: ${options.selector}`)
          return `Selector appeared after ${timeout - (deadline - Date.now())}ms: ${options.selector}`
        }
        await sleep(150)
      }
      throw new Error(`Timed out after ${timeout}ms waiting for selector: ${options.selector}`)
    }
    const ms = Math.max(0, Math.min(options.ms ?? 1000, 120000))
    await sleep(ms)
    this.noteActivity(`wait ${ms}ms`)
    return `Waited ${ms}ms`
  }

  async evaluate(expression: string, awaitPromise = true): Promise<string> {
    await this.ensure()
    if (!expression) throw new Error("expression is required")
    this.noteActivity(`eval (${expression.length} chars)`, "tool")
    if (!this.cdp) throw new Error("Browser tab is not connected")
    const result = await this.cdp.send<any>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, 60000)
    if (result?.exceptionDetails) throw new Error(cdpErrorMessage(result.exceptionDetails))
    const value = result?.result?.value
    if (value === undefined) return result?.result?.description ?? "undefined"
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  async screenshot(options: { path?: string; fullPage?: boolean; attach?: boolean } = {}) {
    await this.ensure()
    let data: string
    if (options.fullPage) {
      const metrics = await this.cdp!.send<any>("Page.getLayoutMetrics")
      const size = metrics?.cssContentSize || metrics?.contentSize || {}
      const width = Math.max(1, Math.ceil(Number(size.width || this.options.width)))
      const height = Math.max(1, Math.ceil(Number(size.height || this.options.height)))
      const result = await this.cdp!.send<any>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }, 60000)
      data = result.data
    } else {
      const result = await this.cdp!.send<any>("Page.captureScreenshot", { format: "png" }, 60000)
      data = result.data
    }
    const file = path.resolve(options.path || path.join(os.tmpdir(), `opencode-browser-${Date.now()}.png`))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, "base64"))
    const bytes = Math.round((data.length * 3) / 4)
    this.noteActivity(`screenshot → ${file}`)
    const label = `Screenshot saved: ${file} (${Math.round(bytes / 1024)} KB). The model cannot view images; this file is for the user.`
    if (!options.attach) return label
    return {
      title: "Screenshot",
      output: label,
      attachments: [{ type: "file" as const, mime: "image/png", url: `data:image/png;base64,${data}`, filename: path.basename(file) }],
    }
  }

  async close(): Promise<string> {
    if (!this.proc && !this.cdp) return "Browser is not running."
    this.cdp?.close()
    this.cdp = undefined
    this.overlayReady = false
    this.overlayInjected = false
    this.kill()
    if (this.profile) {
      const profile = this.profile
      this.profile = undefined
      await sleep(150)
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        return "Browser closed (temporary profile could not be removed)."
      }
    }
    return "Browser closed."
  }

  private kill() {
    const pid = this.proc?.pid
    this.proc = undefined
    this.port = undefined
    this.targetId = undefined
    this.overlayReady = false
    this.overlayInjected = false
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler)
      this.exitHandler = undefined
    }
    killTreeSync(pid)
  }
}

export const BrowserToolsPlugin: Plugin = async ({ client, directory }, options) => {
  const opts = (options || {}) as Record<string, any>
  const envHeadless = /^(1|true|yes|on)$/i.test(process.env.OPENCODE_BROWSER_HEADLESS || "")
  const overlayEnv = String(process.env.OPENCODE_BROWSER_OVERLAY || "").toLowerCase()
  const overlayEnabled = opts.overlay !== false && overlayEnv !== "0" && overlayEnv !== "false" && overlayEnv !== "off"
  const session = new BrowserSession({
    headless: opts.headless === true || envHeadless,
    executablePath: typeof opts.executablePath === "string" ? opts.executablePath : process.env.OPENCODE_BROWSER_PATH || process.env.CHROME_PATH,
    width: typeof opts.width === "number" ? opts.width : Number(opts.width) || undefined,
    height: typeof opts.height === "number" ? opts.height : Number(opts.height) || undefined,
    timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : undefined,
    overlay: overlayEnabled,
  })

  let overlaySessionID: string | undefined
  let lastModel: { providerID: string; modelID: string } | undefined
  const overlayAssistantIDs = new Set<string>()
  const overlayParts = new Map<string, string>()
  const seenToolStates = new Set<string>()

  const formatError = (error: unknown): string => {
    if (!error) return "unknown error"
    if (typeof error === "string") return error
    if (error instanceof Error) return error.message
    const value = error as any
    if (typeof value.message === "string") return value.message
    if (typeof value.data?.message === "string") return value.data.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }

  const buildOverlayTools = async (): Promise<Record<string, boolean>> => {
    if (!client.tool?.ids) throw new Error("This opencode version does not expose the tool list; cannot restrict the overlay chat to browser tools")
    const result: any = await client.tool.ids({ query: { directory } })
    if (result?.error) throw new Error(formatError(result.error))
    const ids = Array.isArray(result?.data) ? result.data : []
    if (!ids.length) throw new Error("opencode returned an empty tool list; refusing to start the overlay chat")
    const tools: Record<string, boolean> = {}
    for (const id of ids) tools[id] = OVERLAY_ALLOWED.has(id)
    for (const name of OVERLAY_ALLOWED) tools[name] = true
    return tools
  }

  const ensureOverlaySession = async (): Promise<string> => {
    if (overlaySessionID) return overlaySessionID
    const result: any = await client.session.create({
      body: { title: "Чат в браузере" },
      query: { directory },
    })
    if (result?.error) throw new Error(formatError(result.error))
    const id = result?.data?.id
    if (!id) throw new Error("opencode did not return a session id")
    overlaySessionID = id
    return id
  }

  const handleOverlayChat = async (text: string) => {
    const prompt = text.trim()
    if (!prompt) return
    session.appendUserMessage(prompt)
    session.setChatBusy(true)
    overlayAssistantIDs.clear()
    overlayParts.clear()
    seenToolStates.clear()
    try {
      const sessionID = await ensureOverlaySession()
      const result: any = await client.session.prompt({
        path: { id: sessionID },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }],
          system: OVERLAY_SYSTEM,
          tools: await buildOverlayTools(),
          ...(lastModel ? { model: lastModel } : {}),
        },
      })
      if (result?.error) throw new Error(formatError(result.error))
      const info = result?.data?.info
      if (info?.error) throw new Error(formatError(info.error))
      const parts = Array.isArray(result?.data?.parts) ? result.data.parts : []
      const final = parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n\n")
        .trim()
      const streamed = Array.from(overlayParts.values()).join("\n\n").trim()
      session.streamAssistant(final || streamed || "(нет ответа)", true)
    } catch (error) {
      session.failAssistant(formatError(error))
    } finally {
      session.setChatBusy(false)
    }
  }

  session.onChat = (text) => {
    void handleOverlayChat(text)
  }

  const run = async (fn: () => Promise<any>): Promise<any> => {
    try {
      return await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      session.noteError(message)
      return `ERROR: ${message}`
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "message.updated") {
          const info: any = event.properties.info
          if (info?.role === "assistant") {
            if (typeof info.providerID === "string" && typeof info.modelID === "string") {
              lastModel = { providerID: info.providerID, modelID: info.modelID }
            }
            if (overlaySessionID && info.sessionID === overlaySessionID) overlayAssistantIDs.add(info.id)
          }
          return
        }
        if (event.type === "message.part.updated") {
          const part: any = event.properties.part
          if (!overlaySessionID || part?.sessionID !== overlaySessionID) return
          if (part.type === "text" && overlayAssistantIDs.has(part.messageID)) {
            overlayParts.set(part.id, typeof part.text === "string" ? part.text : "")
            const joined = Array.from(overlayParts.values()).join("\n\n").trim()
            if (joined) session.streamAssistant(joined, false)
            return
          }
          if (part.type === "tool") {
            const state: any = part.state || {}
            const key = `${part.id}:${state.status}`
            if (state.status && !seenToolStates.has(key)) {
              seenToolStates.add(key)
              const title = cleanText(state.title || "", 100)
              const level = state.status === "error" ? "error" : "tool"
              session.noteActivity(`tool ${part.tool}${title ? `: ${title}` : ` (${state.status})`}`, level)
            }
            return
          }
          return
        }
        if (event.type === "session.error") {
          if (overlaySessionID && event.properties.sessionID === overlaySessionID) {
            session.failAssistant(formatError(event.properties.error))
            session.setChatBusy(false)
          }
          return
        }
        if (event.type === "session.deleted") {
          if (overlaySessionID && event.properties.info.id === overlaySessionID) overlaySessionID = undefined
        }
      } catch {
        return
      }
    },
    "experimental.chat.system.transform": async (_input, output) => {
      if (opts.prompt === false) return
      output.system.push(SYSTEM_HINT)
    },
    tool: {
      browser_open: tool({
        description: "Launch a Chromium-based browser (Chrome/Edge/Brave) and optionally navigate to a URL. Use restart=true to apply headless or executablePath changes. Text-only friendly: follow with browser_snapshot.",
        args: {
          url: tool.schema.string().optional().describe("URL or local file path to open"),
          headless: tool.schema.boolean().optional().describe("Run without a visible window (default false)"),
          executablePath: tool.schema.string().optional().describe("Path to chrome.exe/msedge.exe if auto-detection fails"),
          restart: tool.schema.boolean().optional().describe("Close the current browser and launch a new one"),
        },
        async execute(args) {
          return run(async () => {
            const info = await session.open(args)
            if (!args.url) return info
            return `${info}\n\n${await session.snapshot({ maxTextChars: 2000, maxElements: 60 })}`
          })
        },
      }),
      browser_goto: tool({
        description: "Navigate the current tab to a URL and return a compact text snapshot of the page.",
        args: {
          url: tool.schema.string().describe("URL to navigate to (https:// is added automatically, local paths become file://)"),
          maxTextChars: tool.schema.number().optional().describe("Maximum page text characters to return (default 1500)"),
          maxElements: tool.schema.number().optional().describe("Maximum interactive elements to return (default 50)"),
        },
        async execute(args) {
          return run(async () => {
            await session.goto(args.url)
            return session.snapshot({ maxTextChars: args.maxTextChars ?? 1500, maxElements: args.maxElements ?? 50 })
          })
        },
      }),
      browser_snapshot: tool({
        description: "Read the current page as TEXT: URL, title, visible text, headings and interactive elements with refs like e12. This is how you see the page. Refs stay valid until the next snapshot.",
        args: {
          maxTextChars: tool.schema.number().optional().describe("Maximum page text characters to return (default 6000)"),
          maxElements: tool.schema.number().optional().describe("Maximum interactive elements to return (default 120)"),
        },
        async execute(args) {
          return run(() => session.snapshot(args))
        },
      }),
      browser_click: tool({
        description: "Click an element by ref from the last snapshot (preferred) or by CSS selector. Returns a fresh compact text snapshot.",
        args: {
          ref: tool.schema.string().optional().describe("Element ref from browser_snapshot, e.g. e12"),
          selector: tool.schema.string().optional().describe("CSS selector, used when ref is unknown"),
          snapshot: tool.schema.boolean().optional().describe("Return a compact snapshot after clicking (default true)"),
          maxTextChars: tool.schema.number().optional().describe("Snapshot text limit"),
          maxElements: tool.schema.number().optional().describe("Snapshot element limit"),
        },
        async execute(args) {
          return run(() => session.click(args))
        },
      }),
      browser_type: tool({
        description: "Focus an input/textarea/contenteditable or select by ref or CSS selector, clear it (unless append=true) and type text. For <select>, pass the option value or label as text. Set submit=true to press Enter afterwards. Returns a compact snapshot.",
        args: {
          ref: tool.schema.string().optional().describe("Element ref from browser_snapshot, e.g. e5"),
          selector: tool.schema.string().optional().describe("CSS selector, used when ref is unknown"),
          text: tool.schema.string().describe("Text to type, or option value/label for a <select>"),
          append: tool.schema.boolean().optional().describe("Append instead of clearing the field (default false)"),
          submit: tool.schema.boolean().optional().describe("Press Enter after typing (default false)"),
          snapshot: tool.schema.boolean().optional().describe("Return a compact snapshot after typing (default true)"),
          maxTextChars: tool.schema.number().optional().describe("Snapshot text limit"),
          maxElements: tool.schema.number().optional().describe("Snapshot element limit"),
        },
        async execute(args) {
          return run(() => session.type(args))
        },
      }),
      browser_press: tool({
        description: "Press a keyboard key or combination: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, or combos like Control+A / Shift+Tab.",
        args: {
          key: tool.schema.string().describe("Key or combo, e.g. Enter, Tab, Control+A"),
          snapshot: tool.schema.boolean().optional().describe("Return a compact snapshot (default true)"),
        },
        async execute(args) {
          return run(() => session.press(args))
        },
      }),
      browser_scroll: tool({
        description: "Scroll the page down (positive dy) or up (negative dy), or jump to top/bottom. Returns a compact snapshot showing the new viewport position.",
        args: {
          dy: tool.schema.number().optional().describe("Pixels to scroll; positive = down (default 600)"),
          to: tool.schema.enum(["top", "bottom"]).optional().describe("Jump to the top or bottom of the page"),
          snapshot: tool.schema.boolean().optional().describe("Return a compact snapshot (default true)"),
        },
        async execute(args) {
          return run(() => session.scroll(args))
        },
      }),
      browser_hover: tool({
        description: "Move the mouse over an element by ref or CSS selector, useful for opening hover menus. Returns a compact snapshot.",
        args: {
          ref: tool.schema.string().optional().describe("Element ref from browser_snapshot"),
          selector: tool.schema.string().optional().describe("CSS selector"),
          snapshot: tool.schema.boolean().optional().describe("Return a compact snapshot (default true)"),
        },
        async execute(args) {
          return run(() => session.hover(args))
        },
      }),
      browser_tabs: tool({
        description: "List, create, switch or close browser tabs. Use index (1-based) or id from the list. The active tab is marked with *.",
        args: {
          action: tool.schema.enum(["list", "new", "switch", "close"]).optional().describe("Action, default list"),
          index: tool.schema.number().optional().describe("1-based tab index"),
          id: tool.schema.string().optional().describe("Tab id from the list"),
          url: tool.schema.string().optional().describe("URL for action=new"),
        },
        async execute(args) {
          return run(() => session.tabs(args))
        },
      }),
      browser_wait: tool({
        description: "Wait for a number of milliseconds or until a CSS selector appears. Use after actions that load content asynchronously.",
        args: {
          ms: tool.schema.number().optional().describe("Milliseconds to wait (default 1000)"),
          selector: tool.schema.string().optional().describe("Wait until this CSS selector exists"),
          timeoutMs: tool.schema.number().optional().describe("Selector timeout in ms (default 10000)"),
        },
        async execute(args) {
          return run(() => session.waitFor(args))
        },
      }),
      browser_eval: tool({
        description: "Evaluate JavaScript in the page and return the JSON/text result. Use for reading data or advanced control when refs are not enough.",
        args: {
          expression: tool.schema.string().describe("JavaScript expression to evaluate in the page"),
          awaitPromise: tool.schema.boolean().optional().describe("Await returned promises (default true)"),
        },
        async execute(args) {
          return run(async () => {
            const result = await session.evaluate(args.expression, args.awaitPromise ?? true)
            return result.length > 8000 ? `${result.slice(0, 8000)}\n...[truncated]` : result
          })
        },
      }),
      browser_screenshot: tool({
        description: "Save a PNG screenshot to disk. The model cannot view it; use it only to show the page to the user. Prefer browser_snapshot for reading.",
        args: {
          path: tool.schema.string().optional().describe("Output file path (default temp dir)"),
          fullPage: tool.schema.boolean().optional().describe("Capture the full scrollable page (default false)"),
          attach: tool.schema.boolean().optional().describe("Attach the image for vision-capable models (default false)"),
        },
        async execute(args) {
          return run(() => session.screenshot(args))
        },
      }),
      browser_history: tool({
        description: "Go back, go forward, or reload the current tab and return a compact snapshot.",
        args: {
          action: tool.schema.enum(["back", "forward", "reload"]).describe("History action"),
        },
        async execute(args) {
          return run(() => session.history(args.action))
        },
      }),
      browser_overlay: tool({
        description: "Show, hide or check the small overlay panel in the bottom-right corner of the browser. The panel shows live browser activity and lets the user chat with the model in real time.",
        args: {
          action: tool.schema.enum(["show", "hide", "toggle", "status"]).optional().describe("Action, default status"),
        },
        async execute(args) {
          return run(() => session.overlay(args.action || "status"))
        },
      }),
      browser_close: tool({
        description: "Close the browser and remove its temporary profile.",
        args: {},
        async execute() {
          return run(() => session.close())
        },
      }),
    },
  }
}
