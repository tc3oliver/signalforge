import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminEnabled } from "../web/lib/admin.ts";

const root = join(import.meta.dirname, "..");

describe("admin gate", () => {
	it("is off when the variable is absent or empty", () => {
		expect(adminEnabled({})).toBe(false);
		expect(adminEnabled({ SIGNALFORGE_ADMIN: "" })).toBe(false);
		expect(adminEnabled({ SIGNALFORGE_ADMIN: "0" })).toBe(false);
		expect(adminEnabled({ SIGNALFORGE_ADMIN: "no" })).toBe(false);
	});

	it("is on only for an explicit opt-in", () => {
		expect(adminEnabled({ SIGNALFORGE_ADMIN: "1" })).toBe(true);
		expect(adminEnabled({ SIGNALFORGE_ADMIN: "true" })).toBe(true);
		expect(adminEnabled({ SIGNALFORGE_ADMIN: " TRUE " })).toBe(true);
	});

	it("blocks every /admin route from one layout", () => {
		const layout = readFileSync(join(root, "web", "app", "admin", "layout.tsx"), "utf8");
		expect(layout).toMatch(/if \(!ADMIN_ENABLED\) notFound\(\)/);
	});

	// A link rendered unconditionally would advertise the section to a public
	// reader and 404 them, which is worse than not showing it at all.
	it("guards every link into /admin", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules" || entry.name === ".next") continue;
					walk(path);
					continue;
				}
				if (!/\.tsx?$/.test(entry.name)) continue;
				const source = readFileSync(path, "utf8");
				// Files inside /admin are already behind the layout.
				if (path.includes(join("app", "admin"))) continue;
				if (!source.includes("/admin")) continue;
				if (!source.includes("ADMIN_ENABLED")) offenders.push(path.slice(root.length + 1));
			}
		};
		// Only rendered surfaces; a script's comment mentioning the path is not a link.
		walk(join(root, "web", "app"));
		walk(join(root, "web", "components"));
		expect(offenders).toEqual([]);
	});
});
