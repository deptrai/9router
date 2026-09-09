export default function EndpointHighlights() {
  const endpoints = [
    {
      badge: "OpenAI-compatible",
      path: "/v1/chat/completions",
      description: "Drop-in replacement for the OpenAI API. Works with any OpenAI SDK or tool.",
      snippet: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://9router.com/v1",
  apiKey: process.env.ROUTER_API_KEY,
});

const res = await client.chat.completions.create({
  model: "claude-opus-4-6",
  messages: [{ role: "user", content: "Hello!" }],
});`,
    },
    {
      badge: "Anthropic-compatible",
      path: "/api/v1beta/messages",
      description: "Native Anthropic Messages API format. Works with the official Anthropic SDK.",
      snippet: `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://9router.com/api/v1beta",
  apiKey: process.env.ROUTER_API_KEY,
});

const res = await client.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});`,
    },
  ];

  return (
    <section id="endpoints" className="relative py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Two APIs, every model</h2>
          <p className="text-gray-400 text-lg">Use the API format you already know. 9Router handles the rest.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {endpoints.map((ep) => (
            <div key={ep.path} className="rounded-2xl border border-[#3a2f27] bg-[#1a1410] p-6 flex flex-col gap-4">
              <div>
                <span className="inline-block text-xs font-bold bg-[#f97815]/15 text-[#f97815] border border-[#f97815]/30 rounded-full px-3 py-1 mb-3">
                  {ep.badge}
                </span>
                <div className="font-mono text-sm text-gray-200 mb-2">{ep.path}</div>
                <p className="text-gray-400 text-sm">{ep.description}</p>
              </div>
              <div className="rounded-lg bg-[#0e0b08] border border-[#3a2f27] p-4 overflow-x-auto">
                <pre className="text-xs text-gray-300 whitespace-pre font-mono leading-relaxed">{ep.snippet}</pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
