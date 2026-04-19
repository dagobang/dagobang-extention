import { useState } from 'react';
import { call } from '@/utils/messaging';
import type { SettingsDraftProps } from './types';

export function TelegramSettings({ settingsDraft, setSettingsDraft, tt, busy }: SettingsDraftProps) {
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const telegramEnabled = settingsDraft.telegram?.enabled === true;
  const telegramBotToken = String(settingsDraft.telegram?.botToken || '');
  const telegramChatId = String(settingsDraft.telegram?.chatId || '');
  const telegramUserId = String(settingsDraft.telegram?.userId || '');
  const telegramEnforceUserId = settingsDraft.telegram?.enforceUserId === true;
  const getUpdatesUrl = telegramBotToken.trim()
    ? `https://api.telegram.org/bot${telegramBotToken.trim()}/getUpdates`
    : '';
  const maskedGetUpdatesUrl = telegramBotToken.trim()
    ? `https://api.telegram.org/bot***TOKEN***/getUpdates`
    : '';

  const testTelegram = async () => {
    if (telegramTesting) return;
    setTelegramTesting(true);
    try {
      await call({ type: 'telegram:test' });
    } catch {
    } finally {
      setTelegramTesting(false);
    }
  };

  const openGetUpdates = () => {
    if (!getUpdatesUrl) return;
    window.open(getUpdatesUrl, '_blank', 'noopener,noreferrer');
  };

  const copyGetUpdates = async () => {
    if (!getUpdatesUrl) return;
    try {
      await navigator.clipboard.writeText(getUpdatesUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1200);
    } catch {
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-3">
        <div className="text-[13px] font-semibold text-zinc-300">{tt('popup.settings.telegramGuideTitle')}</div>
        <div className="text-[12px] text-zinc-500">{tt('popup.settings.telegramGuide1')}</div>
        <div className="text-[12px] text-zinc-500">{tt('popup.settings.telegramGuide2')}</div>
        <div className="text-[12px] text-zinc-500">{tt('popup.settings.telegramGuide3')}</div>
        <div className="text-[12px] text-zinc-500">{tt('popup.settings.telegramGuide4')}</div>
        <div className="text-[12px] text-amber-400">{tt('popup.settings.telegramGuideSecurity')}</div>
        <div className="pt-2 flex gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] hover:bg-zinc-800 disabled:opacity-60"
            disabled={!telegramBotToken.trim()}
            onClick={openGetUpdates}
          >
            {tt('popup.settings.telegramOpenGetUpdates')}
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] hover:bg-zinc-800 disabled:opacity-60"
            disabled={!telegramBotToken.trim()}
            onClick={() => void copyGetUpdates()}
          >
            {linkCopied ? tt('popup.settings.telegramCopied') : tt('popup.settings.telegramCopyGetUpdates')}
          </button>
        </div>
        <div className="text-[11px] text-zinc-600 break-all">{maskedGetUpdatesUrl || tt('popup.settings.telegramNeedTokenHint')}</div>
      </div>

      <div className="space-y-3">
        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.telegramEnabled')}</div>
          <input
            type="checkbox"
            checked={telegramEnabled}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                telegram: {
                  ...(s.telegram ?? {}),
                  enabled: e.target.checked,
                },
              }))
            }
          />
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.telegramBotToken')}</div>
          <input
            type="password"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={telegramBotToken}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                telegram: {
                  ...(s.telegram ?? {}),
                  botToken: e.target.value,
                },
              }))
            }
            placeholder="123456:ABC..."
          />
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.telegramChatId')}</div>
          <input
            type="text"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={telegramChatId}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                telegram: {
                  ...(s.telegram ?? {}),
                  chatId: e.target.value,
                },
              }))
            }
            placeholder="123456789"
          />
        </label>

        <div className="pt-2 mt-1 border-t border-zinc-800" />
        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.telegramEnforceUserId')}</div>
          <input
            type="checkbox"
            checked={telegramEnforceUserId}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                telegram: {
                  ...(s.telegram ?? {}),
                  enforceUserId: e.target.checked,
                },
              }))
            }
          />
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.telegramUserId')}</div>
          <input
            type="text"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={telegramUserId}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                telegram: {
                  ...(s.telegram ?? {}),
                  userId: e.target.value,
                },
              }))
            }
            placeholder="123456789"
          />
        </label>
        <div className="text-[12px] text-zinc-500">{tt('popup.settings.telegramUserIdHint')}</div>

        <button
          type="button"
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] hover:bg-zinc-800 disabled:opacity-60"
          disabled={busy || telegramTesting || !telegramEnabled || !telegramBotToken.trim() || !telegramChatId.trim()}
          onClick={() => void testTelegram()}
        >
          {telegramTesting ? tt('popup.settings.telegramTesting') : tt('popup.settings.telegramTest')}
        </button>
      </div>
    </div>
  );
}
