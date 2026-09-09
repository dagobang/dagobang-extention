type ToggleRowProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
};

export function ToggleRow({ checked, onChange, label, hint }: ToggleRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12px] text-zinc-200">{label}</div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-emerald-500' : 'bg-zinc-700'}`}
          onClick={() => onChange(!checked)}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? 'left-4.5 translate-x-0 left-[18px]' : 'left-0.5'}`}
          />
        </button>
      </div>
      {hint ? <div className="text-[10px] text-zinc-500">{hint}</div> : null}
    </div>
  );
}
