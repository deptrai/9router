/**
 * Resolver hook so the manual E2E scripts can import application modules directly.
 *
 * `src/**` uses the `@/*` -> `./src/*` alias from jsconfig.json. Vitest applies it via
 * resolve.alias, and Next.js via its own resolver, but plain `node` knows nothing about it —
 * so importing e.g. src/lib/db/paths.js (which imports `@/lib/dataDir.js`) fails with
 * ERR_MODULE_NOT_FOUND. This registers the same mapping for a bare node run.
 *
 * Usage:
 *   node --import ./tests/manual/register-alias.mjs tests/manual/<script>.mjs
 */
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
