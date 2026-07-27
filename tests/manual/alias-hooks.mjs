/**
 * Module resolve hook mapping the `@/*` alias to `./src/*` (mirrors jsconfig.json paths and
 * tests/vitest.config.js resolve.alias). Loaded by register-alias.mjs.
 */
const REPO_ROOT = new URL("../../", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@" || specifier.startsWith("@/")) {
    const relative = specifier === "@" ? "src/" : `src/${specifier.slice(2)}`;
    return nextResolve(new URL(relative, REPO_ROOT).href, context);
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    const relative = specifier === "open-sse" ? "open-sse/" : `${specifier}`;
    return nextResolve(new URL(relative, REPO_ROOT).href, context);
  }
  return nextResolve(specifier, context);
}
