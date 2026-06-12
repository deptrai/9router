// Shared process-shutdown registry.
//
// Problem: each adapter/repo used to call process.on("beforeExit"|"SIGINT"|
// "SIGTERM", ...) at construction. The `process` object is shared across all
// vitest module realms, so every re-import added new listener closures whose
// identities differed from prior ones — process.off() could never remove them.
// Listeners accumulated past Node's default max of 10 and emitted
// MaxListenersExceededWarning.
//
// Fix: attach exactly ONE listener per signal process-wide (tracked on a global
// so Next.js hot-reload and vitest realm resets don't re-add them), and
// dispatch to keyed callbacks. Adapters/repos register/unregister by key.

if (!global._dbCleanup) {
  global._dbCleanup = { handlers: new Map(), wired: false };
}
const state = global._dbCleanup;

function runAll(reason) {
  for (const fn of state.handlers.values()) {
    try {
      fn(reason);
    } catch {}
  }
}

function wireOnce() {
  if (state.wired) return;
  state.wired = true;

  process.on("beforeExit", () => runAll("beforeExit"));
  process.on("SIGINT", () => {
    runAll("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    runAll("SIGTERM");
    process.exit(0);
  });
}

/**
 * Register a cleanup callback under a stable key. Re-registering the same key
 * replaces the prior callback (no listener growth). Returns an unregister fn.
 */
export function registerCleanup(key, fn) {
  wireOnce();
  state.handlers.set(key, fn);
  return () => unregisterCleanup(key);
}

export function unregisterCleanup(key) {
  state.handlers.delete(key);
}
