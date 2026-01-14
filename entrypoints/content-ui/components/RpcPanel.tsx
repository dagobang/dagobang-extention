import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { Settings } from '@/types/extention';
import { RpcService } from '@/services/rpc';
import { t, type Locale } from '@/utils/i18n';

type RpcPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  locale: Locale;
};

type RpcLatency = {
  url: string;
  latencyMs: number | null;
  ok: boolean;
};

export function RpcPanel({ visible, onVisibleChange, settings, locale }: RpcPanelProps) {
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 420;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_rpc_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_rpc_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const [latencies, setLatencies] = useState<RpcLatency[]>([]);
  const [measuring, setMeasuring] = useState(false);

  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const nodes = (() => {
    if (!settings) return [];
    const chainId = settings.chainId;
    const chain = settings.chains[chainId];
    if (!chain) return [];
    if (chain.protectedRpcUrls.length > 0) {
      return chain.protectedRpcUrls;
    }
    return chain.rpcUrls;
  })();

  useEffect(() => {
    setLatencies((prev) => {
      const map = new Map(prev.map((x) => [x.url, x]));
      const next: RpcLatency[] = [];
      for (const url of nodes) {
        const existing = map.get(url);
        if (existing) {
          next.push(existing);
        } else {
          next.push({ url, latencyMs: null, ok: false });
        }
      }
      return next;
    });
  }, [nodes.join(',')]);

  const handleMeasure = async () => {
    if (!settings) {
      toast.error(tt('contentUi.rpcPanel.settingsNotLoaded'), { icon: '❌' });
      return;
    }
    if (nodes.length === 0) {
      toast.error(tt('contentUi.rpcPanel.rpcNotConfigured'), { icon: '❌' });
      return;
    }
    setMeasuring(true);
    try {
      const results: RpcLatency[] = await Promise.all(
        nodes.map(async (url) => {
          try {
            const latencyMs = await RpcService.measureLatency(url);
            return { url, latencyMs, ok: true };
          } catch {
            return { url, latencyMs: null, ok: false };
          }
        }),
      );
      setLatencies(results);
      toast.success(tt('contentUi.rpcPanel.latencyUpdated'), { icon: '✅' });
    } finally {
      setMeasuring(false);
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <div
      className="fixed z-[2147483647]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="w-[360px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/40 text-[12px]">
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab"
          onPointerDown={(e) => {
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex flex-col">
            <div className="text-xs font-semibold text-sky-300">{tt('contentUi.rpcPanel.title')}</div>
            <div className="text-[10px] text-zinc-500">
              {tt('contentUi.rpcPanel.subtitle')}
            </div>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            {tt('contentUi.rpcPanel.close')}
          </button>
        </div>
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>{tt('contentUi.rpcPanel.nodeCount')}</div>
            <div className="font-mono text-[11px] text-zinc-200">{nodes.length}</div>
          </div>

          <button
            type="button"
            className="w-full rounded-md bg-sky-500 text-[12px] font-semibold text-black py-2 hover:bg-sky-400 disabled:opacity-60"
            onClick={handleMeasure}
            disabled={measuring || nodes.length === 0}
          >
            {measuring ? tt('contentUi.rpcPanel.measuring') : tt('contentUi.rpcPanel.measure')}
          </button>

          <div className="max-h-[260px] overflow-auto border border-zinc-800 rounded-md divide-y divide-zinc-800">
            {nodes.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500">
                {tt('contentUi.rpcPanel.empty')}
              </div>
            ) : (
              latencies.map((item) => {
                const url = item.url;
                const latencyText = item.latencyMs != null ? `${item.latencyMs.toFixed(0)} ms` : tt('contentUi.rpcPanel.measureFailed');
                const statusColor = item.latencyMs == null ? 'text-red-400' : item.latencyMs < 200 ? 'text-emerald-400' : item.latencyMs < 500 ? 'text-yellow-300' : 'text-orange-400';
                return (
                  <div
                    key={url}
                    className="px-3 py-2 flex flex-col gap-1 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 break-all text-zinc-300">{url}</div>
                      <div className={`ml-2 font-mono ${statusColor}`}>{latencyText}</div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
