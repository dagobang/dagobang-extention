import { useCallback, useRef } from 'react';
import type { TradeSuccessSoundPreset } from '@/types/extention';

type UseTradeSuccessSoundOptions = {
  enabled?: boolean;
  volume?: number;
  buyPreset?: TradeSuccessSoundPreset;
  sellPreset?: TradeSuccessSoundPreset;
};

export function useTradeSuccessSound(options?: UseTradeSuccessSoundOptions) {
  const enabled = !!options?.enabled;
  const buyPreset = options?.buyPreset ?? 'Bell';
  const sellPreset = options?.sellPreset ?? 'Coins';
  const volume = typeof options?.volume === 'number' ? options!.volume : 60;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const bufferCacheRef = useRef<Map<TradeSuccessSoundPreset, AudioBuffer>>(new Map());
  const loadingRef = useRef<Map<TradeSuccessSoundPreset, Promise<AudioBuffer>>>(new Map());

  const getUrl = (preset: TradeSuccessSoundPreset) => {
    try {
      const runtime = (globalThis as any)?.chrome?.runtime;
      if (runtime?.getURL) return runtime.getURL(`sounds/${preset}.mp3`);
    } catch {
    }
    try {
      return new URL(`/sounds/${preset}.mp3`, window.location.origin).toString();
    } catch {
      return `sounds/${preset}.mp3`;
    }
  };

  const ensureCtx = useCallback(() => {
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
    return audioCtxRef.current;
  }, []);

  const loadPreset = useCallback(async (preset: TradeSuccessSoundPreset) => {
    const existing = bufferCacheRef.current.get(preset);
    if (existing) return existing;

    const pending = loadingRef.current.get(preset);
    if (pending) return pending;

    const p = (async () => {
      const ctx = ensureCtx();
      if (!ctx) throw new Error('AudioContext not available');
      const url = getUrl(preset);
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      bufferCacheRef.current.set(preset, decoded);
      loadingRef.current.delete(preset);
      return decoded;
    })();

    loadingRef.current.set(preset, p);
    try {
      return await p;
    } finally {
      loadingRef.current.delete(preset);
    }
  }, [ensureCtx]);

  const ensureReady = useCallback(() => {
    if (!enabled) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => { });
    }

    void loadPreset(buyPreset).catch(() => { });
    void loadPreset(sellPreset).catch(() => { });
  }, [enabled, buyPreset, sellPreset]);

  const playPreset = useCallback((preset: TradeSuccessSoundPreset) => {
    if (!enabled) return;
    ensureReady();
    const ctx = ensureCtx();
    if (!ctx) return;

    const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume / 100 : 0.6));
    const playBuffer = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(v, ctx.currentTime);
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
      src.onended = () => {
        try {
          src.disconnect();
          gain.disconnect();
        } catch {
        }
      };
    };

    void (async () => {
      try {
        if (ctx.state === 'suspended') await ctx.resume();
        const existing = bufferCacheRef.current.get(preset);
        if (existing) {
          playBuffer(existing);
          return;
        }
        const buf = await loadPreset(preset);
        playBuffer(buf);
      } catch {
      }
    })();
  }, [enabled, ensureReady, volume, ensureCtx, loadPreset]);

  const playBuy = useCallback(() => {
    playPreset(buyPreset);
  }, [buyPreset, playPreset]);

  const playSell = useCallback(() => {
    playPreset(sellPreset);
  }, [playPreset, sellPreset]);

  return { ensureReady, playPreset, playBuy, playSell };
}
