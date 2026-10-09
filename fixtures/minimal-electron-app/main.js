const { app, BrowserWindow } = require("electron");
const path = require("path");

// Helpful in CI/containers; CLI --no-sandbox is still preferred.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");

let mainWindow;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    // Show only when a display is available (Linux Xvfb sets DISPLAY). Showing a
    // window on headless Windows/macOS CI hangs Page.captureScreenshot.
    show: process.env.CI === "true" && Boolean(process.env.DISPLAY),
    // Keep painting while hidden so CDP screenshots still get a surface.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Keep running until the MCP server stops us.
  console.log("minimal-electron-app ready");
});

function rememberDeepLink(url) {
  if (!url) return;
  // Synchronous on purpose. executeJavaScript does not settle while CDP is attached.
  global.__LAST_DEEP_LINK__ = String(url);
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  rememberDeepLink(url);
});

app.on("second-instance", (_event, argv) => {
  const link = [...(argv || [])]
    .reverse()
    .find((arg) => typeof arg === "string" && arg.includes("://"));
  rememberDeepLink(link);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
