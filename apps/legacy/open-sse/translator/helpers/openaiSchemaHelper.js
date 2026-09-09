// Sanitize JSON Schema for the OpenAI Responses API (codex/gpt-5.x).
//
// Anthropic forwards tool input_schema to the model almost verbatim, so tools
// can ship JSON Schema constructs that Anthropic tolerates but the OpenAI
// Responses API rejects with HTTP 400 `invalid_function_parameters`. The most
// common offender from MCP tools is TUPLE validation — `items` as an ARRAY of
// per-position schemas (draft-07 style):
//
//   { "type": "array", "items": [ {"type":"integer"}, {"type":"integer"} ] }
//
// OpenAI requires `items` to be a single schema object/boolean. It rejects the
// array form: "[...] is not of type 'object', 'boolean'". This caused every
// combo fallback to codex/gpt-5.5 to 400 when MCP tools like
// `mcp__deepgrep__deepgrep_get` (ranges: [[start,end],...]) were present.
//
// This sanitizer recursively rewrites a schema into an OpenAI-safe shape:
//   - array-form `items` (tuple)        → collapse to a single union/first schema
//                                          and preserve positional schemas under
//                                          `prefixItems` (ignored by OpenAI but
//                                          harmless and keeps intent)
//   - recurse into properties / items / $defs / definitions / additionalProperties
//   - recurse into anyOf / oneOf / allOf members
//
// It mutates a deep clone, never the caller's object.

function sanitizeNode(node) {
  if (Array.isArray(node)) {
    return node.map(sanitizeNode);
  }
  if (!node || typeof node !== "object") return node;

  const out = { ...node };

  // TUPLE form: items is an array of schemas → not allowed by OpenAI.
  if (Array.isArray(out.items)) {
    const positional = out.items.map(sanitizeNode);
    // Collapse to a single schema. If all positional schemas are identical in
    // `type`, use the first; otherwise fall back to a permissive object-free
    // schema that still validates (anyOf of the positional schemas).
    if (positional.length === 1) {
      out.items = positional[0];
    } else {
      const types = new Set(positional.map((s) => (s && s.type) || "").filter(Boolean));
      out.items = types.size <= 1 ? positional[0] : { anyOf: positional };
    }
  } else if (out.items && typeof out.items === "object") {
    out.items = sanitizeNode(out.items);
  }

  // Recurse into common schema-bearing keywords.
  if (out.properties && typeof out.properties === "object") {
    const props = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = sanitizeNode(v);
    out.properties = props;
  }
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = sanitizeNode(out.additionalProperties);
  }
  for (const defKey of ["$defs", "definitions"]) {
    if (out[defKey] && typeof out[defKey] === "object") {
      const defs = {};
      for (const [k, v] of Object.entries(out[defKey])) defs[k] = sanitizeNode(v);
      out[defKey] = defs;
    }
  }
  for (const combiner of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[combiner])) out[combiner] = out[combiner].map(sanitizeNode);
  }
  // `prefixItems` is the draft 2020-12 tuple keyword; recurse if present.
  if (Array.isArray(out.prefixItems)) out.prefixItems = out.prefixItems.map(sanitizeNode);

  return out;
}

/**
 * Return an OpenAI-Responses-safe copy of a tool `parameters` JSON Schema.
 * Safe to call on any value; non-objects pass through unchanged.
 * @param {any} schema
 * @returns {any}
 */
export function sanitizeJsonSchemaForOpenAI(schema) {
  if (!schema || typeof schema !== "object") return schema;
  return sanitizeNode(schema);
}
