import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { SettingsDraftProps } from './types';
import { DEFAULT_VISION_BASE, VISION_STATUS_STORAGE_KEY } from '@/services/vision/constants';
import type { VisionForwardStatus } from '@/services/vision/forwarder';

export function VisionSettings({ settingsDraft, setSettingsDraft, tt, busy }: SettingsDraftProps) {
  const reportCfg = settingsDraft.visionReport ?? {
    enabled: true,
    baseUrl: DEFAULT_VISION_BASE,
  };
  const [status, setStatus] = useState<VisionForwardStatus | null>(null);
  const effectiveBaseUrl = (status?.baseUrl || reportCfg.baseUrl || DEFAULT_VISION_BASE).trim() || DEFAULT_VISION_BASE;
  const effectiveWsUrl = toWsIngestUrl(effectiveBaseUrl);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await browser.storage.local.get(VISION_STATUS_STORAGE_KEY);
        const next = ((res as any)?.[VISION_STATUS_STORAGE_KEY] as VisionForwardStatus | undefined) ?? null;
        if (alive) setStatus(next);
      } catch {
      }
    };
    void load();
    const t = setInterval(() => {
      void load();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const setVision = (patch: Partial<{ enabled: boolean; baseUrl: string }>) => {
    setSettingsDraft((s) => ({
      ...s,
      visionReport: {
        enabled: typeof s.visionReport?.enabled === 'boolean' ? s.visionReport.enabled : true,
        baseUrl: (s.visionReport?.baseUrl || DEFAULT_VISION_BASE).trim() || DEFAULT_VISION_BASE,
        ...patch,
      },
    }));
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.visionReport')}</div>
        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.visionReportEnabled')}</div>
          <input
            type="checkbox"
            checked={reportCfg.enabled !== false}
            disabled={busy}
            onChange={(e) => setVision({ enabled: e.target.checked })}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.visionReportBaseUrl')}</div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={reportCfg.baseUrl || ''}
            disabled={busy}
            onChange={(e) => setVision({ baseUrl: e.target.value })}
            placeholder={DEFAULT_VISION_BASE}
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.visionReportHint')}</div>
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.visionReportWsTarget', [effectiveWsUrl])}</div>
        </label>
      </div>

      <div className="space-y-2 pt-4 border-t border-zinc-800">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.visionReportStatus')}</div>
        <div className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-[12px] text-zinc-300 space-y-1">
          <div>{tt('popup.settings.visionStatusEnabled')}: {status?.enabled === false ? tt('popup.settings.visionStatusOff') : tt('popup.settings.visionStatusOn')}</div>
          <div>{tt('popup.settings.visionStatusBaseUrl')}: {effectiveBaseUrl}</div>
          <div>{tt('popup.settings.visionStatusWsUrl')}: {effectiveWsUrl}</div>
          <div>{tt('popup.settings.visionStatusSuccess')}: {status?.successCount ?? 0}</div>
          <div>{tt('popup.settings.visionStatusFail')}: {status?.failCount ?? 0}</div>
          <div>{tt('popup.settings.visionStatusBackpressure')}: {status?.backpressureCount ?? 0}</div>
          <div>{tt('popup.settings.visionStatusDroppedPackets')}: {status?.droppedPackets ?? 0}</div>
          <div>{tt('popup.settings.visionStatusDroppedAggregateRows')}: {status?.droppedAggregateRows ?? 0}</div>
          <div>{tt('popup.settings.visionStatusLastPath')}: {status?.lastPath || '-'}</div>
          <div>{tt('popup.settings.visionStatusLastSuccess')}: {status?.lastSuccessAtMs ? new Date(status.lastSuccessAtMs).toLocaleString() : '-'}</div>
          <div>{tt('popup.settings.visionStatusLastError')}: {status?.lastError ? `${status.lastError}` : '-'}</div>
          <div className="pt-2 text-[11px] text-zinc-500">{tt('popup.settings.visionStatusProtectionHint')}</div>
        </div>
      </div>
    </div>
  );
}

function toWsIngestUrl(base: string): string {
  const raw = String(base || '').trim() || DEFAULT_VISION_BASE;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.pathname = '/ingest/ws';
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return 'ws://127.0.0.1:18081/ingest/ws';
    }
  }
  const normalized = raw.replace(/\/+$/, '');
  if (/^wss?:\/\//i.test(normalized)) return `${normalized}/ingest/ws`;
  return `ws://${normalized.replace(/^\/+/, '')}/ingest/ws`;
}
