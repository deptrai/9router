"use client";
import { useState } from "react";

const FAQ_ITEMS = [
  {
    q: "What is 9Router?",
    a: "9Router is a unified AI gateway that lets you access all major AI providers (Anthropic, OpenAI, Google, xAI, and more) through a single OpenAI-compatible endpoint. Manage API keys, monitor usage, and switch models without changing your code.",
  },
  {
    q: "Which AI models are supported?",
    a: "9Router supports 50+ models across Anthropic (Claude), OpenAI (GPT, o-series), Google (Gemini), xAI (Grok), and others. View the full list on our Models page.",
  },
  {
    q: "How does credit-based pricing work?",
    a: "You top up credits once and use them to pay for AI model usage at published token rates. Credits never expire. There are no monthly commitments — pay only for what you use.",
  },
  {
    q: "Is the API compatible with my existing code?",
    a: "Yes. 9Router exposes a fully OpenAI-compatible endpoint at /v1/chat/completions and an Anthropic-compatible endpoint at /api/v1beta/messages. Most existing SDKs and tools work with zero changes — just swap the base URL.",
  },
  {
    q: "How do I get started?",
    a: "Register for a free account, get your API key from the dashboard, and point your existing OpenAI or Anthropic SDK to 9Router's endpoint. The free plan includes generous token quotas to get started.",
  },
  {
    q: "What happens when I run out of credits?",
    a: "If you have an active plan, the overflow toggle allows continued usage billed directly from your credit balance. Otherwise, requests are paused until you top up. You can enable or disable overflow at any time from your dashboard.",
  },
];

function FAQItem({ q, a, isOpen, onToggle }) {
  return (
    <div className="border-b border-[#3a2f27] last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-4 py-5 text-left text-white font-medium hover:text-[#f97815] transition-colors"
      >
        <span>{q}</span>
        <span className={`flex-shrink-0 transition-transform duration-200 ${isOpen ? "rotate-45" : ""}`}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-5 text-[#f97815]">
            <path fillRule="evenodd" d="M12 3.75a.75.75 0 01.75.75v6.75h6.75a.75.75 0 010 1.5h-6.75v6.75a.75.75 0 01-1.5 0v-6.75H4.5a.75.75 0 010-1.5h6.75V4.5a.75.75 0 01.75-.75z" clipRule="evenodd" />
          </svg>
        </span>
      </button>
      {isOpen && (
        <div className="pb-5 text-gray-400 text-sm leading-relaxed">{a}</div>
      )}
    </div>
  );
}

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <section id="faq" className="relative py-24 px-6">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Frequently asked questions</h2>
          <p className="text-gray-400">Everything you need to know about 9Router.</p>
        </div>
        <div className="rounded-2xl border border-[#3a2f27] bg-[#1a1410] px-6">
          {FAQ_ITEMS.map((item, i) => (
            <FAQItem
              key={i}
              q={item.q}
              a={item.a}
              isOpen={openIndex === i}
              onToggle={() => setOpenIndex(openIndex === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
