import { t, type Locale } from '@/utils/i18n';

type BackupViewProps = {
  mnemonic: string;
  onConfirm: () => void;
  locale: Locale;
};

export function BackupView({ mnemonic, onConfirm, locale }: BackupViewProps) {
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  return (
    <div className="w-[360px] bg-zinc-950 text-zinc-100 p-4 h-[500px] flex flex-col">
      <div className="text-sm font-semibold mb-3">{tt('popup.backup.title')}</div>
      <div className="bg-zinc-900 border border-zinc-800 p-3 rounded-md text-xs break-all font-mono overflow-y-auto max-h-[300px]">
        {mnemonic}
      </div>
      <div className="mt-2 text-[12px] text-zinc-400">
        {tt('popup.backup.notice')}
      </div>
      <div className="flex-1"></div>
      <button
        className="mt-4 w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold"
        onClick={onConfirm}
      >
        {tt('popup.backup.confirm')}
      </button>
    </div>
  );
}
