import { describe, it, expect } from "vitest";
import { escapeHtml } from "@/lib/email/escapeHtml.js";

describe("escapeHtml — email template sanitization (Story 2.6)", () => {
  it("[P0] escapes all HTML special characters: &, <, >, \", '", () => {
    const input = `Hello & <world> "test" 'escaped'`;
    const expected = `Hello &amp; &lt;world&gt; &quot;test&quot; &#39;escaped&#39;`;
    expect(escapeHtml(input)).toBe(expected);
  });

  it("[P0] preserves safe alphanumeric text and punctuation", () => {
    const input = "User Name 123 (Welcome to Mmomarket!) - No markup.";
    expect(escapeHtml(input)).toBe(input);
  });

  it("[P1] handles null and undefined by returning empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("[P1] handles numbers and boolean values", () => {
    expect(escapeHtml(12345)).toBe("12345");
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml(true)).toBe("true");
    expect(escapeHtml(false)).toBe("false");
  });

  it("[P2] prevents malicious script and attribute injection payloads", () => {
    const xssPayload = `<script>alert("XSS")</script>`;
    expect(escapeHtml(xssPayload)).toBe("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");

    const imgPayload = `<img src=x onerror='alert(1)'>`;
    expect(escapeHtml(imgPayload)).toBe("&lt;img src=x onerror=&#39;alert(1)&#39;&gt;");
  });
});
