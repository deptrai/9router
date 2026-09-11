'use client';

export default function CategoryFilter({
  categories,
  selected,
  onChange,
}: {
  categories: string[];
  selected: string | null;
  onChange: (c: string | null) => void;
}) {
  const pill = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className={`h-11 px-4 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
        active ? 'bg-blue-600 text-white' : 'bg-neutral-900 text-neutral-300 border border-neutral-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
      {pill('Tất cả', selected === null, () => {
        window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
        onChange(null);
      })}
      {categories.map((c) =>
        pill(c, selected === c, () => {
          window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
          onChange(c);
        }),
      )}
    </div>
  );
}
