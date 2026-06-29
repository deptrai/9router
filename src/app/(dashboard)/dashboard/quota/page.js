import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import ConnectionUsage from "../usage/components/ConnectionUsage";

export default function QuotaPage() {
  return (
    <div className="space-y-8">
      <Suspense fallback={<CardSkeleton />}>
        <ProviderLimits />
      </Suspense>

      <div>
        <h2 className="text-lg font-semibold text-text-main mb-4">
          Per-Account Usage
        </h2>
        <ConnectionUsage />
      </div>
    </div>
  );
}
