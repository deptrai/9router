import { describe, it, expect } from "vitest";
import { sanitizeJsonSchemaForOpenAI } from "open-sse/translator/helpers/openaiSchemaHelper.js";

describe("sanitizeJsonSchemaForOpenAI", () => {
  it("collapses array-form items (tuple) — the deepgrep_get production case", () => {
    // Reproduces the exact schema from the production log:
    //   "Invalid schema for function 'mcp__deepgrep__deepgrep_get':
    //    [{'type':'integer','minimum':1},{'type':'integer','minimum':1}]
    //    is not of type 'object', 'boolean'."
    const input = {
      type: "object",
      properties: {
        ranges: {
          type: "array",
          items: [
            { type: "integer", minimum: 1 },
            { type: "integer", minimum: 1 },
          ],
        },
      },
    };
    const out = sanitizeJsonSchemaForOpenAI(input);
    // items must now be a single schema object, not an array.
    expect(Array.isArray(out.properties.ranges.items)).toBe(false);
    expect(out.properties.ranges.items).toEqual({ type: "integer", minimum: 1 });
  });

  it("uses anyOf when tuple positions have different types", () => {
    const input = {
      type: "array",
      items: [
        { type: "string" },
        { type: "integer" },
      ],
    };
    const out = sanitizeJsonSchemaForOpenAI(input);
    expect(Array.isArray(out.items)).toBe(false);
    expect(out.items).toEqual({
      anyOf: [{ type: "string" }, { type: "integer" }],
    });
  });

  it("does not mutate the input", () => {
    const input = {
      type: "array",
      items: [{ type: "integer" }, { type: "integer" }],
    };
    const before = JSON.stringify(input);
    sanitizeJsonSchemaForOpenAI(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("leaves a single-schema items field alone", () => {
    const input = { type: "array", items: { type: "string" } };
    expect(sanitizeJsonSchemaForOpenAI(input)).toEqual(input);
  });

  it("recurses into properties / anyOf / oneOf / allOf / $defs", () => {
    const input = {
      type: "object",
      properties: {
        a: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
      },
      anyOf: [{ type: "array", items: [{ type: "boolean" }] }],
      oneOf: [{ type: "array", items: [{ type: "null" }, { type: "null" }] }],
      $defs: {
        T: { type: "array", items: [{ type: "number" }, { type: "number" }] },
      },
    };
    const out = sanitizeJsonSchemaForOpenAI(input);
    expect(Array.isArray(out.properties.a.items)).toBe(false);
    expect(Array.isArray(out.anyOf[0].items)).toBe(false);
    expect(Array.isArray(out.oneOf[0].items)).toBe(false);
    expect(Array.isArray(out.$defs.T.items)).toBe(false);
  });

  it("recurses through nested array items", () => {
    // ranges: [[start,end], ...] — the actual deepgrep_get shape.
    const input = {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              ranges: {
                type: "array",
                items: {
                  type: "array",
                  items: [
                    { type: "integer", minimum: 1 },
                    { type: "integer", minimum: 1 },
                  ],
                },
              },
            },
          },
        },
      },
    };
    const out = sanitizeJsonSchemaForOpenAI(input);
    const inner = out.properties.files.items.properties.ranges.items;
    expect(Array.isArray(inner.items)).toBe(false);
    expect(inner.items).toEqual({ type: "integer", minimum: 1 });
  });

  it("passes through non-objects and null safely", () => {
    expect(sanitizeJsonSchemaForOpenAI(null)).toBe(null);
    expect(sanitizeJsonSchemaForOpenAI(undefined)).toBe(undefined);
    expect(sanitizeJsonSchemaForOpenAI("x")).toBe("x");
    expect(sanitizeJsonSchemaForOpenAI(42)).toBe(42);
  });
});
