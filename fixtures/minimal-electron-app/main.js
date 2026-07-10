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
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Keep running until the MCP server stops us.
  console.log("minimal-electron-app ready");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
