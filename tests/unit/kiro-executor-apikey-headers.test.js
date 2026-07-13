/**
 * Unit tests for KiroExecutor API-key specific behavior
 *
 * Covers:
 *  - buildHeaders sets tokentype=API_KEY and Authorization for api_key creds
 *  - OAuth/IDC creds keep normal bearer header and EXTERNAL_IDP header
 *  - getOrderedBaseUrls prioritizes *.amazonaws.com for api_key creds
 *  - Non-api-key creds keep original baseUrl order
 */
import { describe, it, expect, beforeEach } from "vitest";
import { KiroExecutor } from "open-sse/executors/kiro.js";

describe("KiroExecutor API-key header behavior", () => {
  let executor;

  beforeEach(() => {
    executor = new KiroExecutor();
  });

  it("buildHeaders uses tokentype=API_KEY for api_key credentials", () => {
    const credentials = {
      accessToken: "ksk_abc123",
      providerSpecificData: { authMethod: "api_key" },
    };

    const headers = executor.buildHeaders(credentials, true);

    expect(headers.Authorization).toBe("Bearer ksk_abc123");
    expect(headers.tokentype).toBe("API_KEY");
  });

  it("buildHeaders uses accessToken bearer for OAuth credentials", () => {
    const credentials = {
      accessToken: "oauth_at",
      providerSpecificData: { authMethod: "oauth" },
    };

    const headers = executor.buildHeaders(credentials, true);

    expect(headers.Authorization).toBe("Bearer oauth_at");
    expect(headers.tokentype).toBeUndefined();
  });

  it("buildHeaders adds TokenType=EXTERNAL_IDP for external_idp auth", () => {
    const credentials = {
      accessToken: "ext_at",
      providerSpecificData: { authMethod: "external_idp" },
    };

    const headers = executor.buildHeaders(credentials, true);

    expect(headers.Authorization).toBe("Bearer ext_at");
    expect(headers.TokenType).toBe("EXTERNAL_IDP");
    expect(headers.tokentype).toBeUndefined();
  });

  it("getOrderedBaseUrls prioritizes amazonaws.com for api_key", () => {
    const credentials = {
      providerSpecificData: { authMethod: "api_key" },
    };

    const urls = executor.getOrderedBaseUrls(credentials);

    expect(urls[0]).toContain("amazonaws.com");
    expect(urls.length).toBe(executor.getBaseUrls().length);
  });

  it("getOrderedBaseUrls keeps original order for OAuth", () => {
    const credentials = {
      providerSpecificData: { authMethod: "oauth" },
    };

    const urls = executor.getOrderedBaseUrls(credentials);
    const originalUrls = executor.getBaseUrls();

    expect(urls).toEqual(originalUrls);
  });
});
