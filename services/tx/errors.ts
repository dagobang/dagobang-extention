import { decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem';

const scoreRevertReason = (reason: string) => {
  const r = reason.toLowerCase();
  let v = 0;
  if (/^0x[0-9a-f]*$/i.test(reason)) v -= 120;
  if (r.includes('zero_input')) v -= 80;
  if (r.includes('insufficient allowance') || r.includes('allowance')) v += 200;
  if (r.includes('insufficient balance') || r.includes('balance')) v += 120;
  if (r.includes('transfer') || r.includes('transferfrom')) v += 80;
  if (r.includes('slippage') || r.includes('min') || r.includes('amount')) v += 20;
  if (/^[A-Z0-9_]{3,}$/.test(reason)) v -= 30;
  if (reason.includes('0x') && reason.length > 60) v -= 40;
  v += Math.min(30, Math.floor(reason.length / 10));
  return v;
};

const decodeRevertDataToReason = (data: any) => {
  if (typeof data !== 'string') return null;
  const hex = data.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex === '0x' || hex.length < 10) return null;
  const sel = hex.slice(0, 10).toLowerCase();
  if (sel === '0x08c379a0') {
    const body = `0x${hex.slice(10)}` as `0x${string}`;
    try {
      const [msg] = decodeAbiParameters([{ type: 'string' }], body);
      return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
    } catch {
      return null;
    }
  }
  if (sel === '0x4e487b71') {
    const body = `0x${hex.slice(10)}` as `0x${string}`;
    try {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], body);
      const n = typeof code === 'bigint' ? Number(code) : Number(code);
      const map: Record<string, string> = {
        '0x01': 'Panic(0x01)',
        '0x11': 'Panic(0x11)',
        '0x12': 'Panic(0x12)',
        '0x21': 'Panic(0x21)',
        '0x22': 'Panic(0x22)',
        '0x31': 'Panic(0x31)',
        '0x32': 'Panic(0x32)',
        '0x41': 'Panic(0x41)',
        '0x51': 'Panic(0x51)',
      };
      const key = `0x${n.toString(16)}`;
      return map[key] ?? `Panic(${key})`;
    } catch {
      return null;
    }
  }
  return null;
};

const routerSwapAbi = parseAbi([
  'struct SwapDesc { uint8 swapType; address tokenIn; address tokenOut; address poolAddress; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; address poolManager; bytes32 parameters; bytes data; }',
  'function swap(SwapDesc[] descs, address feeToken, uint256 amountIn, uint256 minReturn, uint256 deadline) payable',
  'function swapPercent(SwapDesc[] descs, address feeToken, uint16 percentBps, uint256 minReturn, uint256 deadline) payable',
]);

const erc20AbiLite = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const tryDecodeSwapInput = (input: any) => {
  if (typeof input !== 'string') return null;
  try {
    const decoded = decodeFunctionData({ abi: routerSwapAbi, data: input as `0x${string}` }) as any;
    const fn = decoded?.functionName as string | undefined;
    const args = decoded?.args as any[] | undefined;
    if (!args || args.length < 5) return null;
    const descs = args[0] as any[];
    const tokenIn = descs?.[0]?.tokenIn as string | undefined;
    if (!tokenIn || !/^0x[a-fA-F0-9]{40}$/.test(tokenIn)) return null;
    if (fn === 'swap') {
      const amountIn = args[2] as bigint | number;
      const a = typeof amountIn === 'bigint' ? amountIn : BigInt(amountIn as any);
      return { kind: 'swap' as const, tokenIn: tokenIn as `0x${string}`, amountIn: a };
    }
    if (fn === 'swapPercent') {
      const percentBps = args[2] as bigint | number;
      const p = typeof percentBps === 'bigint' ? percentBps : BigInt(percentBps as any);
      return { kind: 'swapPercent' as const, tokenIn: tokenIn as `0x${string}`, percentBps: p };
    }
    return null;
  } catch {
    return null;
  }
};

const extractRevertReasonFromText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const directPatterns = [
    /ERC20:[^\n]{0,160}insufficient allowance[^\n]{0,80}/i,
    /ERC20:[^\n]{0,160}insufficient balance[^\n]{0,80}/i,
    /insufficient allowance/i,
    /insufficient balance/i,
  ];
  for (const re of directPatterns) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const g = (m[0] ?? '').trim();
    if (g) return g;
  }
  const hexes = trimmed.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
  for (const h of hexes) {
    const decoded = decodeRevertDataToReason(h);
    if (decoded) return decoded;
  }
  const patterns = [
    /Fail with error\s+'([^']+)'/i,
    /reverted with reason string\s+'([^']+)'/i,
    /execution reverted(?::\s*([^\n]+))?/i,
    /revert(?:ed)?(?::\s*([^\n]+))?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(trimmed);
    if (!m) continue;
    const g = (m[1] ?? '').trim();
    if (g && !/^0x[0-9a-f]*$/i.test(g)) return g;
  }
  return null;
};

const collectErrorTexts = (e: any) => {
  const seen = new Set<any>();
  const texts: string[] = [];
  const visit = (err: any, depth: number) => {
    if (!err || depth > 4) return;
    if (seen.has(err)) return;
    seen.add(err);
    const push = (s: any) => {
      if (typeof s !== 'string') return;
      const t = s.trim();
      if (!t) return;
      texts.push(t);
    };
    if (Array.isArray(err?.metaMessages)) {
      for (const x of err.metaMessages) push(x);
    }
    push(err?.details);
    push(err?.shortMessage);
    push(err?.message);
    push(err?.data);
    const cause = err?.cause;
    if (cause) visit(cause, depth + 1);
  };
  visit(e as any, 0);
  return texts;
};

export const extractRevertReasonFromError = (e: any) => {
  const texts = collectErrorTexts(e);

  const reasons: string[] = [];
  for (const s of texts) {
    const reason = extractRevertReasonFromText(s);
    if (reason) reasons.push(reason);
    const decoded = decodeRevertDataToReason(s);
    if (decoded) reasons.push(decoded);
  }

  if (!reasons.length) return null;

  let best = reasons[0];
  let bestScore = scoreRevertReason(best);
  for (const r of reasons.slice(1)) {
    const s = scoreRevertReason(r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }

  return best;
};

export const serializeTxError = (e: any) => {
  const err = e as any;
  const cause = err?.cause as any;
  const metaMessages = Array.isArray(err?.metaMessages) ? err.metaMessages.filter((x: any) => typeof x === 'string') : [];
  const message = typeof err?.message === 'string' ? err.message : String(err);
  const shortMessage = typeof err?.shortMessage === 'string' ? err.shortMessage : undefined;
  const details = typeof err?.details === 'string' ? err.details : undefined;
  const code = cause?.code ?? err?.code;
  const data = cause?.data ?? err?.data;
  return {
    name: typeof err?.name === 'string' ? err.name : undefined,
    message,
    shortMessage,
    details,
    meta: metaMessages.length ? metaMessages : undefined,
    cause: cause?.message ? String(cause.message) : undefined,
    code: code != null ? (typeof code === 'string' || typeof code === 'number' ? code : String(code)) : undefined,
    data,
  };
};

export const debugLogTxError = (tag: string, e: any, extra?: Record<string, unknown>) => {
  const texts = collectErrorTexts(e);
  const reasons: string[] = [];
  for (const s of texts) {
    const reason = extractRevertReasonFromText(s);
    if (reason) reasons.push(reason);
    const decoded = decodeRevertDataToReason(s);
    if (decoded) reasons.push(decoded);
  }
  const uniqueReasons = Array.from(new Set(reasons));
  const scored = uniqueReasons
    .map((r) => ({ reason: r, score: scoreRevertReason(r) }))
    .sort((a, b) => b.score - a.score);

  console.error(tag, {
    ...extra,
    parsedBest: scored[0]?.reason,
    parsedAll: scored,
    raw: serializeTxError(e),
    rawTexts: texts,
  });
};

const tryGetTxFailureReasonByAuthorization = async (client: any, bn: bigint, tx: any) => {
  const decoded = tryDecodeSwapInput(tx?.input);
  if (!decoded) return null;
  const tokenInLower = decoded.tokenIn.toLowerCase();
  if (tokenInLower === '0x0000000000000000000000000000000000000000') return null;
  try {
    const [balance, allowanceToRouter] = await Promise.all([
      client.readContract({
        address: decoded.tokenIn,
        abi: erc20AbiLite,
        functionName: 'balanceOf',
        args: [tx.from],
        blockNumber: bn,
      }) as Promise<bigint>,
      client.readContract({
        address: decoded.tokenIn,
        abi: erc20AbiLite,
        functionName: 'allowance',
        args: [tx.from, tx.to],
        blockNumber: bn,
      }) as Promise<bigint>,
    ]);
    const requiredAmountIn = decoded.kind === 'swap' ? decoded.amountIn : (balance * decoded.percentBps) / 10000n;
    if (requiredAmountIn <= 0n) return 'ZERO_INPUT';
    if (allowanceToRouter < requiredAmountIn) return 'ERC20: insufficient allowance';
    if (balance < requiredAmountIn) return 'ERC20: insufficient balance';
    return null;
  } catch {
    return null;
  }
};

export const tryGetReceiptRevertReason = async (client: any, hash: `0x${string}`, bn: bigint) => {
  let tx: any;
  try {
    tx = await client.getTransaction({ hash });
  } catch {
    return null;
  }
  if (!tx?.to || !tx?.input) return null;
  return await tryGetTxFailureReasonByAuthorization(client, bn, tx);
};
