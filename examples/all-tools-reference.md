# Electron Debug MCP — Complete All-111-Tools Catalog & Reference

This reference catalog provides concrete documentation and working invocation examples for **all 111 tools** in `electron-debug-mcp`.

Total Tools: **111** · Categories: **11** · Resources: **9** · Prompts: **6**

## Table of Contents

- [1. Application Lifecycle & Process Discovery](#1-application-lifecycle-process-discovery) (11 tools)
- [2. Page & DOM Inspection](#2-page-dom-inspection) (11 tools)
- [3. Input, Mouse & Keyboard Interaction](#3-input-mouse-keyboard-interaction) (11 tools)
- [4. Visual & Accessibility Intelligence](#4-visual-accessibility-intelligence) (9 tools)
- [5. Console, Debugging & Source Maps](#5-console-debugging-source-maps) (7 tools)
- [6. State, Cookies & Storage Management](#6-state-cookies-storage-management) (7 tools)
- [7. Network Monitoring, Interception & Chaos](#7-network-monitoring-interception-chaos) (11 tools)
- [8. Performance, Profiling & Memory](#8-performance-profiling-memory) (9 tools)
- [9. Main Process, Windowing & Native OS API](#9-main-process-windowing-native-os-api) (14 tools)
- [10. IPC Inspection, Mocking & Security](#10-ipc-inspection-mocking-security) (8 tools)
- [11. Composite Workflows & Automation Engine](#11-composite-workflows-automation-engine) (13 tools)

---

## 1. Application Lifecycle & Process Discovery

### 1. `start_app`

**Description**: Start an Electron application with remote debugging enabled. Example: {"appPath":"D:/apps/my-electron-app","debugPort":9222}

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `appPath` | `string` | **Yes** | Path to the Electron app (directory or main script) |
| `debugPort` | `integer` | No | Optional Chrome DevTools debugging port (default: random 9222-9999) |
| `extraArgs` | `array` | No | Optional extra Electron CLI args (e.g. ["--no-sandbox"] for CI/containers) |
| `inspectMain` | `boolean` | No | If true, open a pinned --inspect port for main-process tools: evaluate_main, main_state, ipc_tap, get_ipc_log, webcontents_topology, open_deep_link, focus_window, set_window_bounds, get_clipboard, set_clipboard, get_downloads, set_permission |

**Example Invocation**:

```json
{
  "name": "start_app",
  "arguments": {
    "appPath": "D:/repos/my-electron-app",
    "debugPort": 9222,
    "extraArgs": [
      "example_item"
    ],
    "inspectMain": true
  }
}
```

---

### 2. `attach`

**Description**: Attach to an already-running Electron/Chromium app that was started with --remote-debugging-port. Example: {"debugPort":9222}

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `debugPort` | `integer` | **Yes** | Remote debugging port the app is listening on |
| `name` | `string` | No | Optional friendly name for this attached session |

**Example Invocation**:

```json
{
  "name": "attach",
  "arguments": {
    "debugPort": 9222,
    "name": "Submit"
  }
}
```

---

### 3. `attach_by_pid`

**Description**: Attach to a running Electron app by PID. Resolves the remote-debugging port from process arguments. App must have been started with --remote-debugging-port.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `pid` | `integer` | **Yes** | OS process ID of the Electron app |
| `name` | `string` | No | Optional friendly name for this attached session |

**Example Invocation**:

```json
{
  "name": "attach_by_pid",
  "arguments": {
    "pid": 14820,
    "name": "Submit"
  }
}
```

---

### 4. `find_apps`

**Description**: Scan running OS processes for Electron apps. Returns PID, command, and any detected --remote-debugging-port / --inspect ports. Use to find targets for attach or attach_by_pid.

*This tool takes no parameters (operates on the active/default session).*

**Example Invocation**:

```json
{
  "name": "find_apps",
  "arguments": {}
}
```

---

### 5. `discover_apps`

**Description**: Scan a local port range (default: 9222-9235) for reachable Chrome DevTools Protocol endpoints. Useful when an app was started with an unknown debug port.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `startPort` | `integer` | No | — |
| `endPort` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "discover_apps",
  "arguments": {
    "startPort": 9222,
    "endPort": 9222
  }
}
```

---

### 6. `stop_app`

**Description**: Stop a process started by start_app, or detach bookkeeping for an attached session

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process id returned by start_app or attach. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "stop_app",
  "arguments": {}
}
```

---

### 7. `list_apps`

**Description**: List Electron applications managed or attached by this server

*This tool takes no parameters (operates on the active/default session).*

**Example Invocation**:

```json
{
  "name": "list_apps",
  "arguments": {}
}
```

---

### 8. `diagnose`

**Description**: Summarize process health: debug port reachability, target roles (page/worker/browser), recent console errors, and discovered local debug ports

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Optional process id; omit to diagnose all managed processes |

**Example Invocation**:

```json
{
  "name": "diagnose",
  "arguments": {}
}
```

---

### 9. `doctor`

**Description**: Local environment health check: package/node/platform, Electron binary, env flags, managed process count, optional free-port sample (localhost bind only)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sampleFreePort` | `boolean` | No | If true (default), allocate a free 127.0.0.1 port sample via bind; no remote network |

**Example Invocation**:

```json
{
  "name": "doctor",
  "arguments": {
    "sampleFreePort": true
  }
}
```

---

### 10. `get_logs`

**Description**: Get captured stdout/stderr logs for a managed Electron process

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | **Yes** | Process id returned by start_app or attach |
| `tail` | `integer` | No | Optional number of trailing log chunks to return |

**Example Invocation**:

```json
{
  "name": "get_logs",
  "arguments": {
    "processId": "example-processId",
    "tail": 1
  }
}
```

---

### 11. `clear_buffers`

**Description**: Clear buffered console messages, network events, process logs, ipc, and/or audits

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `console` | `boolean` | No | — |
| `network` | `boolean` | No | — |
| `logs` | `boolean` | No | — |
| `ipc` | `boolean` | No | — |
| `audits` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "clear_buffers",
  "arguments": {
    "console": true,
    "network": true,
    "logs": true,
    "ipc": true,
    "audits": true
  }
}
```

---

## 2. Page & DOM Inspection

### 12. `list_targets`

**Description**: List Chrome DevTools Protocol targets with role classification (page/worker/browser/other)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Optional process id; omit to list targets for all running apps |

**Example Invocation**:

```json
{
  "name": "list_targets",
  "arguments": {}
}
```

---

### 13. `page_info`

**Description**: Get URL, title, readyState, and userAgent for a page target

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "page_info",
  "arguments": {}
}
```

---

### 14. `get_dom`

**Description**: Read documentElement.outerHTML or a specific element's outerHTML

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | No | Optional CSS selector; omit for full documentElement.outerHTML |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_dom",
  "arguments": {
    "selector": "button#submit-btn"
  }
}
```

---

### 15. `query_selector`

**Description**: Query DOM nodes with document.querySelectorAll and return tag/id/class/text summary

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | **Yes** | CSS selector |
| `targetId` | `string` | No | — |
| `limit` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "query_selector",
  "arguments": {
    "selector": "button#submit-btn",
    "limit": 25
  }
}
```

---

### 16. `navigate`

**Description**: Navigate a page target to a URL (Page.navigate) and optionally wait for load

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `url` | `string` | **Yes** | Absolute or app URL to navigate to |
| `targetId` | `string` | No | — |
| `waitUntilLoad` | `boolean` | No | — |
| `timeoutMs` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "navigate",
  "arguments": {
    "url": "https://internal.app/dashboard",
    "waitUntilLoad": true,
    "timeoutMs": 5000
  }
}
```

---

### 17. `reload`

**Description**: Reload a page target (or all page targets) in an Electron app

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |
| `ignoreCache` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "reload",
  "arguments": {
    "ignoreCache": true
  }
}
```

---

### 18. `pause`

**Description**: Pause JavaScript execution on a target via Debugger.pause

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "pause",
  "arguments": {}
}
```

---

### 19. `resume`

**Description**: Resume JavaScript execution on a target via Debugger.resume

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "resume",
  "arguments": {}
}
```

---

### 20. `cdp_command`

**Description**: Execute an arbitrary Chrome DevTools Protocol method on a target (Domain.method)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `method` | `string` | **Yes** | CDP method name, e.g. "Page.navigate" or "Runtime.evaluate" |
| `targetId` | `string` | No | — |
| `params` | `object` | No | — |

**Example Invocation**:

```json
{
  "name": "cdp_command",
  "arguments": {
    "method": "Network.clearBrowserCache",
    "params": {
      "paramKey": "paramVal"
    }
  }
}
```

---

### 21. `evaluate`

**Description**: Evaluate JavaScript in an Electron target via CDP Runtime.evaluate. Defaults to the first page/renderer target.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `expression` | `string` | **Yes** | JavaScript expression to evaluate |
| `targetId` | `string` | No | — |
| `role` | `string` | No | Preferred target role when targetId is omitted (default page) |
| `returnByValue` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "evaluate",
  "arguments": {
    "expression": "process.versions.electron",
    "role": "page",
    "returnByValue": true
  }
}
```

---

### 22. `snapshot`

**Description**: Accessibility tree snapshot (roles/names) via CDP Accessibility.getFullAXTree — agent-friendly UI map

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `depth` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "snapshot",
  "arguments": {
    "depth": 1
  }
}
```

---

## 3. Input, Mouse & Keyboard Interaction

### 23. `click`

**Description**: Click the center of a CSS selector via CDP Input.dispatchMouseEvent

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | No | CSS selector to click |
| `ref` | `string` | No | Accessibility element ref (e.g. 'e1', 'e12') from snapshot |
| `targetId` | `string` | No | — |
| `button` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "click",
  "arguments": {
    "selector": "button#submit-btn",
    "ref": "e12",
    "button": "left"
  }
}
```

---

### 24. `hover`

**Description**: Move the pointer over a CSS selector (mouseover / hover menus). Does not click.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | No | CSS selector to hover |
| `ref` | `string` | No | Accessibility element ref (e.g. 'e1', 'e12') from snapshot |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "hover",
  "arguments": {
    "selector": "button#submit-btn",
    "ref": "e12"
  }
}
```

---

### 25. `scroll`

**Description**: Scroll the page or an element. With a selector and no deltas, scrolls that element into view. With deltaY/deltaX, sends a mouse wheel at the element (or the viewport).

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | No | Element to scroll into view, or the wheel target |
| `deltaX` | `number` | No | Horizontal wheel delta. Positive scrolls right. |
| `deltaY` | `number` | No | Vertical wheel delta. Positive scrolls down. Default 400 when no selector. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "scroll",
  "arguments": {
    "selector": "button#submit-btn",
    "deltaX": 150,
    "deltaY": 150
  }
}
```

---

### 26. `drag`

**Description**: Press on fromSelector, move to toSelector, and release. Also sends an HTML5 drag with text/plain dataTransfer so drop listeners receive the payload. Pass data to override the source text.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `fromSelector` | `string` | **Yes** | — |
| `toSelector` | `string` | **Yes** | — |
| `data` | `string` | No | text/plain payload. Defaults to the source element's text. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "drag",
  "arguments": {
    "fromSelector": "div.draggable-card[data-id='101']",
    "toSelector": "div.dropzone-lane",
    "data": "example-data"
  }
}
```

---

### 27. `type_text`

**Description**: Type text into the focused element (optionally click a selector first)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `text` | `string` | **Yes** | — |
| `selector` | `string` | No | Optional CSS selector to focus before typing |
| `ref` | `string` | No | Optional accessibility element ref from snapshot |
| `clear` | `boolean` | No | If true and selector/ref is set, clear the field first |
| `pressEnter` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "type_text",
  "arguments": {
    "text": "jane.doe@example.com",
    "selector": "button#submit-btn",
    "ref": "e12",
    "clear": true,
    "pressEnter": true
  }
}
```

---

### 28. `press_key`

**Description**: Press a key or shortcut (Enter, Escape, Tab, Arrow*, or a character) with optional modifiers

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `key` | `string` | **Yes** | Key name, e.g. "Enter", "Escape", "a", "Tab", "ArrowDown" |
| `selector` | `string` | No | Optional CSS selector to focus before keypress |
| `modifiers` | `array` | No | Modifier keys, e.g. ["Control"] for Ctrl+A |
| `repeat` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "press_key",
  "arguments": {
    "key": "Enter",
    "selector": "button#submit-btn",
    "modifiers": [
      "example_item"
    ],
    "repeat": 1
  }
}
```

---

### 29. `select_option`

**Description**: Choose an option in a <select> by value or visible label, then fire input and change.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | **Yes** | — |
| `value` | `string` | No | Option value attribute |
| `label` | `string` | No | Visible option label |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "select_option",
  "arguments": {
    "selector": "button#submit-btn",
    "value": "example-value",
    "label": "example-label"
  }
}
```

---

### 30. `set_file_input`

**Description**: Set files on an <input type=file> via DOM.setFileInputFiles (host paths)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `selector` | `string` | **Yes** | — |
| `files` | `array` | **Yes** | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "set_file_input",
  "arguments": {
    "selector": "button#submit-btn",
    "files": [
      "./artifacts/upload-document.pdf"
    ]
  }
}
```

---

### 31. `click_ax`

**Description**: Click an element by accessibility name (optional role). Uses the AX tree, not CSS.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `name` | `string` | **Yes** | Accessible name, e.g. "Go" or "Submit" |
| `role` | `string` | No | AX role, e.g. "button" or "link" |
| `exact` | `boolean` | No | Require an exact name match |
| `button` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "click_ax",
  "arguments": {
    "name": "Submit",
    "role": "button",
    "exact": true,
    "button": "left"
  }
}
```

---

### 32. `type_ax`

**Description**: Focus an element by accessibility name and insert text (optional clear)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `name` | `string` | **Yes** | Accessible name of the field |
| `text` | `string` | **Yes** | — |
| `role` | `string` | No | AX role, e.g. "textbox" |
| `exact` | `boolean` | No | — |
| `clear` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "type_ax",
  "arguments": {
    "name": "Submit",
    "text": "jane.doe@example.com",
    "role": "button",
    "exact": true,
    "clear": true
  }
}
```

---

### 33. `handle_dialog`

**Description**: Auto accept or dismiss the next JavaScript dialogs (alert/confirm/prompt). clear:true disarms.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `action` | `string` | No | — |
| `promptText` | `string` | No | Value when accepting a prompt |
| `clear` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "handle_dialog",
  "arguments": {
    "action": "accept",
    "promptText": "example-promptText",
    "clear": true
  }
}
```

---

## 4. Visual & Accessibility Intelligence

### 34. `screenshot`

**Description**: Capture a PNG/JPEG screenshot of a page target via Page.captureScreenshot (optional CSS selector clips to element bounds)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |
| `format` | `string` | No | — |
| `quality` | `integer` | No | — |
| `selector` | `string` | No | Optional CSS selector — capture only that element's bounding box |

**Example Invocation**:

```json
{
  "name": "screenshot",
  "arguments": {
    "format": "png",
    "quality": 150,
    "selector": "button#submit-btn"
  }
}
```

---

### 35. `save_screenshot`

**Description**: Capture a screenshot and write it to a local file path (PNG/JPEG); optional selector clips to element

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `path` | `string` | **Yes** | Absolute or relative file path to write |
| `targetId` | `string` | No | — |
| `format` | `string` | No | — |
| `quality` | `integer` | No | — |
| `selector` | `string` | No | Optional CSS selector — capture only that element's bounding box |

**Example Invocation**:

```json
{
  "name": "save_screenshot",
  "arguments": {
    "path": "./fixtures/auth-state.json",
    "format": "png",
    "quality": 150,
    "selector": "button#submit-btn"
  }
}
```

---

### 36. `vision`

**Description**: One-shot app state: screenshot + page_info + recent console errors + network failures + windows

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `targetId` | `string` | No | — |
| `includeScreenshot` | `boolean` | No | Include base64 PNG (default true) |

**Example Invocation**:

```json
{
  "name": "vision",
  "arguments": {
    "includeScreenshot": true
  }
}
```

---

### 37. `highlight`

**Description**: Scroll a CSS selector into view and paint a CDP overlay highlight (auto-hides when durationMs > 0)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | **Yes** | — |
| `durationMs` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "highlight",
  "arguments": {
    "selector": "button#submit-btn",
    "durationMs": 5000
  }
}
```

---

### 38. `diff_screenshot`

**Description**: Capture (or compare) a screenshot against a baseline PNG; reports identical + byte similarity

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `baselinePath` | `string` | **Yes** | — |
| `currentPath` | `string` | No | Existing PNG to compare; if omitted, captures fresh |
| `selector` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "diff_screenshot",
  "arguments": {
    "baselinePath": "./baselines/login.png",
    "currentPath": "example-currentPath",
    "selector": "button#submit-btn"
  }
}
```

---

### 39. `start_screencast`

**Description**: Start Page.startScreencast; buffers up to maxFrames (ack frames). Pair with stop_screencast.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |
| `maxFrames` | `integer` | No | — |
| `everyNthFrame` | `integer` | No | — |
| `format` | `string` | No | — |
| `quality` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "start_screencast",
  "arguments": {
    "maxFrames": 150,
    "everyNthFrame": 150,
    "format": "png",
    "quality": 150
  }
}
```

---

### 40. `stop_screencast`

**Description**: Stop screencast; optionally write last frame PNG/JPEG to path

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "stop_screencast",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 41. `print_pdf`

**Description**: Write the page to a PDF. Uses Page.printToPDF, and falls back to webContents.printToPDF when that method is missing (needs inspectMain). printBackground defaults to true. Also registers as an artifact resource.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |
| `landscape` | `boolean` | No | — |
| `printBackground` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "print_pdf",
  "arguments": {
    "path": "./fixtures/auth-state.json",
    "landscape": true,
    "printBackground": true
  }
}
```

---

### 42. `capture_mhtml`

**Description**: Save page as MHTML via Page.captureSnapshot. Also registers the file as an artifact resource.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "capture_mhtml",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

## 5. Console, Debugging & Source Maps

### 43. `get_console_messages`

**Description**: Get buffered page console/log/exception messages captured via CDP

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `tail` | `integer` | No | — |
| `level` | `string` | No | Optional filter, e.g. error, warning, log |

**Example Invocation**:

```json
{
  "name": "get_console_messages",
  "arguments": {
    "tail": 1,
    "level": "example-level"
  }
}
```

---

### 44. `set_console_live`

**Description**: Enable/disable live MCP log notifications for console events (all levels when enabled; errors always notify)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `enabled` | `boolean` | **Yes** | true to stream console events as MCP logs |

**Example Invocation**:

```json
{
  "name": "set_console_live",
  "arguments": {
    "enabled": true
  }
}
```

---

### 45. `set_breakpoint`

**Description**: Debugger.setBreakpointByUrl (0-based lineNumber). Keep debugger enabled while BPs exist.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `lineNumber` | `integer` | **Yes** | — |
| `url` | `string` | No | — |
| `urlRegex` | `string` | No | — |
| `columnNumber` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "set_breakpoint",
  "arguments": {
    "lineNumber": 1,
    "url": "https://internal.app/dashboard",
    "urlRegex": "example-urlRegex",
    "columnNumber": 1
  }
}
```

---

### 46. `remove_breakpoint`

**Description**: Debugger.removeBreakpoint by breakpointId from set_breakpoint

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `breakpointId` | `string` | **Yes** | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "remove_breakpoint",
  "arguments": {
    "breakpointId": "example-breakpointId"
  }
}
```

---

### 47. `resolve_stack`

**Description**: Resolve stack frames to source snippets (Debugger.getScriptSource / file://)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `frames` | `array` | **Yes** | — |
| `contextLines` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "resolve_stack",
  "arguments": {
    "frames": [
      "example_item"
    ],
    "contextLines": 150
  }
}
```

---

### 48. `get_audit_issues`

**Description**: Buffered Chromium Audits issues (cookie/CORS/mixed-content/deprecations) captured since attach

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `tail` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "get_audit_issues",
  "arguments": {
    "tail": 1
  }
}
```

---

### 49. `virtual_clock`

**Description**: Emulation.setVirtualTimePolicy — pause / advance virtual time (use budget when advancing)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `policy` | `string` | **Yes** | — |
| `budget` | `number` | No | Virtual ms to grant when advancing |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "virtual_clock",
  "arguments": {
    "policy": "pause",
    "budget": 1
  }
}
```

---

## 6. State, Cookies & Storage Management

### 50. `get_cookies`

**Description**: Read cookies for the page (optionally filtered by URL)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `urls` | `array` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_cookies",
  "arguments": {
    "urls": [
      "*analytics*",
      "*doubleclick.net*"
    ]
  }
}
```

---

### 51. `set_cookie`

**Description**: Set a cookie on the page (provide url or domain; defaults to current location.href). file:// pages usually reject cookies unless you pass an http(s) url or domain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `name` | `string` | **Yes** | — |
| `value` | `string` | **Yes** | — |
| `url` | `string` | No | — |
| `domain` | `string` | No | — |
| `path` | `string` | No | — |
| `secure` | `boolean` | No | — |
| `httpOnly` | `boolean` | No | — |
| `sameSite` | `string` | No | — |
| `expires` | `number` | No | Unix time in seconds |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "set_cookie",
  "arguments": {
    "name": "Submit",
    "value": "example-value",
    "url": "https://internal.app/dashboard",
    "domain": "example-domain",
    "path": "./fixtures/auth-state.json",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Strict",
    "expires": 150
  }
}
```

---

### 52. `delete_cookie`

**Description**: Delete a cookie by name. Provide url or domain, same as set_cookie. Defaults url to the page location.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `name` | `string` | **Yes** | — |
| `url` | `string` | No | — |
| `domain` | `string` | No | — |
| `path` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "delete_cookie",
  "arguments": {
    "name": "Submit",
    "url": "https://internal.app/dashboard",
    "domain": "example-domain",
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 53. `get_storage`

**Description**: Read localStorage or sessionStorage key/value pairs from the page

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `kind` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_storage",
  "arguments": {
    "kind": "localStorage"
  }
}
```

---

### 54. `set_storage`

**Description**: Write localStorage or sessionStorage entries (optionally clear first)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `kind` | `string` | No | — |
| `entries` | `object` | **Yes** | — |
| `clear` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "set_storage",
  "arguments": {
    "kind": "localStorage",
    "entries": {},
    "clear": true
  }
}
```

---

### 55. `save_storage_state`

**Description**: Export all page cookies, localStorage, and sessionStorage into a standardized JSON storage state artifact (Playwright-compatible format)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `path` | `string` | No | Optional destination file path. If omitted, saves to temporary artifact. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "save_storage_state",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 56. `load_storage_state`

**Description**: Restore page cookies, localStorage, and sessionStorage from a saved JSON storage state file or payload

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `path` | `string` | No | Path to storage state JSON file |
| `state` | `object` | No | Inline storage state object |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "load_storage_state",
  "arguments": {
    "path": "./fixtures/auth-state.json",
    "state": {
      "cookies": [],
      "origins": []
    }
  }
}
```

---

## 7. Network Monitoring, Interception & Chaos

### 57. `get_network_log`

**Description**: Get buffered network request/response events captured via CDP Network domain. Supports optional filtering by tail, status code, failure status, or URL pattern.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `tail` | `integer` | No | — |
| `status` | `integer` | No | Optional HTTP status filter (e.g. 404, 500) |
| `failedOnly` | `boolean` | No | If true, only return requests that failed or responded with status >= 400 |
| `urlPattern` | `string` | No | Optional URL substring or glob filter |

**Example Invocation**:

```json
{
  "name": "get_network_log",
  "arguments": {
    "tail": 1,
    "status": 1,
    "failedOnly": true,
    "urlPattern": "**/api/v1/telemetry/**"
  }
}
```

---

### 58. `get_response_body`

**Description**: Fetch body for a buffered network requestId (call after Network.loadingFinished)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `requestId` | `string` | **Yes** | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_response_body",
  "arguments": {
    "requestId": "example-requestId"
  }
}
```

---

### 59. `block_urls`

**Description**: Block URL patterns via Network.setBlockedURLs (e.g. *.analytics.com/*)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `urls` | `array` | **Yes** | URL patterns to block |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "block_urls",
  "arguments": {
    "urls": [
      "*analytics*",
      "*doubleclick.net*"
    ]
  }
}
```

---

### 60. `set_extra_headers`

**Description**: Set extra HTTP headers for subsequent requests (Network.setExtraHTTPHeaders)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `headers` | `object` | **Yes** | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "set_extra_headers",
  "arguments": {
    "headers": {
      "X-Test-Suite": "Electron-E2E",
      "Authorization": "Bearer tok_123"
    }
  }
}
```

---

### 61. `network_stub`

**Description**: Intercept matching URLs via Fetch and fulfill or fail them. Replaces a rule with the same urlPattern. Pair with clear_network_stubs.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `urlPattern` | `string` | **Yes** | CDP urlPattern; * is a wildcard, e.g. "*api/users*" |
| `action` | `string` | **Yes** | — |
| `status` | `integer` | No | — |
| `body` | `string` | No | — |
| `contentType` | `string` | No | — |
| `headers` | `object` | No | — |
| `errorReason` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "network_stub",
  "arguments": {
    "urlPattern": "**/api/v1/telemetry/**",
    "action": "fulfill",
    "status": 1,
    "body": "example-body",
    "contentType": "example-contentType",
    "headers": {
      "X-Test-Suite": "Electron-E2E",
      "Authorization": "Bearer tok_123"
    },
    "errorReason": "Failed"
  }
}
```

---

### 62. `clear_network_stubs`

**Description**: Disable Fetch interception and drop stub rules for this session

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "clear_network_stubs",
  "arguments": {}
}
```

---

### 63. `wait_network_idle`

**Description**: Wait until no network request is in flight and the log has been quiet for idleMs

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `idleMs` | `integer` | No | — |
| `timeoutMs` | `integer` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "wait_network_idle",
  "arguments": {
    "idleMs": 5000,
    "timeoutMs": 5000
  }
}
```

---

### 64. `export_har`

**Description**: Write the buffered network log as HAR 1.2 JSON (method, URL, status; no bodies). Also exposes the file as an artifact resource.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "export_har",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 65. `emulate_network`

**Description**: Set the page offline, or slow it with latency and throughput in bytes per second. clear:true restores a normal network. Does not change viewport, user agent, geolocation, or media; use emulate for those.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `offline` | `boolean` | No | true makes navigator.onLine false and fails fetches |
| `latencyMs` | `number` | No | Added round-trip latency in milliseconds |
| `downloadThroughput` | `number` | No | Max download bytes/sec. -1 means unlimited |
| `uploadThroughput` | `number` | No | Max upload bytes/sec. -1 means unlimited |
| `clear` | `boolean` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "emulate_network",
  "arguments": {
    "offline": true,
    "latencyMs": 5000,
    "downloadThroughput": 1,
    "uploadThroughput": 1,
    "clear": true
  }
}
```

---

### 66. `get_downloads`

**Description**: Arm download capture and list files saved by the app. Requires inspectMain. The first call installs a will-download listener that writes into directory (default: OS temp) and suppresses the save dialog. Call it before the download starts, then call again for savePath.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `directory` | `string` | No | Directory for saved files. Used when the listener is first armed. |
| `url` | `string` | No | Optional URL to start downloading on the app session after the listener is armed |

**Example Invocation**:

```json
{
  "name": "get_downloads",
  "arguments": {
    "directory": "example-directory",
    "url": "https://internal.app/dashboard"
  }
}
```

---

### 67. `network_failure_report`

**Description**: Composite network diagnostics: gathers all failed HTTP requests (status >= 400 or failed requests), fetches response bodies inline, and exports a HAR artifact.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `urlPattern` | `string` | No | Optional URL substring or pattern filter |
| `tail` | `integer` | No | Optional limit of recent failures to return |
| `exportHarFile` | `boolean` | No | Whether to export a HAR file (default: true) |
| `harPath` | `string` | No | Optional path for the exported HAR file |

**Example Invocation**:

```json
{
  "name": "network_failure_report",
  "arguments": {
    "urlPattern": "**/api/v1/telemetry/**",
    "tail": 1,
    "exportHarFile": true,
    "harPath": "example-harPath"
  }
}
```

---

## 8. Performance, Profiling & Memory

### 68. `start_tracing`

**Description**: Start Chrome DevTools Protocol performance tracing (pair with stop_tracing)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `categories` | `string` | No | Comma-separated CDP trace categories (default: timeline + v8) |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "start_tracing",
  "arguments": {
    "categories": "example-categories"
  }
}
```

---

### 69. `stop_tracing`

**Description**: Stop CDP tracing and write a JSON trace file (open in chrome://tracing)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | Output file path (default: OS temp dir) |

**Example Invocation**:

```json
{
  "name": "stop_tracing",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 70. `get_performance_metrics`

**Description**: Renderer Performance.getMetrics (JS heap, layout count, task duration, …)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_performance_metrics",
  "arguments": {}
}
```

---

### 71. `start_cpu_profile`

**Description**: Start V8 CPU profiler on a page target (pair with stop_cpu_profile)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "start_cpu_profile",
  "arguments": {}
}
```

---

### 72. `stop_cpu_profile`

**Description**: Stop CPU profiler and write a .cpuprofile JSON file

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | Output path (default: OS temp) |

**Example Invocation**:

```json
{
  "name": "stop_cpu_profile",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 73. `heap_snapshot`

**Description**: Take a V8 heap snapshot (.heapsnapshot) for leak investigation

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "heap_snapshot",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 74. `start_coverage`

**Description**: Start JS precise coverage (optional CSS rule usage). Pair with stop_coverage.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |
| `css` | `boolean` | No | Also track CSS rule usage |

**Example Invocation**:

```json
{
  "name": "start_coverage",
  "arguments": {
    "css": true
  }
}
```

---

### 75. `stop_coverage`

**Description**: Stop coverage and return JS (and optional CSS) coverage data; optionally write JSON

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "stop_coverage",
  "arguments": {
    "path": "./fixtures/auth-state.json"
  }
}
```

---

### 76. `perf_audit`

**Description**: Lighthouse-lite: Performance.getMetrics + nav/paint timing + recent Audits issues (not full Lighthouse)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |
| `includeAudits` | `boolean` | No | — |
| `includeNavTiming` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "perf_audit",
  "arguments": {
    "includeAudits": true,
    "includeNavTiming": true
  }
}
```

---

## 9. Main Process, Windowing & Native OS API

### 77. `evaluate_main`

**Description**: Evaluate JavaScript in the Electron main/node CDP target (use start_app with inspectMain:true for best results)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `expression` | `string` | **Yes** | — |
| `targetId` | `string` | No | Optional explicit main/node target id from list_targets |
| `returnByValue` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "evaluate_main",
  "arguments": {
    "expression": "process.versions.electron",
    "returnByValue": true
  }
}
```

---

### 78. `main_state`

**Description**: Electron main-process nervous system: windows, app paths, versions, metrics (requires inspectMain / node target)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "main_state",
  "arguments": {}
}
```

---

### 79. `find_installed_apps`

**Description**: Scan common install locations for packaged Electron apps (.app / exe / .desktop)

*This tool takes no parameters (operates on the active/default session).*

**Example Invocation**:

```json
{
  "name": "find_installed_apps",
  "arguments": {}
}
```

---

### 80. `webcontents_topology`

**Description**: Map BrowserWindows / webContents (main) to CDP targets. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "webcontents_topology",
  "arguments": {}
}
```

---

### 81. `open_deep_link`

**Description**: Emit Electron open-url and second-instance (requires inspectMain). Returns the URL the app recorded and mirrors it to window.__DEEP_LINK__.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `url` | `string` | **Yes** | Deep link or URL to deliver |
| `channel` | `string` | No | Also webContents.send(channel, url) when set |

**Example Invocation**:

```json
{
  "name": "open_deep_link",
  "arguments": {
    "url": "https://internal.app/dashboard",
    "channel": "app:get-user-settings"
  }
}
```

---

### 82. `focus_window`

**Description**: Bring an Electron BrowserWindow forward (show, focus, moveTop). Requires inspectMain. Omit windowId to use the first window. Pass show:false to focus without showing a hidden window.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `windowId` | `integer` | No | BrowserWindow.id from webcontents_topology |
| `show` | `boolean` | No | Call show() before focus. Default true. |

**Example Invocation**:

```json
{
  "name": "focus_window",
  "arguments": {
    "windowId": 1,
    "show": true
  }
}
```

---

### 83. `get_clipboard`

**Description**: Read the OS clipboard. Returns text and, when present, imageDataUrl (PNG). Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "get_clipboard",
  "arguments": {}
}
```

---

### 84. `set_clipboard`

**Description**: Write the OS clipboard. Pass text, imageDataUrl (a data:image/... URL), or both. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `text` | `string` | No | — |
| `imageDataUrl` | `string` | No | data:image/png;base64,... or another image data URL |

**Example Invocation**:

```json
{
  "name": "set_clipboard",
  "arguments": {
    "text": "jane.doe@example.com",
    "imageDataUrl": "example-imageDataUrl"
  }
}
```

---

### 85. `set_permission`

**Description**: Allow or deny an Electron permission and grant it to the page via Browser.grantPermissions. Returns checked, the page's Notification.permission or equivalent. Requires inspectMain. Unlisted permissions are denied after the handler is installed.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `permission` | `string` | **Yes** | Electron permission name, e.g. "notifications", "media", "geolocation" |
| `grant` | `boolean` | **Yes** | true allows the prompt, false denies it |
| `probe` | `boolean` | No | If true, query the page permission state and return it as checked |

**Example Invocation**:

```json
{
  "name": "set_permission",
  "arguments": {
    "permission": "example-permission",
    "grant": true,
    "probe": true
  }
}
```

---

### 86. `set_window_bounds`

**Description**: Move or resize a BrowserWindow. Omit a field to leave it unchanged. Requires inspectMain. Does not show a hidden window.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `windowId` | `integer` | No | BrowserWindow.id from webcontents_topology |
| `x` | `number` | No | — |
| `y` | `number` | No | — |
| `width` | `integer` | No | — |
| `height` | `integer` | No | — |

**Example Invocation**:

```json
{
  "name": "set_window_bounds",
  "arguments": {
    "windowId": 1,
    "x": 150,
    "y": 150,
    "width": 1280,
    "height": 800
  }
}
```

---

### 87. `get_application_menu`

**Description**: Inspect the native Electron application menu hierarchy, items, roles, accelerators, and enabled states

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_application_menu",
  "arguments": {}
}
```

---

### 88. `click_menu_item`

**Description**: Trigger a click on a native application menu item by path (e.g. 'File > Open File...'), id, or role

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `path` | `string` | No | Full menu item path e.g. 'File > Save' or 'View > Toggle Developer Tools' |
| `id` | `string` | No | MenuItem ID if assigned |
| `role` | `string` | No | Standard role e.g. 'undo', 'cut', 'copy' |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "click_menu_item",
  "arguments": {
    "path": "./fixtures/auth-state.json",
    "id": "example-id",
    "role": "button"
  }
}
```

---

### 89. `trigger_shortcut`

**Description**: Trigger an Electron global shortcut accelerator (e.g. 'CommandOrControl+Shift+P')

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `accelerator` | `string` | **Yes** | Keyboard shortcut accelerator (e.g. 'Ctrl+Shift+P', 'F12') |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "trigger_shortcut",
  "arguments": {
    "accelerator": "CommandOrControl+Shift+P"
  }
}
```

---

### 90. `get_process_health`

**Description**: Watchdog health check diagnosing renderer crashes (OOM, killed), window hangs, responsiveness, and process memory

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_process_health",
  "arguments": {}
}
```

---

## 10. IPC Inspection, Mocking & Security

### 91. `ipc_tap`

**Description**: Install main-process IPC tap (ipcMain.handle wrap + webContents send/ipc-message). Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "ipc_tap",
  "arguments": {}
}
```

---

### 92. `get_ipc_log`

**Description**: Drain / read captured IPC entries after ipc_tap. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `tail` | `integer` | No | — |
| `refreshFromMain` | `boolean` | No | — |

**Example Invocation**:

```json
{
  "name": "get_ipc_log",
  "arguments": {
    "tail": 1,
    "refreshFromMain": true
  }
}
```

---

### 93. `ipc_invoke`

**Description**: Directly invoke a main-process IPC handle channel or emit an IPC event with arguments. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `channel` | `string` | **Yes** | IPC channel name (e.g. 'get-user-settings') |
| `args` | `array` | No | Arguments to pass to the IPC handle listener |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "ipc_invoke",
  "arguments": {
    "channel": "app:get-user-settings",
    "args": [
      "example_item"
    ]
  }
}
```

---

### 94. `ipc_schema_inference`

**Description**: Infer IPC channel contracts, argument shapes, and generate TypeScript interfaces from captured IPC tap traffic. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `refreshFromMain` | `boolean` | No | Whether to drain new IPC entries from main before analyzing (default: true) |
| `channel` | `string` | No | Optional specific channel to analyze |

**Example Invocation**:

```json
{
  "name": "ipc_schema_inference",
  "arguments": {
    "refreshFromMain": true,
    "channel": "app:get-user-settings"
  }
}
```

---

### 95. `mock_electron_api`

**Description**: Mock an Electron main-process API (e.g. dialog.showOpenDialog, shell.openExternal, app.getPath) with a custom return value or implementation. Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `module` | `string` | **Yes** | Electron module name (e.g. 'dialog', 'shell', 'app', 'clipboard', 'autoUpdater') |
| `method` | `string` | **Yes** | Method name to mock (e.g. 'showOpenDialog', 'openExternal', 'showMessageBox') |
| `returns` | `any` | No | Value or Promise result to return when invoked |
| `implementation` | `string` | No | Optional JS function body to execute as mock |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "mock_electron_api",
  "arguments": {
    "module": "example-module",
    "method": "Network.clearBrowserCache",
    "returns": "sample-value",
    "implementation": "example-implementation"
  }
}
```

---

### 96. `get_mock_calls`

**Description**: Get recorded invocations and arguments for a mocked Electron API method

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `module` | `string` | **Yes** | Electron module name |
| `method` | `string` | **Yes** | Method name |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "get_mock_calls",
  "arguments": {
    "module": "example-module",
    "method": "Network.clearBrowserCache"
  }
}
```

---

### 97. `restore_electron_mocks`

**Description**: Restore original implementations of mocked Electron APIs

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `module` | `string` | No | Module to restore (omit to restore all) |
| `method` | `string` | No | Method to restore (omit to restore all in module) |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "restore_electron_mocks",
  "arguments": {
    "module": "example-module",
    "method": "Network.clearBrowserCache"
  }
}
```

---

### 98. `electron_security_audit`

**Description**: Run security audit against Electron security recommendations (inspects webPreferences, sandbox, nodeIntegration, contextIsolation, setWindowOpenHandler, will-navigate guards, and binary fuses). Requires inspectMain.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |

**Example Invocation**:

```json
{
  "name": "electron_security_audit",
  "arguments": {}
}
```

---

## 11. Composite Workflows & Automation Engine

### 99. `wait_for`

**Description**: Wait until a selector exists/hides/enables, text/URL/console matches, or node count is met

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `selector` | `string` | No | CSS selector that must exist |
| `hidden` | `string` | No | CSS selector that must be absent or not visible |
| `enabled` | `string` | No | CSS selector that must exist and not be disabled |
| `countSelector` | `string` | No | CSS selector to count (use with minCount) |
| `minCount` | `integer` | No | Minimum matches required for countSelector |
| `text` | `string` | No | Text that must appear in document.body |
| `urlIncludes` | `string` | No | Substring that location.href must include |
| `consoleIncludes` | `string` | No | Substring that a buffered console message must include |
| `timeoutMs` | `integer` | No | — |
| `screenshotOnTimeout` | `boolean` | No | If true, save a PNG to the OS temp dir when wait times out |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "wait_for",
  "arguments": {
    "selector": "button#submit-btn",
    "hidden": "example-hidden",
    "enabled": "example-enabled",
    "countSelector": "example-countSelector",
    "minCount": 25,
    "text": "jane.doe@example.com",
    "urlIncludes": "example-urlIncludes",
    "consoleIncludes": "example-consoleIncludes",
    "timeoutMs": 5000,
    "screenshotOnTimeout": true
  }
}
```

---

### 100. `emulate`

**Description**: Device metrics / UA / geolocation / media emulation (or clear=true to reset)

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |
| `clear` | `boolean` | No | — |
| `metrics` | `object` | No | — |
| `userAgent` | `string` | No | — |
| `geolocation` | `object` | No | — |
| `media` | `string` | No | e.g. "print" or "screen" |

**Example Invocation**:

```json
{
  "name": "emulate",
  "arguments": {
    "clear": true,
    "metrics": {},
    "userAgent": "example-userAgent",
    "geolocation": {},
    "media": "example-media"
  }
}
```

---

### 101. `perf_snapshot`

**Description**: Composite performance profiler: coordinates start_tracing + start_cpu_profile + start_coverage, optionally captures an interaction or reload, stops all collectors, and bundles perf audit, metrics, and artifact URIs.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `durationMs` | `integer` | No | Capture window duration in milliseconds (default: 1000) |
| `reload` | `boolean` | No | If true, reloads the current page during trace capture |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "perf_snapshot",
  "arguments": {
    "durationMs": 5000,
    "reload": true
  }
}
```

---

### 102. `leak_check`

**Description**: Memory leak detector: triggers garbage collection, measures baseline DOM and heap counters, repeats an action or wait, runs GC again, and reports retained node/listener/heap growth.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `iterations` | `integer` | No | Number of test action iterations (default: 3) |
| `actionScript` | `string` | No | Optional JavaScript expression evaluated in the renderer on each iteration |
| `targetId` | `string` | No | — |
| `captureSnapshots` | `boolean` | No | Whether to capture heap snapshot files before and after (default: false) |

**Example Invocation**:

```json
{
  "name": "leak_check",
  "arguments": {
    "iterations": 1,
    "actionScript": "example-actionScript",
    "captureSnapshots": true
  }
}
```

---

### 103. `assert_ui`

**Description**: Check url/title/text/selector/console-error budget/expression. Returns pass:false with per-check detail (does not throw on a failed check).

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `urlIncludes` | `string` | No | — |
| `titleIncludes` | `string` | No | — |
| `textIncludes` | `string` | No | — |
| `selector` | `string` | No | — |
| `selectorHidden` | `string` | No | — |
| `maxConsoleErrors` | `integer` | No | — |
| `expression` | `string` | No | JS expression that must be truthy |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "assert_ui",
  "arguments": {
    "urlIncludes": "example-urlIncludes",
    "titleIncludes": "example-titleIncludes",
    "textIncludes": "example-textIncludes",
    "selector": "button#submit-btn",
    "selectorHidden": "example-selectorHidden",
    "maxConsoleErrors": 150,
    "expression": "process.versions.electron"
  }
}
```

---

### 104. `act_and_verify`

**Description**: Composite action & assertion: performs a UI action (click, click_ax, type_text, type_ax), waits for network idle, verifies assertion (assert_ui), and captures a screenshot immediately if assertion fails.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `action` | `object` | **Yes** | — |
| `assertion` | `object` | **Yes** | — |
| `waitForSelector` | `string` | No | — |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "act_and_verify",
  "arguments": {
    "action": {},
    "assertion": {},
    "waitForSelector": "example-waitForSelector"
  }
}
```

---

### 105. `triage`

**Description**: One-shot crash and failure triage: inspects page state, collects console errors, failed network calls, audit issues, log tail, and resolves the stack trace of the top exception.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "triage",
  "arguments": {}
}
```

---

### 106. `fill_form`

**Description**: Fill multiple input fields (text, password, checkboxes, radio buttons, dropdowns) and optionally submit in a single turn. Supports {{secret:VAR}} resolution and accessibility refs.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `fields` | `any` | **Yes** | Form field specifications or mapping of field names to values |
| `submit` | `string,boolean` | No | Submit selector/name/ref, or true to auto-detect submit button |
| `waitIdle` | `boolean` | No | Whether to wait for network idle after filling/submitting (default true) |
| `expect` | `object` | No | Optional UI assertion to verify post-submit outcome |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "fill_form",
  "arguments": {
    "fields": "sample-value",
    "submit": "sample-value",
    "waitIdle": true,
    "expect": {}
  }
}
```

---

### 107. `responsive_theme_matrix`

**Description**: Run a multi-theme (dark/light) and multi-viewport responsive sweep, verifying UI layout, detecting text clipping/horizontal overflow, and capturing screenshot artifacts.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `themes` | `array` | No | Themes to test (default ['light', 'dark']) |
| `viewports` | `array` | No | Viewport dimensions to test (default 800x600, 1280x800, 1920x1080) |
| `checkOverflow` | `boolean` | No | Whether to detect elements overflowing viewport bounds (default true) |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "responsive_theme_matrix",
  "arguments": {
    "themes": [
      "light",
      "dark"
    ],
    "viewports": [
      {
        "width": 1280,
        "height": 800
      },
      {
        "width": 800,
        "height": 600
      }
    ],
    "checkOverflow": true
  }
}
```

---

### 108. `offline_resilience_check`

**Description**: Audit how gracefully the Electron app handles network loss, high latency, or HTTP 500 server faults during interactions. Emulates faults, checks for crashes or unhandled rejections, restores network, and computes a Resilience Grade (A-F).

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `faultType` | `string` | No | Type of network disruption to simulate (default 'offline') |
| `action` | `object` | No | Optional user action to trigger during network disruption |
| `urlPattern` | `string` | No | URL pattern to intercept/fault (default '*') |
| `durationMs` | `integer` | No | Disruption window duration in ms (default 1000) |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "offline_resilience_check",
  "arguments": {
    "faultType": "offline",
    "action": {},
    "urlPattern": "**/api/v1/telemetry/**",
    "durationMs": 5000
  }
}
```

---

### 109. `ipc_fuzz_and_verify`

**Description**: Fuzz test renderer-to-main IPC channels with boundary and malformed payloads (null, prototype pollution, path traversal, oversized buffers) and verify process crash resistance.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Process ID. If omitted, uses the single running app. |
| `channels` | `array` | No | Explicit IPC channels to test. If omitted, automatically discovers active channels. |
| `iterations` | `integer` | No | Number of payload variations per channel (default 6) |
| `timeoutMs` | `integer` | No | Timeout per probe in ms (default 2000) |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "ipc_fuzz_and_verify",
  "arguments": {
    "channels": [
      "example_item"
    ],
    "iterations": 1,
    "timeoutMs": 5000
  }
}
```

---

### 110. `repro_bundle`

**Description**: Package a complete, self-contained repro investigation bundle (screenshot, MHTML DOM archive, HAR network replay, source-mapped stack traces, logs, and system/health info) into a zip artifact.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `processId` | `string` | No | Target process ID. Omit if only one app is running. |
| `outputPath` | `string` | No | Optional destination zip file path |
| `notes` | `string` | No | Optional bug reproduction steps or user notes to include in report |
| `targetId` | `string` | No | — |

**Example Invocation**:

```json
{
  "name": "repro_bundle",
  "arguments": {
    "outputPath": "./artifacts/capture.png",
    "notes": "example-notes"
  }
}
```

---

### 111. `run_script`

**Description**: Advanced server-side step runner & workflow engine: executes an array of tool steps sequentially with templating ({{vars.x}}, {{steps[0].result.x}}, {{secret:KEY}}), conditional branching (if), assertions (expect), automatic retries, diagnostic failure screenshots, and optional export to Playwright test specs.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `script` | `any` | **Yes** | Array of steps or path/JSON string to execute |
| `variables` | `object` | No | Initial variables map for {{vars.name}} interpolation |
| `processId` | `string` | No | Target process ID. If omitted, uses the single running app. |
| `stopOnFirstError` | `boolean` | No | Whether to halt script execution upon first step failure (default: true) |
| `captureFailureArtifacts` | `boolean` | No | Whether to automatically capture screenshot artifacts and diagnostic logs on step failure (default: true) |
| `exportAs` | `string` | No | Export the executed steps as executable Playwright test code or JSON recipe |
| `exportPath` | `string` | No | Optional file path on disk to save the exported test or JSON recipe |

**Example Invocation**:

```json
{
  "name": "run_script",
  "arguments": {
    "script": "sample-value",
    "variables": {
      "env": "staging",
      "retries": 3
    },
    "stopOnFirstError": true,
    "captureFailureArtifacts": true,
    "exportAs": "playwright",
    "exportPath": "example-exportPath"
  }
}
```

---

