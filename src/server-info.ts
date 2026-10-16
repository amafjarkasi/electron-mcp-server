import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

export const SERVER_VERSION = (
	require("../package.json") as { version: string }
).version;

export const startedAt = Date.now();

export function resolveElectronBinary(): {
	resolved: boolean;
	path?: string;
	via?: string;
	error?: string;
} {
	const envPath = process.env.ELECTRON_PATH?.trim();
	if (envPath) {
		return {
			resolved: existsSync(envPath),
			path: envPath,
			via: "ELECTRON_PATH",
		};
	}
	try {
		const fromPackage = require("electron") as string;
		if (fromPackage && existsSync(fromPackage)) {
			return {
				resolved: true,
				path: fromPackage,
				via: "require(electron)",
			};
		}
		return {
			resolved: false,
			path: fromPackage || undefined,
			via: "require(electron)",
		};
	} catch (err) {
		return {
			resolved: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
