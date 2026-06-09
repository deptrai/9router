"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Pricing() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/public/plans")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;

  return (
    <section id="pricing" className="relative py-24 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Simple, credit-based pricing</h2>
          <p className="text-gray-400 text-lg">Top up credits once. Use them across any supported model.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map((plan) => {
            const isFree = plan.priceCredits === 0;
            const isMax = plan.name?.toLowerCase() === "max";
            return (
              <div
                key={plan.id}
                className={`relative rounded-2xl border p-6 flex flex-col gap-4 ${
                  isMax
                    ? "border-[#f97815] bg-[#1e1510] shadow-[0_0_30px_rgba(249,120,21,0.15)]"
                    : "border-[#3a2f27] bg-[#1a1410]"
                }`}
              >
                {isMax && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#f97815] text-[#181411] text-xs font-bold px-3 py-1 rounded-full">
                    Most Popular
                  </div>
                )}
                <div>
                  <h3 className="text-white font-bold text-xl capitalize">{plan.displayName ?? plan.name}</h3>
                  <div className="mt-2 flex items-baseline gap-1">
                    {isFree ? (
                      <span className="text-3xl font-bold text-white">Free</span>
                    ) : (
                      <>
                        <span className="text-3xl font-bold text-white">{plan.priceCredits}</span>
                        <span className="text-gray-400 text-sm">credits / {plan.durationDays}d</span>
                      </>
                    )}
                  </div>
                </div>

                <ul className="flex flex-col gap-2 text-sm text-gray-300 flex-1">
                  {plan.quota5h > 0 && <li className="flex gap-2"><span className="text-[#f97815]">✓</span>{(plan.quota5h / 1000).toFixed(0)}K tokens / 5h</li>}
                  {plan.quotaWeekly > 0 && <li className="flex gap-2"><span className="text-[#f97815]">✓</span>{(plan.quotaWeekly / 1000).toFixed(0)}K tokens / week</li>}
                  {plan.rpm > 0 && <li className="flex gap-2"><span className="text-[#f97815]">✓</span>{plan.rpm} requests / min</li>}
                  <li className="flex gap-2"><span className="text-[#f97815]">✓</span>All supported models</li>
                  <li className="flex gap-2"><span className="text-[#f97815]">✓</span>OpenAI + Anthropic compatible API</li>
                </ul>

                <button
                  onClick={() => router.push("/register")}
                  className={`mt-2 h-10 rounded-lg text-sm font-bold transition-all ${
                    isMax
                      ? "bg-[#f97815] hover:bg-[#e0650a] text-[#181411] shadow-[0_0_15px_rgba(249,120,21,0.4)]"
                      : "border border-[#3a2f27] hover:border-[#f97815] text-white"
                  }`}
                >
                  {isFree ? "Start for Free" : "Get Started"}
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-center text-gray-500 text-sm mt-8">
          Credits never expire. Need more?{" "}
          <a href="/register" className="text-[#f97815] hover:underline">Top up anytime</a>.
        </p>
      </div>
    </section>
  );
}
