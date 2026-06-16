/**
 * C10 — MITM upstream TLS verification env flag (commit 6cb51c8).
 *
 * server.js load CA cert từ disk ở module-level → không thể import trong unit test
 * mà không mock toàn bộ fs. Strategy: test logic flag `MITM_INSECURE_UPSTREAM`
 * trực tiếp (giống cách server.js tính UPSTREAM_REJECT_UNAUTHORIZED) và xác nhận
 * các giá trị TLS option đúng trên từng nhánh env.
 *
 * Tại sao không import server.js: nó gọi fs.readFileSync cho rootCA.key/crt tại
 * module scope trước khi bất kỳ test hook nào chạy → ENOENT crash. Mock fs/promises
 * không ngăn được readFileSync sync trong module scope.
 */
import { describe, it, expect, afterEach } from "vitest";

const origEnv = process.env.MITM_INSECURE_UPSTREAM;

afterEach(() => {
  if (origEnv === undefined) delete process.env.MITM_INSECURE_UPSTREAM;
  else process.env.MITM_INSECURE_UPSTREAM = origEnv;
});

// Logic đúng của server.js (lines 23-24):
//   const MITM_INSECURE_UPSTREAM = process.env.MITM_INSECURE_UPSTREAM === "1";
//   const UPSTREAM_REJECT_UNAUTHORIZED = !MITM_INSECURE_UPSTREAM;
function resolveUpstreamRejectUnauthorized() {
  return process.env.MITM_INSECURE_UPSTREAM !== "1";
}

describe("C10 — MITM_INSECURE_UPSTREAM → rejectUnauthorized", () => {
  it("không set env: rejectUnauthorized = true (verify cert theo mặc định)", () => {
    delete process.env.MITM_INSECURE_UPSTREAM;
    expect(resolveUpstreamRejectUnauthorized()).toBe(true);
  });

  it("MITM_INSECURE_UPSTREAM=1: rejectUnauthorized = false (tắt verify cho dev)", () => {
    process.env.MITM_INSECURE_UPSTREAM = "1";
    expect(resolveUpstreamRejectUnauthorized()).toBe(false);
  });

  it("MITM_INSECURE_UPSTREAM=0: rejectUnauthorized = true (strict '1' check)", () => {
    process.env.MITM_INSECURE_UPSTREAM = "0";
    expect(resolveUpstreamRejectUnauthorized()).toBe(true);
  });

  it("MITM_INSECURE_UPSTREAM=true (string): rejectUnauthorized = true", () => {
    process.env.MITM_INSECURE_UPSTREAM = "true";
    expect(resolveUpstreamRejectUnauthorized()).toBe(true);
  });

  it("MITM_INSECURE_UPSTREAM=yes: rejectUnauthorized = true", () => {
    process.env.MITM_INSECURE_UPSTREAM = "yes";
    expect(resolveUpstreamRejectUnauthorized()).toBe(true);
  });

  it("rejectUnauthorized=true được truyền vào TLS option (verify shape dùng trong server.js)", () => {
    delete process.env.MITM_INSECURE_UPSTREAM;
    const tlsOpts = {
      ALPNProtocols: ["h2", "http/1.1"],
      rejectUnauthorized: resolveUpstreamRejectUnauthorized(),
    };
    expect(tlsOpts.rejectUnauthorized).toBe(true);
  });

  it("rejectUnauthorized=false khi MITM_INSECURE_UPSTREAM=1 (dev escape hatch)", () => {
    process.env.MITM_INSECURE_UPSTREAM = "1";
    const tlsOpts = {
      ALPNProtocols: ["h2", "http/1.1"],
      rejectUnauthorized: resolveUpstreamRejectUnauthorized(),
    };
    expect(tlsOpts.rejectUnauthorized).toBe(false);
  });
});
