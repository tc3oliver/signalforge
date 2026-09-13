import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write JSON durably: temp file -> fsync -> atomic rename. An agent crash mid-run
 * can then never leave a half-written artifact that the next stage would parse.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

export function writeTextAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonIfExists<T>(path: string): T | undefined {
	return existsSync(path) ? readJson<T>(path) : undefined;
}
