type TokenMetaFormProps = {
  isOpenFour: boolean;
  tokenSymbolInput: string;
  onTokenSymbolChange: (value: string) => void;
  tokenNameInput: string;
  onTokenNameChange: (value: string) => void;
  tokenDescInput: string;
  onTokenDescChange: (value: string) => void;
  twitterInput: string;
  onTwitterChange: (value: string) => void;
  websiteInput: string;
  onWebsiteChange: (value: string) => void;
  telegramInput: string;
  onTelegramChange: (value: string) => void;
};

export function TokenMetaForm({
  isOpenFour,
  tokenSymbolInput,
  onTokenSymbolChange,
  tokenNameInput,
  onTokenNameChange,
  tokenDescInput,
  onTokenDescChange,
  twitterInput,
  onTwitterChange,
  websiteInput,
  onWebsiteChange,
  telegramInput,
  onTelegramChange,
}: TokenMetaFormProps) {
  return (
    <div className="space-y-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-violet-200">代币信息</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-400">{isOpenFour ? '股票代码 / 符号' : '代币符号'}</div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={tokenSymbolInput}
            onChange={(e) => onTokenSymbolChange(e.target.value)}
            placeholder={isOpenFour ? '如 4Stock' : '如 DGB'}
          />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-400">代币名称</div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={tokenNameInput}
            onChange={(e) => onTokenNameChange(e.target.value)}
            placeholder={isOpenFour ? '如 4Stock' : '如 Dagobang'}
          />
        </div>
      </div>

      {isOpenFour && (
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-400">描述</div>
          <textarea
            className="min-h-[72px] w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={tokenDescInput}
            onChange={(e) => onTokenDescChange(e.target.value)}
            placeholder="OpenFour 创建接口必填描述"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-400">推特{isOpenFour ? '（选填）' : ''}</div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={twitterInput}
            onChange={(e) => onTwitterChange(e.target.value)}
            placeholder="https://twitter.com/..."
          />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-400">官网{isOpenFour ? '（选填）' : ''}</div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={websiteInput}
            onChange={(e) => onWebsiteChange(e.target.value)}
            placeholder="https://..."
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">电报{isOpenFour ? '（选填）' : ''}</div>
        <input
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
          value={telegramInput}
          onChange={(e) => onTelegramChange(e.target.value)}
          placeholder="https://t.me/..."
        />
      </div>
    </div>
  );
}
