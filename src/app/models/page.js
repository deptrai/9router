import { getPricing } from "@/lib/db/repos/pricingRepo";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supported Models — 9Router", description: "All AI models supported by 9Router with token pricing." };

function formatPrice(v) {
  if (!v || v === 0) return "—";
  return `$${Number(v).toFixed(2)}`;
}

export default async function ModelsPage() {
  const pricing = await getPricing();

  const grouped = {};
  for (const [provider, models] of Object.entries(pricing)) {
    grouped[provider] = Object.entries(models).map(([model, p]) => ({
      model,
      input: p.input ?? 0,
      output: p.output ?? 0,
      cached: p.cached ?? 0,
      reasoning: p.reasoning ?? 0,
    }));
  }

  const providers = Object.keys(grouped).sort();

  return (
    <div className="min-h-screen bg-[#181411] text-white font-sans px-4 py-10">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8 flex items-center gap-4">
          <Link href="/" className="text-[#f97815] hover:underline text-sm">← Back to 9Router</Link>
        </div>

        <h1 className="text-3xl font-bold mb-2">Supported Models</h1>
        <p className="text-gray-400 mb-8">All models available via 9Router. Prices shown in USD per 1M tokens.</p>

        {providers.map((provider) => (
          <div key={provider} className="mb-10">
            <h2 className="text-lg font-semibold text-[#f97815] mb-3 capitalize">{provider}</h2>
            <div className="overflow-x-auto rounded-lg border border-[#3a2f27]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#241c16] text-gray-400 text-left">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium text-right">Input</th>
                    <th className="px-4 py-3 font-medium text-right">Output</th>
                    <th className="px-4 py-3 font-medium text-right">Cached</th>
                    <th className="px-4 py-3 font-medium text-right">Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[provider].map((row, i) => (
                    <tr key={row.model} className={i % 2 === 0 ? "bg-[#1e1710]" : "bg-[#181411]"}>
                      <td className="px-4 py-2 font-mono text-xs text-gray-200">{row.model}</td>
                      <td className="px-4 py-2 text-right text-gray-300">{formatPrice(row.input)}</td>
                      <td className="px-4 py-2 text-right text-gray-300">{formatPrice(row.output)}</td>
                      <td className="px-4 py-2 text-right text-gray-300">{formatPrice(row.cached)}</td>
                      <td className="px-4 py-2 text-right text-gray-300">{formatPrice(row.reasoning)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <p className="text-xs text-gray-500 mt-8">Prices may vary. Contact support for custom pricing or volume discounts.</p>
      </div>
    </div>
  );
}
