# 20 High-Leverage Electron MCP Workflows & Examples

This guide details **20 practical, production-ready workflows** demonstrating the depth of `electron-debug-mcp`. These workflows combine low-level Chrome DevTools Protocol primitives, Electron main-process inspection, accessibility trees, and composite automation.

---

## Table of Contents

1. [One-Shot Bug Repro Bundle & GitHub Issue Generator](#1-one-shot-bug-repro-bundle--github-issue-generator)
2. [IPC Channel Security & Boundary Fuzzer](#2-ipc-channel-security--boundary-fuzzer)
3. [Dark Mode & Responsive Viewport Matrix Sweep](#3-dark-mode--responsive-viewport-matrix-sweep)
4. [Network Chaos & Offline Fault Recovery Drill](#4-network-chaos--offline-fault-recovery-drill)
5. [Zero-Flake Multi-Field Accessible Form Solver](#5-zero-flake-multi-field-accessible-form-solver)
6. [Electron Security Posture & Binary Fuse Audit](#6-electron-security-posture--binary-fuse-audit)
7. [Zero-Leak Secret Ingestion with Masking](#7-zero-leak-secret-ingestion-with-masking)
8. [Memory Leak Detection & Heap Growth Diffing](#8-memory-leak-detection--heap-growth-diffing)
9. [IPC Contract & TypeScript Type Inference](#9-ipc-contract--typescript-type-inference)
10. [Multi-Window Sync & Topology Mapper](#10-multi-window-sync--topology-mapper)
11. [Native OS Dialog & Shell API Mocking](#11-native-os-dialog--shell-api-mocking)
12. [Native Application Menu & Global Shortcut Triggering](#12-native-application-menu--global-shortcut-triggering)
13. [Session Hydration & Storage State Migration](#13-session-hydration--storage-state-migration)
14. [Local Source Map De-Minifier & Stack Resolver](#14-local-source-map-de-minifier--stack-resolver)
15. [Full-Session HAR Network Capture & Analysis](#15-full-session-har-network-capture--analysis)
16. [Crash Loop & Watchdog Health Diagnostics](#16-crash-loop--watchdog-health-diagnostics)
17. [Time-Travel Testing with Virtual Clock](#17-time-travel-testing-with-virtual-clock)
18. [Native OS Clipboard Data Automation](#18-native-os-clipboard-data-automation)
19. [Visual Regression Testing with Element Masking](#19-visual-regression-testing-with-element-masking)
20. [Self-Healing Test Workflow with Playwright Code Synthesis](#20-self-healing-test-workflow-with-playwright-code-synthesis)

---

## 1. One-Shot Bug Repro Bundle & GitHub Issue Generator

### Problem
When a bug occurs in an Electron application during automated testing or agent exploration, capturing isolated screenshots is rarely enough. Developers need the full DOM state, network traffic, console logs, stderr output, and OS diagnostics.

### Solution
Use `repro_bundle` to pack a complete, self-contained `.zip` bundle and Markdown issue report in a single call.

```json
{
  "name": "repro_bundle",
  "arguments": {
    "title": "Crash on workspace switch with unsaved editor tabs",
    "description": "Triggered when switching workspaces while 3 unsaved diff tabs are open.",
    "outputPath": "./artifacts/repro-bundle-workspace-crash.zip"
  }
}
```

### Result Artifact
The generated `.zip` contains:
- `screenshot.png` — Full viewport PNG capture.
- `dom.mhtml` — Complete MHTML archive with embedded images, styles, and iframes.
- `network.har` — HTTP Archive 1.2 log of all recent network requests and responses.
- `console.json` — All captured console errors, warnings, and uncaught exceptions.
- `diagnostics.json` — Process health, PID, memory, Electron/Node/Chromium versions, and OS info.
- `ISSUE_REPORT.md` — Formatted Markdown issue template ready to paste into GitHub.

---

## 2. IPC Channel Security & Boundary Fuzzer

### Problem
Renderer-to-main IPC handlers (`ipcMain.handle` / `ipcMain.on`) are common vectors for remote code execution, prototype pollution, path traversal, and unhandled denial-of-service crashes.

### Solution
Run `ipc_fuzz_and_verify` to automatically probe channels with boundary payloads (`null`, `""`, `{"__proto__": {"polluted": true}}`, `../../../../etc/passwd`, 1MB strings) while monitoring process health.

```json
{
  "name": "ipc_fuzz_and_verify",
  "arguments": {
    "channels": ["app:save-file", "workspace:load-config", "user:update-profile"],
    "delayMs": 50
  }
}
```

### Output Analysis
- Returns severity scores (`hardened`, `vulnerable`, `crashed`).
- Flags unhandled promise rejections in the main process.
- Verifies the application remains responsive without crash signals from the watchdog.

---

## 3. Dark Mode & Responsive Viewport Matrix Sweep

### Problem
Desktop apps frequently suffer from clipping, unexpected horizontal scrollbars, and contrast bugs when resized or toggled between light and dark themes.

### Solution
Use `responsive_theme_matrix` to sweep through color schemes and viewport dimensions, automatically testing `document.documentElement.scrollWidth > window.innerWidth`.

```json
{
  "name": "responsive_theme_matrix",
  "arguments": {
    "themes": ["light", "dark"],
    "viewports": [
      { "width": 800, "height": 600 },
      { "width": 1280, "height": 800 },
      { "width": 1920, "height": 1080 }
    ],
    "captureScreenshots": true,
    "outputDir": "./artifacts/theme-matrix"
  }
}
```

---

## 4. Network Chaos & Offline Fault Recovery Drill

### Problem
Electron apps must handle internet disconnections, server outages, and flaky networks gracefully without hanging or silently losing user changes.

### Solution
Execute `offline_resilience_check` to simulate an offline disruption during an active interaction, verify offline banners, restore the network, and evaluate recovery.

```json
{
  "name": "offline_resilience_check",
  "arguments": {
    "actionSelector": "button#sync-cloud-btn",
    "disruptionType": "offline",
    "disruptionDurationMs": 3000,
    "recoveryTimeoutMs": 5000
  }
}
```

### Evaluation
The tool awards a grade (`A`, `B`, `C`, or `F`) based on whether the app survived, caught unhandled rejections, and successfully re-established backend sync.

---

## 5. Zero-Flake Multi-Field Accessible Form Solver

### Problem
Filling complex forms with traditional selectors (`#input-12`) is brittle and breaks on minor layout changes.

### Solution
Use `fill_form` to fill forms in a single turn using accessibility labels, placeholders, or dictionary mappings.

```json
{
  "name": "fill_form",
  "arguments": {
    "fields": {
      "Organization Name": "Acme Aerospace",
      "Account Email": "admin@acme-aero.com",
      "Billing Tier": "Enterprise",
      "Enable Multi-Region": true,
      "API Key": "{{secret:ACME_API_TOKEN}}"
    },
    "submitSelector": "button#create-org-btn",
    "waitForNetworkIdle": true
  }
}
```

---

## 6. Electron Security Posture & Binary Fuse Audit

### Problem
Insecure Electron configurations (`nodeIntegration: true`, disabled `contextIsolation`, unvetted `setWindowOpenHandler`) expose desktop apps to critical RCE vulnerabilities.

### Solution
Run `electron_security_audit` to evaluate webPreferences, sandbox policies, navigation guards, and binary fuses against Electron Security Recommendations.

```json
{
  "name": "electron_security_audit",
  "arguments": {}
}
```

### Report Findings
- WebPreferences audit: `sandbox`, `contextIsolation`, `nodeIntegration`, `webSecurity`.
- Binary fuses: RunAsNode, EnableCookieEncryption, OnlyLoadAppFromAsar.
- Navigation guards: `will-navigate` restrictions, external link sanitization.

---

## 7. Zero-Leak Secret Ingestion with Masking

### Problem
Agents often need to enter credentials, private keys, or API tokens into desktop apps, but secrets must never leak into MCP logs or model context.

### Solution
Use `run_script` with `{{secret:ENV_VAR}}` references. The server resolves values from `process.env` in memory and masks them with `[REDACTED]`.

```json
{
  "name": "run_script",
  "arguments": {
    "script": [
      {
        "tool": "type_text",
        "args": {
          "selector": "input#api-key",
          "text": "{{secret:PRODUCTION_DEPLOY_KEY}}"
        }
      },
      {
        "tool": "click",
        "args": { "selector": "button#verify-key" }
      },
      {
        "tool": "wait_for",
        "args": { "selector": "div.badge-success", "timeoutMs": 5000 }
      }
    ]
  }
}
```

---

## 8. Memory Leak Detection & Heap Growth Diffing

### Problem
Single-page Electron desktop apps that stay open for weeks accumulate detached DOM trees, lingering IPC listeners, and uncollected closures.

### Solution
Use `leak_check` to run iteration cycles while capturing V8 heap allocations before and after garbage collection.

```json
{
  "name": "leak_check",
  "arguments": {
    "action": "click",
    "selector": "button#open-close-settings-modal",
    "iterations": 25,
    "settleMs": 300
  }
}
```

### Metrics Returned
- Initial vs. final heap size (MB).
- Growth percentage and leak classification.
- Detached DOM node count.

---

## 9. IPC Contract & TypeScript Type Inference

### Problem
Legacy Electron codebases often lack typed contracts for renderer-to-main IPC communication, making refactoring error-prone.

### Solution
Tap IPC traffic during real user flows, then invoke `ipc_schema_inference` to automatically synthesize TypeScript interfaces.

```json
// Step 1: Install tap
{ "name": "ipc_tap", "arguments": {} }

// Step 2: Perform app actions (click, navigate, fetch)
// ...

// Step 3: Infer schemas
{
  "name": "ipc_schema_inference",
  "arguments": {
    "generateTypeScript": true
  }
}
```

### Output TypeScript
```typescript
export interface AppGetUserSettingsResponse {
  theme: "light" | "dark";
  autoSaveInterval: number;
  telemetryEnabled: boolean;
}
```

---

## 10. Multi-Window Sync & Topology Mapper

### Problem
Complex desktop applications (like Slack, VS Code, or Spotify) maintain multiple BrowserWindows, detached palettes, and background utility workers.

### Solution
Use `webcontents_topology` to inspect the full hierarchy of windows and targets, followed by `focus_window` and `set_window_bounds`.

```json
// Step 1: Inspect topology
{ "name": "webcontents_topology", "arguments": {} }

// Step 2: Position auxiliary window
{
  "name": "set_window_bounds",
  "arguments": {
    "windowId": 2,
    "width": 400,
    "height": 600,
    "x": 100,
    "y": 100
  }
}

// Step 3: Bring to front
{
  "name": "focus_window",
  "arguments": {
    "windowId": 2
  }
}
```

---

## 11. Native OS Dialog & Shell API Mocking

### Problem
Automated tests freeze when Electron triggers a native OS file picker (`dialog.showOpenDialog`) or shell handler (`shell.openExternal`).

### Solution
Mock the native API in the main process before running the action.

```json
// Step 1: Mock file open dialog
{
  "name": "mock_electron_api",
  "arguments": {
    "api": "dialog.showOpenDialog",
    "returnValue": {
      "canceled": false,
      "filePaths": ["/fixtures/sample-dataset.csv"]
    }
  }
}

// Step 2: Trigger dialog button in UI
{
  "name": "click",
  "arguments": { "selector": "button#import-csv-btn" }
}

// Step 3: Verify mock was invoked
{
  "name": "get_mock_calls",
  "arguments": { "api": "dialog.showOpenDialog" }
}

// Step 4: Clean up
{
  "name": "restore_electron_mocks",
  "arguments": {}
}
```

---

## 12. Native Application Menu & Global Shortcut Triggering

### Problem
Essential desktop functionality (like Command Palette, Export, or Preferences) is often accessible only via the native application menu bar or global keyboard shortcuts.

### Solution
Inspect menu items with `get_application_menu`, click items by path, or trigger accelerators directly.

```json
// Trigger via menu hierarchy
{
  "name": "click_menu_item",
  "arguments": {
    "path": "File > Preferences > Settings"
  }
}

// Or trigger global shortcut accelerator
{
  "name": "trigger_shortcut",
  "arguments": {
    "accelerator": "CommandOrControl+Shift+P"
  }
}
```

---

## 13. Session Hydration & Storage State Migration

### Problem
Logging in via UI on every test run is slow and triggers MFA/CAPTCHA bottlenecks.

### Solution
Dump storage state (cookies, localStorage, sessionStorage) once, then re-hydrate on subsequent runs.

```json
// Step 1: Save state after login
{
  "name": "save_storage_state",
  "arguments": {
    "path": "./artifacts/authenticated-session.json"
  }
}

// Step 2: Hydrate state in fresh instance
{
  "name": "load_storage_state",
  "arguments": {
    "path": "./artifacts/authenticated-session.json"
  }
}
```

---

## 14. Local Source Map De-Minifier & Stack Resolver

### Problem
Renderer errors in production-like builds contain minified call frames (`bundle.min.js:1:34892`), hiding the root cause.

### Solution
Use `resolve_stack` to decode stack frames against local source maps via `file://` URLs.

```json
{
  "name": "resolve_stack",
  "arguments": {
    "stack": "TypeError: Cannot read properties of undefined\n    at t.render (file:///C:/app/dist/bundle.min.js:1:34892)"
  }
}
```

### Result
Outputs the original TypeScript file (`src/components/UserProfile.tsx`), line number, column, and the code snippet context.

---

## 15. Full-Session HAR Network Capture & Analysis

### Problem
Debugging API synchronization bugs requires complete headers, payloads, and timing breakdowns across all network requests.

### Solution
Collect all network traffic and export a standard HAR 1.2 archive for inspection in Chrome DevTools or Charles.

```json
{
  "name": "export_har",
  "arguments": {
    "outputPath": "./artifacts/full-session.har"
  }
}
```

---

## 16. Crash Loop & Watchdog Health Diagnostics

### Problem
Uncaught native C++ exceptions or V8 Out-Of-Memory events terminate renderers silently, leaving white screens.

### Solution
Query `get_process_health` to retrieve watchdog event telemetry.

```json
{
  "name": "get_process_health",
  "arguments": {}
}
```

### Output Data
- Renderer state: `healthy`, `crashed`, `hung`.
- Crash reason: `oom`, `killed`, `crashed`, `integrity-failure`.
- Window responsiveness and event loop latency.

---

## 17. Time-Travel Testing with Virtual Clock

### Problem
Testing countdown timers, session timeouts, or auto-save intervals requires waiting for real wall-clock seconds.

### Solution
Use `virtual_clock` to fast-forward time instantly.

```json
// Fast-forward 60 seconds
{
  "name": "virtual_clock",
  "arguments": {
    "advanceMs": 60000
  }
}
```

---

## 18. Native OS Clipboard Data Automation

### Problem
Copy-to-clipboard buttons and paste handlers interact with the host operating system clipboard rather than the browser DOM clipboard.

### Solution
Directly inspect and write OS clipboard contents via the main process.

```json
// Read clipboard content
{ "name": "get_clipboard", "arguments": {} }

// Write custom clipboard content
{
  "name": "set_clipboard",
  "arguments": {
    "text": "CONF-9824-VALIDATION-TOKEN"
  }
}
```

---

## 19. Visual Regression Testing with Element Masking

### Problem
Dynamic timestamps, avatars, or animated badges cause false positives in screenshot diffs.

### Solution
Use `diff_screenshot` with element masking and pixel tolerance.

```json
{
  "name": "diff_screenshot",
  "arguments": {
    "baselinePath": "./baselines/dashboard.png",
    "candidatePath": "./artifacts/dashboard-current.png",
    "diffOutputPath": "./artifacts/dashboard-diff.png",
    "tolerance": 0.02
  }
}
```

---

## 20. Self-Healing Test Workflow with Playwright Code Synthesis

### Problem
Writing and maintaining end-to-end tests manually takes hours. Teams need automated workflows that run, verify, and export directly to Playwright code.

### Solution
Execute `run_script` with `exportAs: "playwright"`.

```json
{
  "name": "run_script",
  "arguments": {
    "script": [
      {
        "name": "Navigate to Home",
        "tool": "navigate",
        "args": { "url": "https://app.local" }
      },
      {
        "name": "Open Settings",
        "tool": "click",
        "args": { "selector": "button#settings-btn" }
      },
      {
        "name": "Assert Settings Dialog Open",
        "tool": "wait_for",
        "args": { "selector": "div.settings-modal", "timeoutMs": 3000 }
      }
    ],
    "exportAs": "playwright",
    "exportPath": "./e2e/generated-settings.spec.ts"
  }
}
```

### Synthesized Playwright Test
The generated file is a standalone, runnable Playwright test suite replicating the exact verified steps.
