import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import GmgnAPI, { DailyProfit } from '@/hooks/GmgnAPI';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { X, RefreshCw, Calendar, Search, Maximize2, Minimize2 } from 'lucide-react';

type DailyAnalysisPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  address: string | null;
};

export function DailyAnalysisPanel({
  visible,
  onVisibleChange,
  settings,
  address,
}: DailyAnalysisPanelProps) {
  const [isMaximized, setIsMaximized] = useState(false);
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, (width - 600) / 2); // Center it
    const defaultY = 100;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_daily_analysis_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 600));
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
        const key = 'dagobang_daily_analysis_panel_pos';
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

  const [data, setData] = useState<DailyProfit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [targetAddress, setTargetAddress] = useState(address || '');
  const [inputAddress, setInputAddress] = useState(address || '');

  const [hiddenSeries, setHiddenSeries] = useState<string[]>(['buy_amount_usd_num', 'sell_amount_usd_num', 'loss_profit_num']);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const handleLegendClick = (e: any) => {
    const { dataKey } = e;
    setHiddenSeries(prev =>
      prev.includes(dataKey)
        ? prev.filter(key => key !== dataKey)
        : [...prev, dataKey]
    );
  };

  const dateLocale = locale === 'zh_CN' ? 'zh-CN' : locale === 'zh_TW' ? 'zh-TW' : 'en-US';
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const formatDate = (timestamp: number, options?: Intl.DateTimeFormatOptions) => {
    return new Date(timestamp * 1000).toLocaleDateString(dateLocale, options);
  };

  useEffect(() => {
    if (address) {
      setTargetAddress(address);
      setInputAddress(address);
    }
  }, [address]);

  const fetchData = async () => {
    if (!targetAddress) return;
    setLoading(true);
    setError(null);
    try {
      const chain = await GmgnAPI.getChain() || 'sol';

      const endAt = Math.floor(Date.now() / 1000);
      const startAt = endAt - days * 24 * 60 * 60;

      // Split into 30-day chunks to avoid API limits
      const CHUNK_SIZE = 30 * 24 * 60 * 60;
      const promises = [];

      let currentStart = startAt;
      while (currentStart < endAt) {
        const currentEnd = Math.min(currentStart + CHUNK_SIZE, endAt);
        promises.push(GmgnAPI.getDailyProfits({
          wallet_addresses: [targetAddress],
          start_at: currentStart,
          end_at: currentEnd,
          chain,
        }));
        currentStart = currentEnd;
      }

      const responses = await Promise.all(promises);

      let allList: DailyProfit[] = [];
      let hasError = false;
      let errorMessage = '';

      for (const res of responses) {
        if (res.code === 0 && res.data?.list) {
          allList = allList.concat(res.data.list);
        } else if (res.code !== 0) {
          hasError = true;
          errorMessage = res.message || 'Fetch failed';
        }
      }

      if (allList.length === 0 && hasError) {
        throw new Error(errorMessage);
      }

      // Deduplicate by date
      const uniqueMap = new Map();
      allList.forEach(item => uniqueMap.set(item.date, item));
      const uniqueList = Array.from(uniqueMap.values());

      // Sort by date ascending and process data
      const sorted = uniqueList.sort((a, b) => a.date - b.date).map(item => ({
        ...item,
        // Convert strings to numbers for charts
        buy_amount_usd_num: parseFloat(item.buy_amount_usd),
        sell_amount_usd_num: parseFloat(item.sell_amount_usd),
        total_profit_num: parseFloat(item.total_profit),
        loss_profit_num: parseFloat(item.loss_profit),
      }));
      setData(sorted as any);

    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible && targetAddress) {
      fetchData();
    }
  }, [visible, targetAddress, days]);

  const gradientOffset = () => {
    if (data.length === 0) return 0;
    const dataMax = Math.max(...data.map((i) => Number(i.total_profit)));
    const dataMin = Math.min(...data.map((i) => Number(i.total_profit)));

    if (dataMax <= 0) return 0;
    if (dataMin >= 0) return 1;

    return dataMax / (dataMax - dataMin);
  };

  const off = gradientOffset();

  const seriesConfig = [
    { key: 'total_profit_num', name: '总收益', color: '#fbbf24', stroke: 'url(#splitColor)', yAxisId: 'left', strokeWidth: 2 },
    { key: 'total_buys', name: '买入次数', color: '#60a5fa', stroke: '#60a5fa', yAxisId: 'right', strokeWidth: 1 },
    { key: 'total_sells', name: '卖出次数', color: '#c084fc', stroke: '#c084fc', yAxisId: 'right', strokeWidth: 1 },
    { key: 'buy_amount_usd_num', name: '买入量 (USD)', color: '#34d399', stroke: '#34d399', yAxisId: 'left', strokeWidth: 1 },
    { key: 'sell_amount_usd_num', name: '卖出量 (USD)', color: '#f87171', stroke: '#f87171', yAxisId: 'left', strokeWidth: 1 },
    { key: 'loss_profit_num', name: '亏损额', color: '#a1a1aa', stroke: '#a1a1aa', yAxisId: 'left', strokeWidth: 1, strokeDasharray: '5 5' },
  ];

  const renderLegend = () => {
    return (
      <div className="flex flex-wrap justify-center gap-4 pt-2">
        {seriesConfig.map((item) => {
          const isHidden = hiddenSeries.includes(item.key);
          return (
            <div
              key={item.key}
              onClick={() => handleLegendClick({ dataKey: item.key })}
              className="flex items-center cursor-pointer select-none transition-opacity hover:opacity-80"
            >
              <div
                className="w-2.5 h-2.5 rounded-full mr-1.5"
                style={{
                  backgroundColor: isHidden ? '#52525b' : item.color,
                }}
              />
              <span
                className="text-[12px]"
                style={{
                  color: isHidden ? '#52525b' : '#e4e4e7',
                }}
              >
                {item.name}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  if (!visible) {
    return null;
  }

  return (
    <div
      className={`fixed z-[2147483647] ${isMaximized ? 'inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm' : ''}`}
      style={isMaximized ? undefined : { left: pos.x, top: pos.y }}
    >
      <div className={`${isMaximized ? 'w-[95%] h-[95%]' : 'w-[600px]'} rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/20 text-[12px] flex flex-col transition-all duration-200`}>
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 cursor-grab flex-shrink-0"
          onPointerDown={(e) => {
            if (isMaximized) return;
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex items-center gap-2 flex-1">
            <div className="text-sm font-semibold text-emerald-300 whitespace-nowrap">P小将分析</div>
            <div className="relative flex-1 max-w-[280px]">
              <input
                type="text"
                value={inputAddress}
                onChange={(e) => setInputAddress(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setTargetAddress(inputAddress);
                  }
                }}
                onBlur={() => {
                  if (inputAddress && inputAddress !== targetAddress) {
                    setTargetAddress(inputAddress);
                  }
                }}
                placeholder="Enter wallet address"
                className="w-full bg-zinc-900 border border-zinc-700 rounded pl-2 pr-7 py-0.5 text-[10px] text-zinc-300 focus:outline-none focus:border-emerald-500/50 font-mono"
              />
              <Search
                className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500 cursor-pointer hover:text-emerald-400"
                onClick={() => setTargetAddress(inputAddress)}
              />
            </div>
            {loading && <RefreshCw className="w-3 h-3 animate-spin text-zinc-400" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-zinc-900 rounded px-2 py-1">
              <Calendar className="w-3 h-3 text-zinc-400" />
              <select
                className="bg-transparent outline-none text-zinc-300 text-[11px]"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={30}>30 Days (1M)</option>
                <option value={90}>90 Days (3M)</option>
                <option value={180}>180 Days (6M)</option>
                <option value={365}>365 Days (1Y)</option>
              </select>
            </div>
            <button
              className="text-zinc-400 hover:text-zinc-200"
              onClick={() => setIsMaximized(!isMaximized)}
            >
              {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              className="text-zinc-400 hover:text-zinc-200"
              onClick={() => onVisibleChange(false)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className={`p-4 ${isMaximized ? 'flex-1 min-h-0' : 'h-[350px]'}`}>
          {error ? (
            <div className="h-full flex items-center justify-center text-red-400">
              {error}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data}>
                <defs>
                  <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                    <stop offset={off} stopColor="#34d399" stopOpacity={1} />
                    <stop offset={off} stopColor="#f87171" stopOpacity={1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                  dataKey="date"
                  stroke="#71717a"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(val) => formatDate(val, { month: 'numeric', day: 'numeric' })}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#71717a"
                  tick={{ fontSize: 10 }}
                  tickFormatter={formatCurrency}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#71717a"
                  tick={{ fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', fontSize: '12px' }}
                  formatter={(value: number | undefined) => value !== undefined ? formatCurrency(value) : ''}
                  labelFormatter={(val) => formatDate(val, { year: 'numeric', month: 'numeric', day: 'numeric' })}
                />
                <Legend
                  content={renderLegend}
                  verticalAlign="bottom"
                />
                {seriesConfig.map((s) => (
                  <Line
                    key={s.key}
                    yAxisId={s.yAxisId}
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.stroke}
                    dot={false}
                    strokeWidth={s.strokeWidth}
                    strokeDasharray={s.strokeDasharray}
                    hide={hiddenSeries.includes(s.key)}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
