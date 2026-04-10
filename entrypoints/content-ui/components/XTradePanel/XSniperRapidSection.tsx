import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AutoTradeInteractionType } from '@/types/extention';

const rapidTypeOptions: AutoTradeInteractionType[] = ['tweet', 'reply', 'quote', 'retweet', 'follow'];

type XSniperRapidSectionProps = {
  open: boolean;
  canEdit: boolean;
  rapidExitEnabled: boolean;
  twitterSnipe: any;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  updateTwitterSnipe: (patch: any) => void;
  getRapidTypeEnabled: (tweetType: AutoTradeInteractionType) => boolean;
  getRapidTypeValue: (tweetType: AutoTradeInteractionType, field: string) => string;
  getRapidTypeFallbackValue: (field: string) => string;
  updateRapidTypeValue: (tweetType: AutoTradeInteractionType, field: string, value: string | boolean) => void;
};

export function XSniperRapidSection({
  open,
  canEdit,
  rapidExitEnabled,
  twitterSnipe,
  tt,
  onToggle,
  updateTwitterSnipe,
  getRapidTypeEnabled,
  getRapidTypeValue,
  getRapidTypeFallbackValue,
  updateRapidTypeValue,
}: XSniperRapidSectionProps) {
  return (
    <div className="space-y-3 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>{tt('contentUi.autoTradeStrategy.rapidExitTitle')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
      <div className="space-y-3 rounded-md border border-cyan-900/40 bg-cyan-950/10 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-cyan-500"
              checked={rapidExitEnabled}
              disabled={!canEdit}
              onChange={(e) =>
                updateTwitterSnipe({
                  rapidExitEnabled: e.target.checked,
                } as any)
              }
            />
            <span>{tt('contentUi.autoTradeStrategy.rapidExitMainStrategy')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-violet-500"
              checked={(twitterSnipe as any)?.rapidByTweetTypeEnabled !== false}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidByTweetTypeEnabled: e.target.checked } as any)}
            />
            <span>{tt('contentUi.autoTradeStrategy.rapidExitByTweetType')}</span>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitTakeProfitPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidTakeProfitPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidTakeProfitPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitStopLossPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidStopLossPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidStopLossPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitSellPercent')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidSellPercent ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidSellPercent: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitEmergencyStopLossPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidEmergencyStopLossPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidEmergencyStopLossPct: e.target.value } as any)}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">止盈卖出比例(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidTakeProfitSellPercent ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidTakeProfitSellPercent: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">止损卖出比例(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidStopLossSellPercent ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidStopLossSellPercent: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">追踪止盈卖出比例(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidTrailingStopSellPercent ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidTrailingStopSellPercent: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">盈利保护启动(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidArmProfitPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidArmProfitPct: e.target.value } as any)}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">保护底线(启动后,%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidProtectFloorAfterArmPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidProtectFloorAfterArmPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">二阶峰值阈值(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidProtectStep2PeakPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidProtectStep2PeakPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">二阶保护底线(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidProtectStep2FloorPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidProtectStep2FloorPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">三阶峰值阈值(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidProtectStep3PeakPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidProtectStep3PeakPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">三阶保护底线(%)</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidProtectStep3FloorPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidProtectStep3FloorPct: e.target.value } as any)}
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitTrailActivatePct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidTrailActivatePct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidTrailActivatePct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitTrailDropPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidTrailDropPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidTrailDropPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitEarlyReversalPeakPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidEarlyReversalPeakPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidEarlyReversalPeakPct: e.target.value } as any)}
            />
          </label>
          <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
            <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitEarlyReversalDropPct')}</div>
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
              value={(twitterSnipe as any)?.rapidEarlyReversalDropPct ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ rapidEarlyReversalDropPct: e.target.value } as any)}
            />
          </label>
        </div>
        <div className="rounded-md border border-zinc-800/70 bg-zinc-950/30 p-2">
          <div className="mb-2 text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitDelayProtection')}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitMinHoldStopLoss')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidMinHoldMsForStopLoss ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidMinHoldMsForStopLoss: e.target.value } as any)}
              />
            </label>
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitMinHoldTakeProfit')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidMinHoldMsForTakeProfit ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidMinHoldMsForTakeProfit: e.target.value } as any)}
              />
            </label>
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitMinHoldTrail')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidMinHoldMsForTrail ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidMinHoldMsForTrail: e.target.value } as any)}
              />
            </label>
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitRunnerStopLossGrace')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidRunnerStopLossGraceMs ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidRunnerStopLossGraceMs: e.target.value } as any)}
              />
            </label>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitAuxWindowA')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidAuxWindow10sMs ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidAuxWindow10sMs: e.target.value } as any)}
              />
            </label>
            <label className="space-y-1">
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitAuxWindowB')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.rapidAuxWindow30sMs ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidAuxWindow30sMs: e.target.value } as any)}
              />
            </label>
          </div>
        </div>
        {(twitterSnipe as any)?.rapidByTweetTypeEnabled !== false ? (
          <div className="space-y-2 rounded-md border border-zinc-800/80 bg-zinc-950/30 p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[12px] text-zinc-300">{tt('contentUi.autoTradeStrategy.rapidExitTierConfig')}</div>
              <div className="text-[11px] text-zinc-500">{tt('contentUi.autoTradeStrategy.rapidExitTierFallbackHint')}</div>
            </div>
            <div className="dagobang-scrollbar overflow-x-auto pb-1">
              <div className="grid min-w-[940px] grid-cols-[84px_66px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2 text-[11px] text-zinc-500">
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableType')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableEnabled')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableTakeProfit')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableStopLoss')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableTrailActivate')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableTrailDrop')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableEmergencyStopLoss')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableSellPercent')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableMinHoldStopLoss')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableMinHoldTakeProfit')}</div>
                <div>{tt('contentUi.autoTradeStrategy.rapidExitTableMinHoldTrail')}</div>
              </div>
              <div className="mt-1 grid min-w-[940px] grid-cols-[84px_66px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2 text-[11px] text-zinc-500">
                <div />
                <div />
                <div>止盈卖出%</div>
                <div>止损卖出%</div>
                <div>追踪卖出%</div>
                <div>保护启动%</div>
                <div>启动底线%</div>
                <div>二阶峰值%</div>
                <div>二阶底线%</div>
                <div>三阶峰值%</div>
                <div>三阶底线%</div>
              </div>
            {rapidTypeOptions.map((item) => (
              <div key={item} className="mt-2 min-w-[940px] space-y-1">
                <div className="grid grid-cols-[84px_66px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2">
                  <div className="flex items-center rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300">
                    {tt(`contentUi.autoTradeStrategy.interaction.${item}`)}
                  </div>
                  <label className="flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-cyan-500"
                      checked={getRapidTypeEnabled(item)}
                      disabled={!canEdit}
                      onChange={(e) => updateRapidTypeValue(item, 'enabled', e.target.checked)}
                    />
                  </label>
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'takeProfitPct')}
                    placeholder={getRapidTypeFallbackValue('takeProfitPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'takeProfitPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'stopLossPct')}
                    placeholder={getRapidTypeFallbackValue('stopLossPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'stopLossPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'trailActivatePct')}
                    placeholder={getRapidTypeFallbackValue('trailActivatePct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'trailActivatePct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'trailDropPct')}
                    placeholder={getRapidTypeFallbackValue('trailDropPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'trailDropPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'emergencyStopLossPct')}
                    placeholder={getRapidTypeFallbackValue('emergencyStopLossPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'emergencyStopLossPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'sellPercent')}
                    placeholder={getRapidTypeFallbackValue('sellPercent')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'sellPercent', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'minHoldMsForStopLoss')}
                    placeholder={getRapidTypeFallbackValue('minHoldMsForStopLoss')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'minHoldMsForStopLoss', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'minHoldMsForTakeProfit')}
                    placeholder={getRapidTypeFallbackValue('minHoldMsForTakeProfit')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'minHoldMsForTakeProfit', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'minHoldMsForTrail')}
                    placeholder={getRapidTypeFallbackValue('minHoldMsForTrail')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'minHoldMsForTrail', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-[84px_66px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr] gap-2">
                  <div />
                  <div />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'takeProfitSellPercent')}
                    placeholder={getRapidTypeFallbackValue('takeProfitSellPercent')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'takeProfitSellPercent', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'stopLossSellPercent')}
                    placeholder={getRapidTypeFallbackValue('stopLossSellPercent')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'stopLossSellPercent', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'trailingStopSellPercent')}
                    placeholder={getRapidTypeFallbackValue('trailingStopSellPercent')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'trailingStopSellPercent', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'armProfitPct')}
                    placeholder={getRapidTypeFallbackValue('armProfitPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'armProfitPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'protectFloorAfterArmPct')}
                    placeholder={getRapidTypeFallbackValue('protectFloorAfterArmPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'protectFloorAfterArmPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'protectStep2PeakPct')}
                    placeholder={getRapidTypeFallbackValue('protectStep2PeakPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'protectStep2PeakPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'protectStep2FloorPct')}
                    placeholder={getRapidTypeFallbackValue('protectStep2FloorPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'protectStep2FloorPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'protectStep3PeakPct')}
                    placeholder={getRapidTypeFallbackValue('protectStep3PeakPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'protectStep3PeakPct', e.target.value)}
                  />
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={getRapidTypeValue(item, 'protectStep3FloorPct')}
                    placeholder={getRapidTypeFallbackValue('protectStep3FloorPct')}
                    disabled={!canEdit}
                    onChange={(e) => updateRapidTypeValue(item, 'protectStep3FloorPct', e.target.value)}
                  />
                </div>
              </div>
            ))}
            </div>
          </div>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}
