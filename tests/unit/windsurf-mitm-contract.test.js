/**
 * Contract test cho MITM handler Windsurf/Devin CLI (feature `mitm-windsurf-devin-cli`).
 * Følger spec _workspace/01-spec.md lines 219-244 (6 group assertion).
 *
 * Boundary chosen (per spec lines 80-86): 3 pure functions + frame split.
 * intercept() itself is NOT unit-tested here — it binds req/res/fetch (heavy I/O),
 * mocking all of that adds noise without catching real contract violations.
 */
import { describe, it, expect } from "vitest";
import {
  buildGetChatMessageRequest,
  decodeGetChatMessageRequest,
  buildGetChatMessageResponse,
  decodeGetChatMessageResponse,
  splitConnectFrames,
  buildConnectFrame,
  buildUsage,
} from "../../open-sse/utils/windsurfProtobuf.js";
import { translateToAnthropic, resolveModelAlias } from "../../src/mitm/handlers/windsurf.js";

// ─── Group 1: splitConnectFrames roundtrip ─────────────────────────────────
describe("[1] splitConnectFrames — roundtrip", () => {
  it("decodes 2 ghép frames đúng flag + payload", () => {
    const p1 = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const p2 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const combined = Buffer.concat([
      buildConnectFrame(0x00, p1),
      buildConnectFrame(0x02, p2),
    ]);
    const frames = splitConnectFrames(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0].flags).toBe(0x00);
    expect([...frames[0].payload]).toEqual([0xaa, 0xbb, 0xcc]);
    expect(frames[1].flags).toBe(0x02);
    expect([...frames[1].payload]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it("giữ end frame empty payload (success)", () => {
    const endFrame = buildConnectFrame(0x02, new Uint8Array(0));
    const frames = splitConnectFrames(endFrame);
    expect(frames).toHaveLength(1);
    expect(frames[0].flags).toBe(0x02);
    expect(frames[0].payload.length).toBe(0);
  });

  it("bỏ partial trailing frame (không throw)", () => {
    const complete = buildConnectFrame(0x00, new Uint8Array([1, 2]));
    const partial = Buffer.from([0x00, 0x00, 0x00, 0x05]); // claims 5 bytes payload but none
    const frames = splitConnectFrames(Buffer.concat([complete, partial]));
    expect(frames).toHaveLength(1); // only the complete frame
  });
});

// ─── Group 2: decodeGetChatMessageRequest — roundtrip với build ─────────────
describe("[2] decodeGetChatMessageRequest — roundtrip", () => {
  const apiKey = "devin-session-token$testkey";
  const anthropicReq = {
    system: [{ type: "text", text: "System prompt here" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "User says hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Assistant replies" }] },
    ],
    tools: [{ name: "search", description: "search the web", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    max_tokens: 5000,
  };

  it("decode metadata.apiKey đúng", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.metadata?.apiKey).toBe(apiKey);
  });

  it("decode system prompt đúng", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.system).toBe("System prompt here");
  });

  it("decode messages đúng source + prompt", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.messages).toHaveLength(2);
    // user → source USER(1), assistant → source SYSTEM(2) per buildChatMessagePrompt
    expect(decoded.messages[0].source).toBe(1);
    expect(decoded.messages[0].prompt).toBe("User says hi");
    expect(decoded.messages[1].source).toBe(2);
    expect(decoded.messages[1].prompt).toBe("Assistant replies");
  });

  it("decode tools đúng name + inputSchemaStr", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.tools).toHaveLength(1);
    expect(decoded.tools[0].name).toBe("search");
    expect(JSON.parse(decoded.tools[0].inputSchemaStr).properties.q.type).toBe("string");
  });

  it("decode configuration.maxTokens đúng", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.configuration?.maxTokens).toBe(5000);
    expect(decoded.configuration?.maxNewlines).toBe(400);
  });

  it("decode modelUid + requestType + plannerMode đúng", () => {
    const proto = buildGetChatMessageRequest(anthropicReq, apiKey, "claude-sonnet-4-6-thinking");
    const decoded = decodeGetChatMessageRequest(proto);
    expect(decoded.modelUid).toBe("claude-sonnet-4-6-thinking");
    expect(decoded.requestType).toBe(5); // CASCADE
    expect(decoded.plannerMode).toBe(1); // DEFAULT
  });
});

// ─── Group 3: buildGetChatMessageResponse — roundtrip với decode ────────────
describe("[3] buildGetChatMessageResponse — roundtrip", () => {
  it("delta_text roundtrip", () => {
    const proto = buildGetChatMessageResponse({ delta_text: "Hello world!" });
    const decoded = decodeGetChatMessageResponse(proto);
    expect(decoded.delta_text).toBe("Hello world!");
  });

  it("delta_thinking roundtrip", () => {
    const proto = buildGetChatMessageResponse({ delta_thinking: "Reasoning..." });
    const decoded = decodeGetChatMessageResponse(proto);
    expect(decoded.delta_thinking).toBe("Reasoning...");
  });

  it("stop_reason roundtrip", () => {
    const proto = buildGetChatMessageResponse({ stop_reason: 3 });
    const decoded = decodeGetChatMessageResponse(proto);
    expect(decoded.stop_reason).toBe(3);
  });

  it("delta_tool_calls roundtrip", () => {
    const proto = buildGetChatMessageResponse({
      delta_tool_calls: [{ id: "call_abc", name: "search", arguments: '{"q":"test"}' }],
    });
    const decoded = decodeGetChatMessageResponse(proto);
    expect(decoded.delta_tool_calls).toHaveLength(1);
    expect(decoded.delta_tool_calls[0].id).toBe("call_abc");
    expect(decoded.delta_tool_calls[0].name).toBe("search");
    expect(decoded.delta_tool_calls[0].arguments_json).toBe('{"q":"test"}');
  });

  it("usage roundtrip", () => {
    const proto = buildGetChatMessageResponse({
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 25, model_uid: "test-model" },
    });
    const decoded = decodeGetChatMessageResponse(proto);
    expect(decoded.usage.input_tokens).toBe(100);
    expect(decoded.usage.output_tokens).toBe(50);
    expect(decoded.usage.cache_read_tokens).toBe(25);
    expect(decoded.usage.model_uid).toBe("test-model");
  });
});

// ─── Group 4: translateToAnthropic — inverse mapping ─────────────────────────
describe("[4] translateToAnthropic — inverse mapping", () => {
  const buildDecoded = () => ({
    metadata: { apiKey: "devin-session-token$LEAK_ME_NOT" },
    system: "Top-level system",
    messages: [
      { messageId: "u1", source: 1, prompt: "User msg", thinking: null, toolCallId: null, toolCalls: [] },
      { messageId: "a1", source: 2, prompt: "Assistant msg", thinking: "think", toolCallId: null, toolCalls: [{ id: "c1", name: "tool1", arguments_json: '{"x":1}' }] },
      { messageId: "t1", source: 4, prompt: "Tool result", thinking: null, toolCallId: "c1", toolCalls: [] },
      { messageId: "s1", source: 5, prompt: "Hoisted system msg", thinking: null, toolCallId: null, toolCalls: [] },
    ],
    requestType: 5,
    configuration: { numCompletions: 1, maxTokens: 1000, maxNewlines: 400, temperature: 1.0, topK: 40, topP: 0.95 },
    tools: [{ name: "tool1", description: "do thing", inputSchemaStr: '{"type":"object","properties":{"x":{"type":"number"}}}' }],
    cascadeId: "c", plannerMode: 1, modelUid: "claude-sonnet-4-6-thinking", executionId: "e",
  });

  it("strip metadata.apiKey (9router sẽ inject credential rotate)", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    expect(JSON.stringify(body)).not.toContain("LEAK_ME_NOT");
  });

  it("hoist SYSTEM_PROMPT (source=5) vào top-level system", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    expect(body.system).toHaveLength(2);
    expect(body.system[0].text).toBe("Top-level system");
    expect(body.system[1].text).toBe("Hoisted system msg");
  });

  it("map source USER(1)→user, SYSTEM(2)→assistant, TOOL(4)→user(tool_result)", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    expect(body.messages).toHaveLength(3); // s1 hoisted out
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[2].role).toBe("user");
    expect(body.messages[2].content[0].type).toBe("tool_result");
    expect(body.messages[2].content[0].tool_use_id).toBe("c1");
  });

  it("tool_calls → tool_use blocks với input parsed", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    const toolUse = body.messages[1].content.find(b => b.type === "tool_use");
    expect(toolUse).toBeTruthy();
    expect(toolUse.id).toBe("c1");
    expect(toolUse.name).toBe("tool1");
    expect(toolUse.input.x).toBe(1);
  });

  it("thinking → thinking block trong assistant message", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    const thinking = body.messages[1].content.find(b => b.type === "thinking");
    expect(thinking?.thinking).toBe("think");
  });

  it("tools → Anthropic tools với input_schema parsed", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe("tool1");
    expect(body.tools[0].input_schema.properties.x.type).toBe("number");
  });

  it("max_tokens prefers maxTokens over maxNewlines * 400", () => {
    const d = buildDecoded();
    // buildDecoded sets maxTokens=1000, maxNewlines=400 → new logic prefers maxTokens
    const body = translateToAnthropic(d, null);
    expect(body.max_tokens).toBe(1000);
  });

  it("max_tokens falls back to maxNewlines * 400 when maxTokens=0", () => {
    const d = buildDecoded();
    d.configuration.maxTokens = 0;
    d.configuration.maxNewlines = 400; // 400 * 400 = 160000 → cap 128000
    const body = translateToAnthropic(d, null);
    expect(body.max_tokens).toBe(128000);
  });

  it("max_tokens defaults to 128000 when both maxTokens=0 and maxNewlines=0", () => {
    const d = buildDecoded();
    d.configuration.maxTokens = 0;
    d.configuration.maxNewlines = 0;
    const body = translateToAnthropic(d, null);
    expect(body.max_tokens).toBe(128000);
  });

  // P0: sampling params forwarded from decoded configuration
  it("forwards temperature/top_p/top_k when set in configuration", () => {
    const d = buildDecoded();
    d.configuration.temperature = 0.7;
    d.configuration.topP = 0.9;
    d.configuration.topK = 50;
    const body = translateToAnthropic(d, null);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(50);
  });

  it("does not forward temperature/top_p/top_k when zero (uses WindsurfExecutor defaults)", () => {
    const d = buildDecoded();
    d.configuration.temperature = 0;
    d.configuration.topP = 0;
    d.configuration.topK = 0;
    const body = translateToAnthropic(d, null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it("does not forward sampling params when configuration missing", () => {
    const d = buildDecoded();
    d.configuration = null;
    const body = translateToAnthropic(d, null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it("model fallback: mappedModel null → modelUid", () => {
    const body = translateToAnthropic(buildDecoded(), null);
    expect(body.model).toBe("claude-sonnet-4-6-thinking");
  });

  it("model ưu tiên mappedModel khi có", () => {
    const body = translateToAnthropic(buildDecoded(), "ws/sonnet-4.6");
    expect(body.model).toBe("ws/sonnet-4.6");
  });
});

// ─── Group 5: buildUsage — roundtrip với decodeUsage ───────────────────────
describe("[5] buildUsage — roundtrip", () => {
  it("build → decode khớp mọi field", () => {
    const usage = { input_tokens: 42, output_tokens: 17, cache_read_tokens: 8, model_uid: "m1" };
    const proto = buildUsage(usage);
    // decodeUsage is internal (not exported) — verify via buildGetChatMessageResponse roundtrip
    const respProto = buildGetChatMessageResponse({ usage });
    const decoded = decodeGetChatMessageResponse(respProto);
    expect(decoded.usage.input_tokens).toBe(42);
    expect(decoded.usage.output_tokens).toBe(17);
    expect(decoded.usage.cache_read_tokens).toBe(8);
    expect(decoded.usage.model_uid).toBe("m1");
  });

  it("partial usage (chỉ output_tokens) không break", () => {
    const respProto = buildGetChatMessageResponse({ usage: { output_tokens: 99 } });
    const decoded = decodeGetChatMessageResponse(respProto);
    expect(decoded.usage.output_tokens).toBe(99);
    expect(decoded.usage.input_tokens).toBe(0); // default
  });
});

// ─── Group 6: buildConnectFrame — flag parametrization ─────────────────────
describe("[6] buildConnectFrame — flag parametrization", () => {
  it("flag 0x00 (data) + flag 0x02 (end) khác nhau", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const dataFrame = buildConnectFrame(0x00, payload);
    const endFrame = buildConnectFrame(0x02, payload);
    expect(dataFrame[0]).toBe(0x00);
    expect(endFrame[0]).toBe(0x02);
    // body payload phải giống nhau
    expect(dataFrame.subarray(5)).toEqual(endFrame.subarray(5));
  });

  it("length prefix 4-byte BE đúng", () => {
    const payload = new Uint8Array(300); // > 255 để test multi-byte
    const frame = buildConnectFrame(0x00, payload);
    const len = frame.readUInt32BE(1);
    expect(len).toBe(300);
    expect(frame.length).toBe(5 + 300);
  });
});

// ─── Group 7: resolveModelAlias — auto-map + UI override (Option C) ─────────
describe("[7] resolveModelAlias — auto-map + UI override", () => {
  it("auto-map modelUid windsurf → 9router alias (không cần UI config)", () => {
    expect(resolveModelAlias("claude-sonnet-4-6-thinking", null)).toBe("ws/sonnet-4.6");
    expect(resolveModelAlias("claude-opus-4-8-medium", null)).toBe("ws/opus-4.8");
    expect(resolveModelAlias("glm-5-2", null)).toBe("ws/glm-5-2");
    expect(resolveModelAlias("swe-1-6", null)).toBe("ws/swe-1-6");
    expect(resolveModelAlias("MODEL_MINIMAX_M2_1", null)).toBe("ws/minimax-m2.7");
  });

  it("UI string override thắng auto-map", () => {
    expect(resolveModelAlias("claude-sonnet-4-6-thinking", "ws/custom-alias")).toBe("ws/custom-alias");
  });

  it("UI map { modelUid: alias } override theo modelUid cụ thể", () => {
    const uiMap = { "claude-sonnet-4-6-thinking": "ws/alt-sonnet" };
    expect(resolveModelAlias("claude-sonnet-4-6-thinking", uiMap)).toBe("ws/alt-sonnet");
  });

  it("UI map fallback first value khi modelUid không khớp key nào", () => {
    const uiMap = { "other-uid": "ws/alt" };
    expect(resolveModelAlias("claude-sonnet-4-6-thinking", uiMap)).toBe("ws/alt");
  });

  it("modelUid lạ + không UI → null (caller passthrough)", () => {
    expect(resolveModelAlias("unknown-model-xyz", null)).toBeNull();
  });

  it("modelUid lạ + UI string → vẫn dùng UI string", () => {
    expect(resolveModelAlias("unknown-model-xyz", "ws/fallback")).toBe("ws/fallback");
  });

  it("normalize strip suffix '-max-1m' → fallback map (variant 1M context)", () => {
    expect(resolveModelAlias("glm-5-2-max-1m", null)).toBe("ws/glm-5-2");
  });

  it("normalize strip suffix '-max-500k' → fallback map (variant khác)", () => {
    expect(resolveModelAlias("glm-5-2-max-500k", null)).toBe("ws/glm-5-2");
  });

  it("normalize strip suffix '-max' (không có sub-suffix) → fallback map", () => {
    expect(resolveModelAlias("glm-5-2-max", null)).toBe("ws/glm-5-2");
  });

  it("swe-1-6-fast → ws/swe-1-6 (exact match)", () => {
    expect(resolveModelAlias("swe-1-6-fast", null)).toBe("ws/swe-1-6");
  });

  it("normalize strip suffix '-fast' → fallback map (speed variant)", () => {
    expect(resolveModelAlias("claude-sonnet-4-6-thinking-fast", null)).toBe("ws/sonnet-4.6");
  });

  it("modelUid lạ + suffix '-max-*' không có base → null (passthrough)", () => {
    expect(resolveModelAlias("unknown-model-max-1m", null)).toBeNull();
  });
});
