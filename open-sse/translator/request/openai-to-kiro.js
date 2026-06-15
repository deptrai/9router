/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { v4 as uuidv4 } from "uuid";
import {
  resolveKiroModel,
  isThinkingEnabled,
  buildThinkingSystemPrefix,
  KIRO_AGENTIC_SYSTEM_PROMPT
} from "../../config/kiroConstants.js";

/**
 * Convert OpenAI messages to Kiro format
 * Rules: system/tool/user -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model) {
  let history = [];
  let currentMessage = null;
  
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  // Image support is pre-filtered by caps in translateRequest before reaching here
  const supportsImages = true;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "continue";
      const userMsg = {
        userInputMessage: {
          content: content,
          modelId: ""
        }
      };

      // Attach images if present (Kiro API supports images field)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults
        };
      }
      
      // Add tools to first user message
      if (tools && tools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map(t => {
          const name = t.function?.name || t.name;
          let description = t.function?.description || t.description || "";
          
          if (!description.trim()) {
            description = `Tool: ${name}`;
          }
          
          const schema = t.function?.parameters || t.parameters || t.input_schema || {};
          // Normalize schema: Kiro requires required[] and proper type/properties
          const normalizedSchema = Object.keys(schema).length === 0
            ? { type: "object", properties: {}, required: [] }
            : { ...schema, required: schema.required ?? [] };

          return {
            toolSpecification: {
              name,
              description,
              inputSchema: { json: normalizedSchema }
            }
          };
        });
      }
      
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "...";
      const assistantMsg = {
        assistantResponseMessage: {
          content: content
        }
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role;
    
    // Normalize: system/tool -> user
    if (role === "system" || role === "tool") {
      role = "user";
    }
    
    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;
    
    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const c of msg.content) {
          if (c.type === "text" || c.text) {
            textParts.push(c.text || "");
          } else if (supportsImages && c.type === "image_url") {
            // OpenAI format: image_url.url with data URI
            const url = c.image_url?.url || "";
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              const mediaType = base64Match[1];
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: base64Match[2] } });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              // Kiro only supports base64 — fallback to URL text
              textParts.push(`[Image: ${url}]`);
            }
          } else if (supportsImages && c.type === "image") {
            // Claude format: source.type = "base64", source.media_type, source.data
            if (c.source?.type === "base64" && c.source?.data) {
              const mediaType = c.source.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: c.source.data } });
            }
          }
        }
        content = textParts.join("\n");
        
        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter(c => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach(block => {
            const text = Array.isArray(block.content) 
              ? block.content.map(c => c.text || "").join("\n")
              : (typeof block.content === "string" ? block.content : "");
            
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: "success",
              content: [{ text: text }]
            });
          });
        }
      }
      
      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        const toolContent = typeof msg.content === "string" ? msg.content : "";
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: "success",
          content: [{ text: toolContent }]
        });
      } else if (content) {
        pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];
      
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c.type === "text");
        textContent = textBlocks.map(b => b.text).join("\n").trim();
        
        const toolUseBlocks = msg.content.filter(c => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }
      
      if (textContent) {
        pendingAssistantContent.push(textContent);
      }
      
      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }
        
        // Flush to create assistant message with toolUses
        flushPending();
        
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses.map(tc => {
            if (tc.function) {
              // arguments may be partial/invalid JSON when a previous stream was
              // cut off mid tool-call (vuz/kiro truncation). A raw JSON.parse here
              // would throw and crash the ENTIRE request translation, so the next
              // "continue" turn keeps failing until the conversation is compacted
              // or restarted. Parse defensively: fall back to {} on malformed JSON
              // so the turn still converts and the request reaches kiro.
              let input = {};
              const args = tc.function.arguments;
              if (typeof args === "string") {
                try {
                  input = args.trim() ? JSON.parse(args) : {};
                } catch {
                  input = {};
                }
              } else if (args && typeof args === "object") {
                input = args;
              }
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.function.name,
                input
              };
            } else {
              return {
                toolUseId: tc.id || uuidv4(),
                name: tc.name,
                input: tc.input || {}
              };
            }
          });
        }
        
        currentRole = null;
      }
    }
  }
  
  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }
  
  // Pop last userInputMessage as currentMessage (search from end, skip trailing assistant messages)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  // Grab tools from first history item BEFORE cleanup removes them
  const firstHistoryTools = history[0]?.userInputMessage?.userInputMessageContext?.tools;

  // Clean up history for Kiro API compatibility
  history.forEach(item => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (item.userInputMessage?.userInputMessageContext &&
        Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  });

  // Merge consecutive same-role messages (Kiro requires strictly alternating
  // user/assistant). Two consecutive assistant messages can appear when a stream
  // was cut off mid-turn (the truncated assistant turn + the model's retry turn),
  // which Kiro rejects. Merge their content and combine toolUses so the history
  // stays alternating.
  const mergedHistory = [];
  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    const prev = mergedHistory[mergedHistory.length - 1];
    if (current.userInputMessage && prev?.userInputMessage) {
      prev.userInputMessage.content += "\n\n" + current.userInputMessage.content;
    } else if (current.assistantResponseMessage && prev?.assistantResponseMessage) {
      const prevMsg = prev.assistantResponseMessage;
      const curMsg = current.assistantResponseMessage;
      const prevContent = prevMsg.content || "";
      const curContent = curMsg.content || "";
      // Avoid stacking the "..." placeholder when one side has real content.
      if (curContent && curContent !== "...") {
        prevMsg.content = prevContent && prevContent !== "..."
          ? prevContent + "\n\n" + curContent
          : curContent;
      }
      if (curMsg.toolUses?.length) {
        // Dedup by toolUseId when combining: a truncated turn + its retry can
        // re-emit the SAME tool call, and sending duplicate toolUseIds in one
        // assistantResponseMessage makes Kiro execute it twice or reject the
        // message. Keep the first occurrence (the earlier/prev side wins).
        const seen = new Set((prevMsg.toolUses || []).map(t => t.toolUseId).filter(Boolean));
        const merged = [...(prevMsg.toolUses || [])];
        for (const tu of curMsg.toolUses) {
          if (tu.toolUseId && seen.has(tu.toolUseId)) continue;
          if (tu.toolUseId) seen.add(tu.toolUseId);
          merged.push(tu);
        }
        prevMsg.toolUses = merged;
      }
    } else {
      mergedHistory.push(current);
    }
  }

  // Inject tools into currentMessage AFTER cleanup
  if (firstHistoryTools && currentMessage?.userInputMessage &&
      !currentMessage.userInputMessage.userInputMessageContext?.tools) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = firstHistoryTools;
  }

  return { history: mergedHistory, currentMessage };
}

/**
 * Resolve the forced-tool directive from OpenAI/Claude tool_choice.
 *
 * Kiro/AWS CodeWhisperer protocol has no native field to force a specific tool call.
 * Workaround: inject a plain-text directive into the user message content.
 * Verified live (2026-06-06): both Sonnet 4.6 and Haiku 4.5 honour the directive.
 *
 * @param {*} toolChoice - body.tool_choice (OpenAI or Claude shape)
 * @param {Array} tools  - body.tools array (OpenAI function schema)
 * @returns {{ mode: "named"|"required"|"none", name?: string }}
 */
function resolveForcedTool(toolChoice, tools) {
  if (!toolChoice) return { mode: "none" };

  const toolList = Array.isArray(tools) ? tools : [];

  // OpenAI: "required" / "auto" / "none"
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return toolList.length > 0 ? { mode: "required" } : { mode: "none" };
    return { mode: "none" }; // "auto" / "none"
  }

  if (typeof toolChoice !== "object") return { mode: "none" };

  // Claude shape: { type: "any" } or { type: "auto" }
  if (toolChoice.type === "any") return toolList.length > 0 ? { mode: "required" } : { mode: "none" };
  if (toolChoice.type === "auto") return { mode: "none" };

  // Claude shape: { type: "tool", name: "X" }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return _validateNamedTool(toolChoice.name, tools);
  }

  // OpenAI shape: { type: "function", function: { name: "X" } }
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return _validateNamedTool(toolChoice.function.name, tools);
  }

  return { mode: "none" };
}

function _validateNamedTool(name, tools) {
  if (!name) return { mode: "none" };
  const toolList = Array.isArray(tools) ? tools : [];
  const exists = toolList.some(t => (t.function?.name || t.name) === name);
  if (exists) return { mode: "named", name };
  // Tool not in declared list — downgrade to required (if any tools) or no-op
  if (toolList.length > 0) return { mode: "required" };
  return { mode: "none" };
}

/**
 * Build the forced-tool directive text to append to finalContent.
 * Returns empty string when no directive is needed (mode === "none").
 */
function buildToolChoiceDirective(forced) {
  if (forced.mode === "named") {
    return `\n\n[TOOL DIRECTIVE] You MUST now call the tool \`${forced.name}\`. Do not call any other tool. Do not reply with plain text.`;
  }
  if (forced.mode === "required") {
    return `\n\n[TOOL DIRECTIVE] You MUST call one of the available tools now. Do not reply with plain text.`;
  }
  return "";
}

/**
 * Build Kiro payload from OpenAI format
 *
 * Three 9router-specific behaviours implemented here:
 *
 * 1. `-agentic` model suffix. Synthetic variant — same upstream model, but we
 *    inject a chunked-write system prompt to keep large file writes under
 *    Kiro's 2-3 minute server timeout. The suffix is stripped before being
 *    sent upstream.
 *
 * 2. Thinking / reasoning. Kiro does not accept `thinking.type` or
 *    `reasoning_effort` natively. The only way to enable reasoning is to
 *    inject `<thinking_mode>enabled</thinking_mode>` into the user content
 *    sent upstream. Detection covers Anthropic-Beta header, Claude API
 *    `thinking`, OpenAI `reasoning_effort`, AMP/Cursor magic tags, and model
 *    name hints.
 *
 * 3. tool_choice enforcement. Kiro protocol has no native field to force a
 *    specific tool call. When the client sends tool_choice (named or required),
 *    we inject a plain-text directive at the end of finalContent so the model
 *    is explicitly instructed to call the right tool — verified live on Sonnet 4.6
 *    and Haiku 4.5. No-op when tool_choice is absent / "auto" / "none".
 */
export function buildKiroPayload(model, body, stream, credentials) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  // Forward client's max_tokens, capped at 32000 (Kiro upstream limit).
  // Previously hardcoded 32000 — client had no control over output length.
  const KIRO_MAX_TOKENS = 32000;
  const maxTokens = body.max_tokens ? Math.min(body.max_tokens, KIRO_MAX_TOKENS) : KIRO_MAX_TOKENS;
  const temperature = body.temperature;
  const topP = body.top_p;

  const { upstream: upstreamModel, agentic, thinking: modelImpliesThinking } = resolveKiroModel(model);
  const thinkingEnabled = modelImpliesThinking || isThinkingEnabled(body, null, model);

  const { history, currentMessage } = convertMessages(messages, tools, upstreamModel);

  const profileArn = credentials?.providerSpecificData?.profileArn || "";

  let finalContent = currentMessage?.userInputMessage?.content || "";
  const timestamp = new Date().toISOString();

  // Build the system-prompt prefix that goes ABOVE the user message body.
  // Order: thinking_mode tag first (so Kiro sees it before any user text),
  // then context/timestamp marker, then optional agentic chunked-write prompt.
  const prefixParts = [];
  if (thinkingEnabled) {
    prefixParts.push(buildThinkingSystemPrefix());
  }
  prefixParts.push(`[Context: Current time is ${timestamp}]`);
  if (agentic) {
    prefixParts.push(KIRO_AGENTIC_SYSTEM_PROMPT);
  }
  finalContent = `${prefixParts.join("\n\n")}\n\n${finalContent}`;

  // Enforce tool_choice via prompt injection (Kiro protocol has no native field).
  // Appended AFTER all other prefixes so the model sees it as the last instruction.
  const forced = resolveForcedTool(body.tool_choice, tools);
  finalContent += buildToolChoiceDirective(forced);

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: upstreamModel,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.images?.length > 0 && {
            images: currentMessage.userInputMessage.images
          }),
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext
          })
        }
      },
      history: history
    }
  };

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  // Tag payload so the executor can route the upstream model id correctly.
  Object.defineProperty(payload, "_kiroUpstreamModel", {
    value: upstreamModel,
    enumerable: false
  });

  return payload;
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null);
