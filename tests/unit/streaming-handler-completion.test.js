import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  appendRequestLog: vi.fn(() => Promise.resolve()),
}));

import { saveRequestDetail } from "@/lib/usageDb.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";

function makeOnStreamComplete() {
  return buildOnStreamComplete({
    provider: "codex",
    model: "gpt-5.5",
    connectionId: "conn-1",
    requestStartTime: Date.now() - 100,
    body: { model: "gpt-5.5", messages: [] },
    stream: true,
    finalBody: { input: [] },
    translatedBody: null,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
  }).onStreamComplete;
}

describe("buildOnStreamComplete — recorded streaming content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records thinking-only streams instead of marking them empty", () => {
    const onStreamComplete = makeOnStreamComplete();

    onStreamComplete({ content: "", thinking: "checking files" }, null, Date.now());

    expect(saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.providerResponse).toContain("[Thinking-only streaming response]");
    expect(detail.providerResponse).toContain("checking files");
    expect(detail.response.content).toContain("checking files");
    expect(detail.response.thinking).toBe("checking files");
  });

  it("keeps visible content as the primary recorded response when thinking also exists", () => {
    const onStreamComplete = makeOnStreamComplete();

    onStreamComplete({ content: "visible answer", thinking: "private scratch" }, null, Date.now());

    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.providerResponse).toBe("visible answer");
    expect(detail.response.content).toBe("visible answer");
    expect(detail.response.thinking).toBe("private scratch");
  });

  it("still marks truly empty streams with the explicit empty marker", () => {
    const onStreamComplete = makeOnStreamComplete();

    onStreamComplete({ content: "", thinking: "" }, null, Date.now());

    const detail = saveRequestDetail.mock.calls[0][0];
    expect(detail.providerResponse).toBe("[Empty streaming response]");
    expect(detail.response.content).toBe("[Empty streaming response]");
    expect(detail.response.thinking).toBeNull();
  });
});
