import { UserRole } from '@repo/shared-types';

export default function AdminHomePage() {
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold mb-4">9Router Admin Portal</h1>
      <p className="text-slate-400 text-sm mb-6">
        Required clearance: <span className="font-mono text-amber-400">{UserRole.ADMIN}</span>
      </p>
      <div className="rounded-xl bg-slate-900 border border-slate-800 p-6">
        <h2 className="text-lg font-semibold mb-2">System Overview</h2>
        <p className="text-slate-400 text-sm">Admin Dashboard Skeleton Ready</p>
      </div>
    </main>
  );
}
