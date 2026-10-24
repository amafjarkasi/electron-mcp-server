import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { getProcess, getAllProcesses, type ElectronProcess } from "./process-manager.js";

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

/**
 * Resolves a process by ID, or automatically selects the single running process
 * when processId is omitted. Throws if not found or if multiple processes run.
 */
export function resolveProcess(processId?: string): ElectronProcess {
	if (processId) {
		const proc = getProcess(processId);
		if (!proc) {
			throw new Error(`Process not found: ${processId}`);
		}
		return proc;
	}
	const running = Array.from(getAllProcesses().values()).filter(
		(p) => p.status === "running",
	);
	if (running.length === 1) {
		return running[0];
	}
	if (running.length === 0) {
		throw new Error(
			"No running Electron process found. Start an app with start_app or attach first.",
		);
	}
	throw new Error(
		`Multiple running processes found (${running.map((p) => p.id).join(", ")}). Please specify processId.`,
	);
}

/**
 * Ensures the target process exists and is currently in 'running' status.
 */
export function requireRunningProcess(processId?: string): ElectronProcess {
	const proc = resolveProcess(processId);
	if (proc.status !== "running") {
		throw new Error(`Process ${proc.id} is ${proc.status}`);
	}
	return proc;
}

/**
 * Reusable wrapper that resolves the target process, executes the handler,
 * and formats the response as standard MCP textResult with error protection.
 */
export function withProcess<T extends { processId?: string }>(
	handler: (proc: ElectronProcess, args: T) => Promise<unknown> | unknown,
) {
	return async (args: T) => {
		try {
			const proc = requireRunningProcess(args.processId);
			const res = await handler(proc, args);
			return textResult(res);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	};
}

export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface RegisterToolOptions<Args extends ZodRawShape = ZodRawShape> {
	description: string;
	params?: Args;
	annotations?: ToolAnnotations;
}

/**
 * Registers an MCP tool on the server with annotations metadata attached.
 */
export function registerTool<Args extends ZodRawShape>(
	server: McpServer,
	name: string,
	options: RegisterToolOptions<Args>,
	cb: (args: z.objectOutputType<Args, z.ZodTypeAny>) => Promise<any> | any,
): void {
	if (options.params) {
		server.tool(name, options.description, options.params, cb as any);
	} else {
		server.tool(name, options.description, cb as any);
	}

	const registered = (server as any)._registeredTools?.[name];
	if (registered && options.annotations) {
		registered.annotations = options.annotations;
	}
}
