"use client";
import { useRouter } from "next/navigation";
import Navigation from "./components/Navigation";
import HeroSection from "./components/HeroSection";
import FlowAnimation from "./components/FlowAnimation";
import HowItWorks from "./components/HowItWorks";
import Features from "./components/Features";
import GetStarted from "./components/GetStarted";
import Footer from "./components/Footer";
import EndpointHighlights from "./components/EndpointHighlights";
import Pricing from "./components/Pricing";
import FAQ from "./components/FAQ";

export default function LandingPage() {
  const router = useRouter();
  return (
    <div className="relative text-white font-sans overflow-x-hidden antialiased selection:bg-[#f97815] selection:text-white">
      {/* Animated Background */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none bg-[#181411]">
        <div className="absolute inset-0 opacity-[0.06]" style={{
          backgroundImage: `linear-gradient(to right, #f97815 1px, transparent 1px), linear-gradient(to bottom, #f97815 1px, transparent 1px)`,
          backgroundSize: '50px 50px'
        }}></div>
        <div className="absolute top-0 left-1/4 w-[700px] h-[700px] bg-[#f97815]/12 rounded-full blur-[130px] animate-blob"></div>
        <div className="absolute top-1/3 right-1/4 w-[600px] h-[600px] bg-purple-500/10 rounded-full blur-[130px] animate-blob" style={{ animationDelay: '2s', animationDuration: '22s' }}></div>
        <div className="absolute bottom-0 left-1/2 w-[650px] h-[650px] bg-blue-500/8 rounded-full blur-[130px] animate-blob" style={{ animationDelay: '4s', animationDuration: '25s' }}></div>
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 0%, rgba(24, 20, 17, 0.4) 100%)' }}></div>
      </div>

      <div className="relative z-10">
        <Navigation />
        <main>
          <div className="relative">
            <HeroSection />
            <div className="flex justify-center pb-20">
              <FlowAnimation />
            </div>
          </div>

          <GetStarted />
          <HowItWorks />
          <Features />
          <EndpointHighlights />
          <Pricing />
          <FAQ />

          {/* Final CTA + Discord */}
          <section className="py-32 px-6 relative overflow-hidden">
            <div className="absolute inset-0 bg-linear-to-t from-[#f97815]/5 to-transparent pointer-events-none"></div>
            <div className="max-w-4xl mx-auto text-center relative z-10">
              <h2 className="text-4xl md:text-5xl font-black mb-6">Ready to simplify your AI infrastructure?</h2>
              <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                Join developers who are streamlining their AI integrations with 9Router.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <button
                  onClick={() => router.push("/register")}
                  className="w-full sm:w-auto h-14 px-10 rounded-lg bg-[#f97815] hover:bg-[#e0650a] text-[#181411] text-lg font-bold transition-all shadow-[0_0_20px_rgba(249,120,21,0.5)]"
                >
                  Start Free
                </button>
                <a
                  href="https://discord.gg/9router"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto h-14 px-10 rounded-lg border border-[#3a2f27] hover:border-[#f97815] text-white text-lg font-bold transition-all flex items-center justify-center gap-2"
                >
                  <svg className="size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
                  Join Discord
                </a>
              </div>
            </div>
          </section>
        </main>
        <Footer />
      </div>

      <style jsx global>{`
        @keyframes blob {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
        }
        .animate-blob { animation: blob 20s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
