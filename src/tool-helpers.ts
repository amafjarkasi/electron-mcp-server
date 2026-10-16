import { getProcess, type ElectronProcess } from "./process-manager.js";

export function textResult(data: unknown, isError = false) {
	return {
		content: [
			{
				type: "text" as const,
				text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
			},
		],
		isError,
	};
}

export function requireRunningProcess(processId: string): ElectronProcess {
	const proc = getProcess(processId);
	if (!proc) {
		throw new Error(`Process not found: ${processId}`);
	}
	if (proc.status !== "running") {
		throw new Error(`Process ${processId} is ${proc.status}`);
	}
	return proc;
}
