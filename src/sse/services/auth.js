import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";
import { resolveActiveEntitlement, ROUTE_POLICY } from "@/lib/db/repos/entitlementsRepo.js";
import { MAX_IN_FLIGHT_PER_CONNECTION, LEASE_MAX_MS } from "open-sse/config/runtimeConfig.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// Negative cache for all-locked state (per-process, TTL ≤2s, DB is source of truth)
// Key: `${providerId}:${model||"__all"}` → { expiresAt: number, retryAfter: string, retryAfterHuman: string }
const _allLockedCache = new Map();

// Per-process in-flight counter (not persisted — same pattern as _allLockedCache)
const _inFlight = new Map(); // connectionId → number

function _acquire(connectionId) {
  if (!connectionId || connectionId === "noauth") return { release: () => {}, connectionId: null };
  _inFlight.set(connectionId, (_inFlight.get(connectionId) || 0) + 1);
  let released = false;
  const timer = setTimeout(() => release(), LEASE_MAX_MS);
  if (timer.unref) timer.unref();
  function release() {
    if (released) return;
    released = true;
    clearTimeout(timer);
    const next = (_inFlight.get(connectionId) || 0) - 1;
    if (next > 0) _inFlight.set(connectionId, next);
    else _inFlight.delete(connectionId); // count→0: drop entry (avoid zero-count map growth)
  }
  return { release, connectionId };
}

export function getInFlightCount(connectionId) {
  return _inFlight.get(connectionId) || 0;
}

// Exported for unit tests — acquire an in-flight lease for a connection.
export function _acquireLeaseForTest(connectionId) {
  return _acquire(connectionId);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Check negative cache for all-locked state (only when excludeSet is empty AND
    // no userId — the cache key is provider-scoped, but with entitlement routing the
    // available pool is user-scoped, so a cached shared-pool result is NOT valid for
    // an entitlement user and vice-versa (P3 cross-user poisoning guard).
    const userIdForCache = options?.userId ?? null;
    if (excludeSet.size === 0 && userIdForCache == null) {
      const cacheKey = `${providerId}:${model || "__all"}`;
      const cached = _allLockedCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        // Per-process cache only, max staleness 2s; DB remains the source of truth.
        // Each process may lag by up to 2s, which is acceptable for fail-fast behavior.
        log.debug("AUTH", `${provider} | all-locked cached (${cached.retryAfterHuman})`);
        return {
          allRateLimited: true,
          retryAfter: cached.retryAfter,
          retryAfterHuman: cached.retryAfterHuman,
          _cached: true
        };
      }
    }

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // --- Entitlement routing layer (2.29b) ---
    // QĐ1: opts.userId null/undefined → skip entitlement resolve (zero overhead).
    const userId = options?.userId ?? null;
    // Default pool = shared only. Owned connections (ownerUserId != null) require an
    // ACTIVE entitlement to be selected and never leak to legacy/null-userId callers
    // (M5/P2). Non-SaaS DBs have no owned connections so this filter is a no-op there.
    let poolConnections = connections.filter(c => c.ownerUserId == null);

    if (userId != null) {
      let entitlementResult = null;
      try {
        entitlementResult = await resolveActiveEntitlement(userId, providerId);
      } catch (err) {
        // Infra-error → fail-open shared pool (M3/AC3). Do NOT throw — 503 penalises user for our bug.
        log.error("AUTH", `entitlement resolve error, fail-open: ${err?.message}`);
      }

      if (!entitlementResult) {
        // No active entitlement → strict shared pool (M5): only null-owned connections.
        // Owned connections require an active entitlement — even the user's own (AC4).
        poolConnections = connections.filter(c => c.ownerUserId == null);
      } else {
        const { routePolicy } = entitlementResult;
        // Strict match (M4): null !== userId — null = shared, never owned-by-user.
        const ownedConns = connections.filter(c => c.ownerUserId === userId);

        if (routePolicy === ROUTE_POLICY.OWNED_ONLY) {
          if (ownedConns.length === 0) {
            // Policy-decision block (AC5/QĐ3). NOT infra-error — do NOT fail-open.
            return { ownedOnlyUnavailable: true, reason: "No active owned connection. Please link your provider account to activate this entitlement." };
          }
          // owned_only NEVER falls back to shared (M3 policy-decision). When all owned
          // are model-locked → downstream allRateLimited (retry timing). When excluded
          // mid-retry → null → caller surfaces lastError (account is linked, just errored
          // this request — clearer than a generic "link your account" message). (P5)
          poolConnections = ownedConns;
        } else {
          // prefer_owned (QĐ7): owned if available after excludeSet/modelLock, else shared minus other-owned.
          const ownedAvail = ownedConns.filter(c => !excludeSet.has(c.id) && !isModelLockActive(c, model));
          poolConnections = ownedAvail.length > 0
            ? ownedConns
            : connections.filter(c => c.ownerUserId == null);
        }
      }
    }
    // --- End entitlement routing layer ---

    // Filter out model-locked and excluded connections
    const availableConnections = poolConnections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${poolConnections.length} (total loaded: ${connections.length})`);
    poolConnections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across pool connections for retry timing
      const lockedConns = poolConnections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${poolConnections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);

        // Set negative cache only for the shared path (excludeSet empty AND no userId).
        // With entitlement routing the pool is user-scoped, so a per-user all-locked
        // result must NOT poison the shared cache for other users (P3).
        if (excludeSet.size === 0 && userId == null) {
          const cacheKey = `${providerId}:${model || "__all"}`;
          const cacheTTL = Math.max(1, Math.min(2000, new Date(earliest).getTime() - Date.now()));
          _allLockedCache.set(cacheKey, {
            expiresAt: Date.now() + cacheTTL,
            retryAfter: earliest,
            retryAfterHuman: formatRetryAfter(earliest)
          });
        }

        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${poolConnections.length} accounts unavailable`);
      return null;
    }

    // In-flight aware pool: prefer connections with available slots
    const idleConnections = availableConnections.filter(
      c => (_inFlight.get(c.id) || 0) < MAX_IN_FLIGHT_PER_CONNECTION
    );
    // All busy → degrade to least-loaded (no hard fail — connection is alive, just busy)
    const poolForSelect = idleConnections.length > 0
      ? idleConnections
      : [...availableConnections].sort(
          (a, b) => (_inFlight.get(a.id) || 0) - (_inFlight.get(b.id) || 0)
        );
    log.debug("AUTH", `${provider} | idle: ${idleConnections.length}/${availableConnections.length} | inFlight: ${[...availableConnections].map(c => `${c.id?.slice(0,8)}=${_inFlight.get(c.id)||0}`).join(",")}`);

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available.
    // Search full availableConnections (not poolForSelect) — explicit pin always honored
    // even when the connection is busy; idle-first only applies to unpinned selection.
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...poolForSelect].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...poolForSelect].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
      // On successful selection, evict negative cache so next query hits DB
      _allLockedCache.delete(`${providerId}:${model || "__all"}`);
    } else {
      // Default: fill-first with health-aware ranking
      // Penalize accounts with lastErrorAt < 60s ago by pushing them to the end.
      // If only one account available (even if recently failed), still choose it.
      const now = Date.now();
      const HEALTH_PENALTY_WINDOW_MS = 60 * 1000;

      const ranked = [...poolForSelect].sort((a, b) => {
        // Compute health penalty: 1 if lastErrorAt < 60s ago, 0 otherwise
        const aPenalty = (a.lastErrorAt && (now - new Date(a.lastErrorAt).getTime() < HEALTH_PENALTY_WINDOW_MS)) ? 1 : 0;
        const bPenalty = (b.lastErrorAt && (now - new Date(b.lastErrorAt).getTime() < HEALTH_PENALTY_WINDOW_MS)) ? 1 : 0;

        // Sort by penalty ascending (healthy first), then by priority ascending
        if (aPenalty !== bPenalty) return aPenalty - bPenalty;
        return (a.priority || 999) - (b.priority || 999);
      });

      connection = ranked[0];
      // On successful selection, evict negative cache so next query hits DB
      _allLockedCache.delete(`${providerId}:${model || "__all"}`);
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
    const _lease = _acquire(connection.id);

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection,
      _lease,
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable.
 * Request/model-scoped failures lock modelLock_${model}; fatal auth failures
 * lock modelLock___all so a dead OAuth account does not re-enter the pool.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };

  // Acquire mutex to prevent concurrent backoffLevel read-write race
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });
  try {
    await currentMutex;
  } finally {
    // Release immediately after acquiring — we only need serialization of the read-modify-write below
    if (resolveMutex) resolveMutex();
  }

  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel, scope;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel, scope } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";
  const lockUpdate = buildModelLockUpdate(scope === "account" ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 });
  }

  await updateProviderConnection(connectionId, clearObj);

  // Evict negative cache so next query hits DB (provider unknown here, so clear all matching model key)
  for (const key of _allLockedCache.keys()) {
    if (model && key.endsWith(`:${model}`)) _allLockedCache.delete(key);
    else if (!model) _allLockedCache.delete(key);
  }
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
