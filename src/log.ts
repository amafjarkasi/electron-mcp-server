/**
 * MCP stdio transport requires stdout to be JSON-RPC only.
 * All diagnostic output must go to stderr.
 */
export const log = {
  info(message: string, ...args: unknown[]): void {
    console.error(`[electron-mcp] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.error(`[electron-mcp:warn] ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[electron-mcp:error] ${message}`, ...args);
  },
};
