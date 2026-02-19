import { useCallback, useRef } from 'react';

export function useTradeSuccessSound(enabled?: boolean) {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const ensureReady = useCallback(() => {
    if (!enabled) return;
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return;
    if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume().catch(() => { });
    }
  }, [enabled]);

  const playBuy = useCallback(() => {
    if (!enabled) return;
    ensureReady();
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.14);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
        }
      };
    } catch {
    }
  }, [enabled, ensureReady]);

  const playSell = useCallback(() => {
    if (!enabled) return;
    ensureReady();
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'square';
      osc1.frequency.setValueAtTime(660, now);
      osc1.frequency.exponentialRampToValueAtTime(220, now + 0.11);
      gain1.gain.setValueAtTime(0.0001, now);
      gain1.gain.exponentialRampToValueAtTime(0.14, now + 0.008);
      gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.13);

      const gap = 0.03;
      const now2 = now + 0.13 + gap;

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(440, now2);
      osc2.frequency.exponentialRampToValueAtTime(165, now2 + 0.11);
      gain2.gain.setValueAtTime(0.0001, now2);
      gain2.gain.exponentialRampToValueAtTime(0.12, now2 + 0.008);
      gain2.gain.exponentialRampToValueAtTime(0.0001, now2 + 0.12);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now2);
      osc2.stop(now2 + 0.13);

      const cleanup = () => {
        try {
          osc1.disconnect();
          gain1.disconnect();
        } catch {
        }
        try {
          osc2.disconnect();
          gain2.disconnect();
        } catch {
        }
      };

      osc2.onended = cleanup;
    } catch {
    }
  }, [enabled, ensureReady]);

  return { ensureReady, playBuy, playSell };
}
