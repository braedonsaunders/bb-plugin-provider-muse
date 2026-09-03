import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    setupFiles: ["./test/setup.ts"],
    /** Each file drives the bridge singleton, so no two may share a worker. */
    pool: "forks",
    poolOptions: { forks: { isolate: true } },
    testTimeout: 30_000,
    /**
     * The SDK ships one esbuild bundle per entry. Inlining it lets the CommonJS
     * interop shim see the `require` the setup file installs.
     */
    server: { deps: { inline: [/@get-bb\/plugin-sdk/] } },
  },
});
