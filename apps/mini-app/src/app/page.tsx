import { UserRole } from '@repo/shared-types';

export default function HomePage() {
  return (
    <main className="p-4 flex flex-col items-center justify-center min-h-[80vh] text-center">
      <h1 className="text-2xl font-bold mb-2">9Router Telegram Store</h1>
      <p className="text-neutral-400 text-sm mb-4">
        Default role target: <span className="font-mono text-emerald-400">{UserRole.CUSTOMER}</span>
      </p>
      <div className="w-full max-w-sm rounded-xl bg-neutral-900 border border-neutral-800 p-4">
        <p className="text-neutral-300 text-sm">Mini App Skeleton Ready</p>
      </div>
    </main>
  );
}
