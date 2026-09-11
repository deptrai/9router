'use client';

export default function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 text-sm">🔍</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tìm sản phẩm..."
        className="w-full h-11 rounded-xl bg-neutral-900 border border-neutral-800 pl-9 pr-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600"
      />
    </div>
  );
}
