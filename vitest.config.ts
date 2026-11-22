import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import the package by name, as hosts do, from its source.
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	test: { environment: "node", include: ["test/**/*.test.ts"] },
	resolve: {
		alias: [
			{ find: /^pi-durable-a2a$/, replacement: source("./src/index.ts") },
			{ find: /^pi-durable-a2a\/litellm$/, replacement: source("./src/litellm.ts") },
		],
	},
});
