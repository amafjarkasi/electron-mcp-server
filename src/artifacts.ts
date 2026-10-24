import { promises as fs } from "node:fs";
import path from "node:path";

export interface ArtifactEntry {
	id: string;
	processId: string;
	type: "screenshot" | "trace" | "cpuprofile" | "heapsnapshot" | "har" | "pdf" | "mhtml" | "other";
	filePath: string;
	mimeType: string;
	createdAt: Date;
}

const artifacts = new Map<string, ArtifactEntry>();

export function registerArtifact(
	processId: string,
	type: ArtifactEntry["type"],
	filePath: string,
	mimeType?: string,
): ArtifactEntry {
	const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const defaultMime: Record<ArtifactEntry["type"], string> = {
		screenshot: filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg" : "image/png",
		trace: "application/json",
		cpuprofile: "application/json",
		heapsnapshot: "application/json",
		har: "application/json",
		pdf: "application/pdf",
		mhtml: "multipart/related",
		other: "application/octet-stream",
	};

	const entry: ArtifactEntry = {
		id,
		processId,
		type,
		filePath: path.resolve(filePath),
		mimeType: mimeType || defaultMime[type],
		createdAt: new Date(),
	};
	artifacts.set(id, entry);
	return entry;
}

export function listArtifacts(): ArtifactEntry[] {
	return Array.from(artifacts.values()).sort(
		(a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
	);
}

export function getArtifact(id: string): ArtifactEntry | undefined {
	return artifacts.get(id);
}

export async function readArtifactContent(entry: ArtifactEntry): Promise<{
	mimeType: string;
	text?: string;
	blob?: string;
}> {
	const stat = await fs.stat(entry.filePath);
	if (entry.mimeType.startsWith("text/") || entry.mimeType === "application/json") {
		const text = await fs.readFile(entry.filePath, "utf8");
		return { mimeType: entry.mimeType, text };
	}
	const buf = await fs.readFile(entry.filePath);
	return { mimeType: entry.mimeType, blob: buf.toString("base64") };
}
