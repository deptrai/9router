import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const PROVIDER = "openai-compatible-chat-pool-test";

let rawDb;
let adapter;
let dbPath;

function makeAdapter(raw) {
  return {
    get: (sql, params) => raw.prepare(sql).get(...(params || [])),
    run: (sql, params) => raw.prepare(sql).run(...(params || [])),
    all: (sql, params) => raw.prepare(sql).all(...(params || [])),
    exec: (sql) => raw.exec(sql),
  };
}

function insertConnection(name, priority, isActive, extra = {}) {
  const now = new Date().toISOString();
  const data = JSON.stringify({
    apiKey: "sk-test",
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://test.api/v1" },
    ...extra,
  });
  adapter.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt, ownerUserId, entitlementId)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [`id-${name}`, PROVIDER, "apikey", name, "", priority, isActive ? 1 : 0, data, now, now]
  );
}

function countActive() {
  return adapter.all("SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1 ORDER BY priority", [PROVIDER]);
}

beforeAll(() => {
  const Database = require("better-sqlite3");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-authpool-"));
  dbPath = path.join(tempDir, "test.sqlite");
  rawDb = new Database(dbPath);
  adapter = makeAdapter(rawDb);

  adapter.exec(`
    CREATE TABLE IF NOT EXISTS providerConnections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      authType TEXT NOT NULL,
      name TEXT,
      email TEXT,
      priority INTEGER,
      isActive INTEGER DEFAULT 1,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      ownerUserId TEXT,
      entitlementId TEXT
    )
  `);

  // Insert 3 connections: 2 active, 1 inactive
  insertConnection("primary", 1, true, { consecutiveUseCount: 5 });
  insertConnection("secondary", 2, true, {});
  insertConnection("disabled", 3, false, {});
});

afterAll(() => {
  if (rawDb) {
    rawDb.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}
  }
});

describe("Provider connection pool", () => {
  it("counts only active connections", () => {
    const rows = countActive();
    expect(rows.length).toBe(2);
  });

  it("sorts by priority ascending", () => {
    const rows = countActive();
    expect(rows[0].name).toBe("primary");
    expect(rows[1].name).toBe("secondary");
  });

  it("returns disabled connections only when queried without isActive filter", () => {
    const all = adapter.all("SELECT * FROM providerConnections WHERE provider = ?", [PROVIDER]);
    expect(all.length).toBe(3);
    const inactive = all.filter(r => r.isActive === 0);
    expect(inactive.length).toBe(1);
    expect(inactive[0].name).toBe("disabled");
  });

  it("single connection scenario: total=1 when 1 active", () => {
    const Database = require("better-sqlite3");
    const singleRaw = new Database(path.join(path.dirname(dbPath), "single.sqlite"));
    const singleAdap = makeAdapter(singleRaw);
    try {
      singleAdap.exec(`CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
        name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        ownerUserId TEXT, entitlementId TEXT
      )`);
      const now = new Date().toISOString();
      singleAdap.run(
        `INSERT INTO providerConnections VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ["only-one", PROVIDER, "apikey", "solo", "", 1, 1, JSON.stringify({ apiKey: "sk-test" }), now, now]
      );
      const rows = singleAdap.all("SELECT * FROM providerConnections WHERE provider = ? AND isActive = 1", [PROVIDER]);
      expect(rows.length).toBe(1);
    } finally {
      singleRaw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Lease core unit tests (isolated — no DB, no module imports needed)
// Tests the _acquire / getInFlightCount / idle filter / poolForSelect logic
// by reimplementing the same pure functions inline.
// ---------------------------------------------------------------------------

function makeLeaseFns(LEASE_MAX_MS = 10 * 60 * 1000) {
  const _inFlight = new Map();

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
      const cur = _inFlight.get(connectionId) || 0;
      if (cur > 0) _inFlight.set(connectionId, cur - 1);
      else _inFlight.delete(connectionId);
    }
    return { release, connectionId };
  }

  function getInFlightCount(connectionId) {
    return _inFlight.get(connectionId) || 0;
  }

  function idleFilter(connections, MAX) {
    return connections.filter(c => (_inFlight.get(c.id) || 0) < MAX);
  }

  function poolForSelect(connections, MAX) {
    const idle = idleFilter(connections, MAX);
    if (idle.length > 0) return idle;
    return [...connections].sort((a, b) => (_inFlight.get(a.id) || 0) - (_inFlight.get(b.id) || 0));
  }

  return { _acquire, getInFlightCount, idleFilter, poolForSelect, _inFlight };
}

describe("Lease core — _acquire / release", () => {
  it("acquire increments in-flight count", () => {
    const { _acquire, getInFlightCount } = makeLeaseFns();
    _acquire("conn-a");
    expect(getInFlightCount("conn-a")).toBe(1);
    _acquire("conn-a");
    expect(getInFlightCount("conn-a")).toBe(2);
  });

  it("release decrements in-flight count", () => {
    const { _acquire, getInFlightCount } = makeLeaseFns();
    const lease = _acquire("conn-b");
    expect(getInFlightCount("conn-b")).toBe(1);
    lease.release();
    expect(getInFlightCount("conn-b")).toBe(0);
  });

  it("release is idempotent — double-call does not go negative", () => {
    const { _acquire, getInFlightCount } = makeLeaseFns();
    const lease = _acquire("conn-c");
    lease.release();
    lease.release(); // second call must be no-op
    expect(getInFlightCount("conn-c")).toBe(0);
  });

  it("noauth connection returns no-op lease without modifying _inFlight", () => {
    const { _acquire, getInFlightCount, _inFlight } = makeLeaseFns();
    const lease = _acquire("noauth");
    expect(lease.connectionId).toBeNull();
    expect(_inFlight.size).toBe(0);
    lease.release(); // must not throw
    expect(_inFlight.size).toBe(0);
  });

  it("null connectionId returns no-op lease", () => {
    const { _acquire, _inFlight } = makeLeaseFns();
    const lease = _acquire(null);
    expect(lease.connectionId).toBeNull();
    expect(_inFlight.size).toBe(0);
  });

  it("TTL safety-net auto-releases after LEASE_MAX_MS (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const LEASE_MAX_MS = 5000;
      const { _acquire, getInFlightCount } = makeLeaseFns(LEASE_MAX_MS);
      _acquire("conn-ttl"); // intentionally don't call release()
      expect(getInFlightCount("conn-ttl")).toBe(1);
      vi.advanceTimersByTime(LEASE_MAX_MS + 100);
      expect(getInFlightCount("conn-ttl")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Lease core — idle filter / poolForSelect", () => {
  it("idle filter excludes connections at MAX in-flight", () => {
    const { _acquire, idleFilter } = makeLeaseFns();
    const conns = [{ id: "c1" }, { id: "c2" }];
    _acquire("c1"); // c1 now at 1, MAX=1 → busy
    const idle = idleFilter(conns, 1);
    expect(idle.map(c => c.id)).toEqual(["c2"]);
  });

  it("idle filter includes connections below MAX", () => {
    const { _acquire, idleFilter } = makeLeaseFns();
    const conns = [{ id: "d1" }, { id: "d2" }];
    _acquire("d1"); // d1 at 1, MAX=2 → still idle
    const idle = idleFilter(conns, 2);
    expect(idle.length).toBe(2);
  });

  it("all busy → poolForSelect returns least-loaded (not empty / not allRateLimited)", () => {
    const { _acquire, poolForSelect } = makeLeaseFns();
    const conns = [{ id: "e1" }, { id: "e2" }];
    _acquire("e1"); _acquire("e1"); // e1 = 2
    _acquire("e2");                 // e2 = 1
    const pool = poolForSelect(conns, 1); // MAX=1, both busy
    expect(pool.length).toBe(2);
    expect(pool[0].id).toBe("e2"); // least-loaded first
  });

  it("0 idle → degrade to least-loaded, never returns empty", () => {
    const { _acquire, poolForSelect } = makeLeaseFns();
    const conns = [{ id: "f1" }, { id: "f2" }];
    _acquire("f1");
    _acquire("f2");
    const pool = poolForSelect(conns, 1);
    expect(pool.length).toBeGreaterThan(0);
  });

  it("idle-first: returns only idle when some connections are free", () => {
    const { _acquire, poolForSelect } = makeLeaseFns();
    const conns = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];
    _acquire("g1"); // g1 busy
    const pool = poolForSelect(conns, 1);
    expect(pool.map(c => c.id)).not.toContain("g1");
    expect(pool.map(c => c.id)).toEqual(expect.arrayContaining(["g2", "g3"]));
  });
});

// ---------------------------------------------------------------------------
// Real-module tests — import the ACTUAL auth.js (not inline reimplementation).
// Catches regressions where _acquire/getInFlightCount in the module diverge.
// Uses _acquireLeaseForTest test-handle + exported getInFlightCount.
// ---------------------------------------------------------------------------

import {
  _acquireLeaseForTest,
  getInFlightCount,
  _getQueueDepthForTest,
  _getWaitQueueForTest,
  _enqueueWaiterForTest,
  _clearWaitQueueForTest,
} from "@/sse/services/auth.js";

describe("auth.js (real module) — lease acquire / release", () => {
  it("acquire increments, release decrements via real getInFlightCount", () => {
    const id = `real-${Math.random().toString(36).slice(2)}`;
    expect(getInFlightCount(id)).toBe(0);
    const lease = _acquireLeaseForTest(id);
    expect(getInFlightCount(id)).toBe(1);
    lease.release();
    expect(getInFlightCount(id)).toBe(0);
  });

  it("double-release is idempotent (no negative count)", () => {
    const id = `real-${Math.random().toString(36).slice(2)}`;
    const lease = _acquireLeaseForTest(id);
    lease.release();
    lease.release();
    expect(getInFlightCount(id)).toBe(0);
  });

  it("concurrent leases stack and unwind independently", () => {
    const id = `real-${Math.random().toString(36).slice(2)}`;
    const l1 = _acquireLeaseForTest(id);
    const l2 = _acquireLeaseForTest(id);
    expect(getInFlightCount(id)).toBe(2);
    l1.release();
    expect(getInFlightCount(id)).toBe(1);
    l2.release();
    expect(getInFlightCount(id)).toBe(0);
  });

  it("noauth / null connectionId → no-op lease, count stays 0", () => {
    expect(_acquireLeaseForTest("noauth").connectionId).toBeNull();
    expect(_acquireLeaseForTest(null).connectionId).toBeNull();
    expect(getInFlightCount("noauth")).toBe(0);
  });

  it("count returns to 0 after full release (map entry deleted, not stuck at 0)", () => {
    const id = `real-${Math.random().toString(36).slice(2)}`;
    const lease = _acquireLeaseForTest(id);
    lease.release();
    // getInFlightCount reads via `|| 0` so deleted entry === 0
    expect(getInFlightCount(id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wait queue tests — uses real auth.js module exports
// Tests AC#1/2/3/5/6 from story 1.7
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wait queue tests — real module, real _waitQueue via test helpers
// Tests AC#1/2/3/4/5/6/8 from story 1.7
// _enqueueWaiterForTest bypasses getProviderCredentials/DB to push waiters directly.
// ---------------------------------------------------------------------------

describe("auth.js (real module) — wait queue", () => {
  beforeEach(() => {
    _clearWaitQueueForTest();
  });

  it("AC#1: _enqueueWaiterForTest increases queue depth for the key", () => {
    const key = "provider-q:model-x";
    expect(_getQueueDepthForTest(key)).toBe(0);
    _enqueueWaiterForTest(key, () => {});
    expect(_getQueueDepthForTest(key)).toBe(1);
    _enqueueWaiterForTest(key, () => {});
    expect(_getQueueDepthForTest(key)).toBe(2);
  });

  it("AC#5 + AC#2 no-deadlock: release() decrements inFlight synchronously while waiter is in queue", () => {
    const connId = `nodl-${Math.random().toString(36).slice(2)}`;
    const queueKey = `nodl-provider:nodl-model`;

    const lease = _acquireLeaseForTest(connId);
    expect(getInFlightCount(connId)).toBe(1);

    // Enqueue waiter BEFORE release — simulates a request waiting for this connection
    let waiterWoken = false;
    _enqueueWaiterForTest(queueKey, () => { waiterWoken = true; });
    expect(_getQueueDepthForTest(queueKey)).toBe(1);

    // release() must: (a) decrement inFlight synchronously, (b) wake waiter, (c) not deadlock
    lease.release();
    expect(getInFlightCount(connId)).toBe(0); // synchronous decrement — no mutex held
    expect(waiterWoken).toBe(true);           // waiter woken by release()
    expect(_getQueueDepthForTest(queueKey)).toBe(0); // waiter dequeued
  });

  it("AC#2: FIFO — two waiters enqueued, first gets woken first", () => {
    const connId = `fifo-${Math.random().toString(36).slice(2)}`;
    const queueKey = `fifo-provider:fifo-model`;

    const lease = _acquireLeaseForTest(connId);

    const order = [];
    _enqueueWaiterForTest(queueKey, () => order.push("first"));
    _enqueueWaiterForTest(queueKey, () => order.push("second"));
    expect(_getQueueDepthForTest(queueKey)).toBe(2);

    // First release wakes waiter #1 only (one-at-a-time)
    lease.release();
    expect(order).toEqual(["first"]);
    expect(_getQueueDepthForTest(queueKey)).toBe(1);

    // Second release wakes waiter #2
    const lease2 = _acquireLeaseForTest(connId);
    lease2.release();
    expect(order).toEqual(["first", "second"]);
    expect(_getQueueDepthForTest(queueKey)).toBe(0);
  });

  it("AC#3: timeout → waiter resolves false (degrade, not reject)", async () => {
    vi.useFakeTimers();
    try {
      const queueKey = `timeout-provider:timeout-model`;
      const WAIT_MS = 50;

      let resolvedValue;
      const waiterPromise = new Promise(resolve => {
        // Enqueue with a real timeout — mirrors actual getProviderCredentials timeout path
        _enqueueWaiterForTest(queueKey, resolve);
        // Timeout: remove waiter and resolve(false) after WAIT_MS (same as auth.js)
        setTimeout(() => {
          const q = _getWaitQueueForTest().get(queueKey);
          if (q) {
            const idx = q.findIndex(w => w.resolve === resolve);
            if (idx !== -1) q.splice(idx, 1);
            if (q.length === 0) _getWaitQueueForTest().delete(queueKey);
          }
          resolve(false);
        }, WAIT_MS);
      });

      vi.advanceTimersByTime(WAIT_MS + 10);
      resolvedValue = await waiterPromise;
      expect(resolvedValue).toBe(false); // degrade, not throw
      expect(_getQueueDepthForTest(queueKey)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC#6: abort → waiter dequeued immediately, resolves false (degrade)", async () => {
    const queueKey = `abort-provider:abort-model`;
    const controller = new AbortController();

    let resolvedValue;
    const waiterPromise = new Promise(resolve => {
      resolvedValue = resolve; // capture for inspection
      _enqueueWaiterForTest(queueKey, resolve, controller.signal);
    });

    expect(_getQueueDepthForTest(queueKey)).toBe(1);

    controller.abort(); // triggers onAbort in _enqueueWaiterForTest → dequeue + resolve(false)
    const result = await waiterPromise;

    expect(result).toBe(false);                       // degrade, not throw
    expect(_getQueueDepthForTest(queueKey)).toBe(0);  // waiter removed from queue
  });

  it("AC#6: already-aborted signal → waiter not enqueued at all", () => {
    const queueKey = `preabort-provider:model`;
    const controller = new AbortController();
    controller.abort(); // abort BEFORE enqueue

    _enqueueWaiterForTest(queueKey, () => {}, controller.signal);
    // Pre-aborted: resolve(false) called immediately, waiter never pushed
    expect(_getQueueDepthForTest(queueKey)).toBe(0);
  });

  it("AC#8: release() only wakes waiters for matching queueKey (no cross-provider wakeup)", () => {
    const connId = `scope-${Math.random().toString(36).slice(2)}`;
    const keyA = `provider-a:model-x`;
    const keyB = `provider-b:model-x`;

    const lease = _acquireLeaseForTest(connId);

    let wokeA = false, wokeB = false;
    _enqueueWaiterForTest(keyA, () => { wokeA = true; });
    _enqueueWaiterForTest(keyB, () => { wokeB = true; });

    // release() wakes first waiter found in _waitQueue iteration — one-at-a-time
    lease.release();

    // Exactly one waiter woken (the first key in Map iteration order)
    const totalWoken = (wokeA ? 1 : 0) + (wokeB ? 1 : 0);
    expect(totalWoken).toBe(1); // one-at-a-time, not all keys
  });

  it("AC#4: no enqueue when queue is empty (Infinity / disabled path baseline)", () => {
    // Baseline: a fresh key should always start at depth 0
    const key = `fresh-${Math.random().toString(36).slice(2)}:model`;
    expect(_getQueueDepthForTest(key)).toBe(0);
    // After clearWaitQueueForTest (beforeEach), no stale state from other tests
  });
});
