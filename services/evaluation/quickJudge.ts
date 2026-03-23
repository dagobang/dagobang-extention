import type { SiteInfo } from '@/utils/sites';
import type { TokenInfo } from '@/types/token';

export type EntryTiming = 'early' | 'middle' | 'late';
export type QuickJudgeDecision = 'go' | 'scout' | 'skip';

export type QuickJudgeWsPulse = {
  tweetUrl?: string;
  tweetAccount?: string;
  web_url?: string;
  marketCapUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
};

export type QuickJudgeTrustedSource = {
  hit: boolean;
  account?: string;
  category?: string;
};

export type QuickJudgeInput = {
  siteInfo: SiteInfo | null;
  tokenInfo: TokenInfo | null;
  tokenPriceUsd: number | null;
  marketCapDisplay?: string | null;
  wsPulse?: QuickJudgeWsPulse | null;
  trustedSource?: QuickJudgeTrustedSource | null;
};

export type QuickJudgeResult = {
  totalScore: number;
  narrativeScore: number;
  entryScore: number;
  riskPenalty: number;
  decision: QuickJudgeDecision;
  decisionText: string;
  stopLossPct: number;
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  reasons: string[];
  marketCapUsd: number | null;
  holders: number | null;
  kol: number | null;
  trustedSourceHit: boolean;
  trustedSourceAccount: string | null;
  trustedSourceCategory: string | null;
  autoEntryTiming: EntryTiming;
  wsUpdatedAtMs: number | null;
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const toSafeNumber = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/,/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
};

const parseMarketCap = (tokenInfo: TokenInfo | null, marketCapDisplay?: string | null, tokenPriceUsd?: number | null) => {
  const fromTokenInfo = toSafeNumber((tokenInfo as any)?.tokenPrice?.marketCap);
  if (fromTokenInfo != null && fromTokenInfo > 0) return fromTokenInfo;
  const fromDisplay = toSafeNumber(marketCapDisplay);
  if (fromDisplay != null && fromDisplay > 0) return fromDisplay;
  const fromPrice = typeof tokenPriceUsd === 'number' && Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0 ? tokenPriceUsd * 1_000_000_000 : null;
  if (fromPrice != null && fromPrice > 0) return fromPrice;
  return null;
};

const resolveDecision = (score: number): QuickJudgeDecision => {
  if (score >= 75) return 'go';
  if (score >= 55) return 'scout';
  return 'skip';
};

const resolveDecisionText = (decision: QuickJudgeDecision) => {
  if (decision === 'go') return '可打';
  if (decision === 'scout') return '侦察仓';
  return '放弃';
};

const resolveRiskPlan = (decision: QuickJudgeDecision) => {
  if (decision === 'go') {
    return { stopLossPct: 10, takeProfit1Pct: 25, takeProfit2Pct: 60 };
  }
  if (decision === 'scout') {
    return { stopLossPct: 8, takeProfit1Pct: 18, takeProfit2Pct: 40 };
  }
  return { stopLossPct: 6, takeProfit1Pct: 12, takeProfit2Pct: 25 };
};

export const evaluateQuickJudge = (input: QuickJudgeInput): QuickJudgeResult => {
  const now = Date.now();
  const ws = input.wsPulse ?? null;
  const marketCapUsd = (() => {
    const m = typeof ws?.marketCapUsd === 'number' && ws.marketCapUsd > 0 ? ws.marketCapUsd : null;
    if (m != null) return m;
    return parseMarketCap(input.tokenInfo, input.marketCapDisplay, input.tokenPriceUsd);
  })();
  const holders = typeof ws?.holders === 'number' && ws.holders > 0 ? ws.holders : null;
  const kol = typeof ws?.kol === 'number' && ws.kol > 0 ? ws.kol : null;
  const vol24hUsd = typeof ws?.vol24hUsd === 'number' && ws.vol24hUsd > 0 ? ws.vol24hUsd : null;
  const netBuy24hUsd = typeof ws?.netBuy24hUsd === 'number' ? ws.netBuy24hUsd : null;
  const buyTx24h = typeof ws?.buyTx24h === 'number' ? ws.buyTx24h : null;
  const sellTx24h = typeof ws?.sellTx24h === 'number' ? ws.sellTx24h : null;
  const smartMoney = typeof ws?.smartMoney === 'number' ? ws.smartMoney : null;
  const webUrl = typeof ws?.web_url === 'string' ? ws.web_url.trim() : '';
  const hasWeb2Narrative = Boolean(webUrl);
  const wsUpdatedAtMs = typeof ws?.updatedAtMs === 'number' && ws.updatedAtMs > 0 ? ws.updatedAtMs : null;
  const createdAtMs = typeof ws?.createdAtMs === 'number' && ws.createdAtMs > 0 ? ws.createdAtMs : null;
  const ageMinutes = createdAtMs != null ? Math.max(0, Math.round((now - createdAtMs) / 60000)) : null;
  const autoEntryTiming: EntryTiming = ageMinutes == null ? (marketCapUsd != null && marketCapUsd <= 500_000 ? 'early' : marketCapUsd != null && marketCapUsd <= 5_000_000 ? 'middle' : 'late') : ageMinutes <= 120 ? 'early' : ageMinutes <= 720 ? 'middle' : 'late';

  let mcapScore = 16;
  if (marketCapUsd != null) {
    if (marketCapUsd < 50_000) mcapScore = 10;
    else if (marketCapUsd < 300_000) mcapScore = 26;
    else if (marketCapUsd < 1_500_000) mcapScore = 23;
    else if (marketCapUsd < 8_000_000) mcapScore = 18;
    else if (marketCapUsd < 30_000_000) mcapScore = 11;
    else mcapScore = 7;
  }

  let flowScore = 10;
  if (buyTx24h != null && sellTx24h != null) {
    const ratio = (buyTx24h + 1) / (sellTx24h + 1);
    if (ratio >= 2.4) flowScore += 10;
    else if (ratio >= 1.6) flowScore += 7;
    else if (ratio >= 1.1) flowScore += 4;
    else if (ratio < 0.8) flowScore -= 4;
  }
  if (vol24hUsd != null && netBuy24hUsd != null && vol24hUsd > 0) {
    const netRatio = netBuy24hUsd / vol24hUsd;
    if (netRatio >= 0.2) flowScore += 8;
    else if (netRatio >= 0.1) flowScore += 5;
    else if (netRatio >= 0.03) flowScore += 2;
    else if (netRatio < -0.05) flowScore -= 6;
  }
  if (smartMoney != null) {
    if (smartMoney >= 30) flowScore += 6;
    else if (smartMoney >= 12) flowScore += 3;
  }
  flowScore = clamp(Math.round(flowScore), 2, 30);

  let kolScore = 6;
  if (kol != null) {
    if (kol >= 80) kolScore = 14;
    else if (kol >= 35) kolScore = 12;
    else if (kol >= 15) kolScore = 9;
    else if (kol >= 5) kolScore = 7;
    else kolScore = 4;
  }
  const trustedSourceHit = input.trustedSource?.hit === true;
  const trustedScore = trustedSourceHit ? 9 : 2;
  const web2Score = hasWeb2Narrative ? 3 : 0;
  const timingScore = autoEntryTiming === 'early' ? 10 : autoEntryTiming === 'middle' ? 7 : 4;
  let holdersScore = 5;
  if (holders != null) {
    if (holders >= 3000) holdersScore = 9;
    else if (holders >= 1000) holdersScore = 8;
    else if (holders >= 300) holdersScore = 6;
    else if (holders >= 100) holdersScore = 5;
    else holdersScore = 3;
  }

  const narrativeScore = clamp(kolScore + trustedScore + web2Score + Math.round((flowScore * 18) / 30), 0, 50);
  const entryScore = clamp(mcapScore + timingScore + holdersScore, 0, 50);

  let riskPenalty = 0;
  if (marketCapUsd != null && marketCapUsd < 20_000) riskPenalty += 9;
  if (autoEntryTiming === 'late') riskPenalty += 6;
  if (flowScore <= 5) riskPenalty += 5;
  if (wsUpdatedAtMs != null && now - wsUpdatedAtMs > 2 * 60_000) riskPenalty += 4;

  const totalScore = clamp(narrativeScore + entryScore - riskPenalty, 0, 100);
  const decision = resolveDecision(totalScore);
  const decisionText = resolveDecisionText(decision);
  const riskPlan = resolveRiskPlan(decision);

  const reasons: Array<{ weight: number; text: string }> = [];
  reasons.push({ weight: mcapScore, text: marketCapUsd != null ? `市值约 ${Math.round(marketCapUsd).toLocaleString()} USD（核心评估）` : '市值缺失，评分置信度下降' });
  reasons.push({ weight: flowScore, text: flowScore >= 18 ? '资金承接偏强，买盘结构健康' : flowScore <= 7 ? '资金承接偏弱，追高性价比低' : '资金承接中性，建议控仓' });
  reasons.push({ weight: kolScore, text: kol != null ? `KOL 指标 ${Math.round(kol)}，用于侧面评估热度` : 'KOL 指标缺失，热度维度降权' });
  reasons.push({ weight: trustedScore, text: trustedSourceHit ? `命中关注账号 ${input.trustedSource?.account ?? ''}${input.trustedSource?.category ? `（${input.trustedSource.category}）` : ''}` : '未命中关注账号，按普通来源处理' });
  reasons.push({ weight: web2Score, text: hasWeb2Narrative ? '存在 web_url，具备 Web2 叙事映射' : '无 web_url，Web2 叙事维度不加分' });
  reasons.push({ weight: timingScore, text: autoEntryTiming === 'early' ? '时机偏早，赔率更高' : autoEntryTiming === 'middle' ? '时机中段，重纪律与仓控' : '时机偏晚，优先侦察仓' });
  if (marketCapUsd != null) {
    reasons.push({ weight: holdersScore, text: holders != null ? `持币地址约 ${Math.round(holders).toLocaleString()}` : '持币地址缺失，结构置信度下降' });
  }
  if (riskPenalty > 0) {
    reasons.push({ weight: -riskPenalty, text: `纪律扣分 ${riskPenalty}` });
  }

  const topReasons = reasons
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 4)
    .map((x) => x.text);

  return {
    totalScore,
    narrativeScore,
    entryScore,
    riskPenalty,
    decision,
    decisionText,
    stopLossPct: riskPlan.stopLossPct,
    takeProfit1Pct: riskPlan.takeProfit1Pct,
    takeProfit2Pct: riskPlan.takeProfit2Pct,
    reasons: topReasons,
    marketCapUsd,
    holders,
    kol,
    trustedSourceHit,
    trustedSourceAccount: input.trustedSource?.account ?? null,
    trustedSourceCategory: input.trustedSource?.category ?? null,
    autoEntryTiming,
    wsUpdatedAtMs,
  };
};
