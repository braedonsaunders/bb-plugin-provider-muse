import { createRequire } from "node:module";

/**
 * The SDK's provider-bridge bundle keeps esbuild's CommonJS interop shim, which
 * needs a real `require`. bb's bridge worker entry injects one the same way, so
 * tests that import the kit directly do too.
 */
const globals = globalThis as Record<string, unknown>;
if (typeof globals.require !== "function") {
  globals.require = createRequire(import.meta.url);
}
