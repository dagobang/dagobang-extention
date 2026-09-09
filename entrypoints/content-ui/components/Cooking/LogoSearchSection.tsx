import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';
import type { LogoSearchImage, LogoSearchTab } from './types';

type LogoSearchSectionProps = {
  googleQuery: string;
  onGoogleQueryChange: (value: string) => void;
  logoSearchActive: boolean;
  onLogoSearchFocus: () => void;
  logoSearchTab: LogoSearchTab;
  onLogoSearchTabChange: (tab: LogoSearchTab) => void;
  currentSearchImages: LogoSearchImage[];
  currentSearchLoading: boolean;
  googleSearching: boolean;
  googleImagesLength: number;
  googlePage: number;
  onSearchByActiveTab: () => void;
  onSearchGoogleMore: (page: number) => void;
  onPickLocalLogo: () => void;
  localImageInputRef: RefObject<HTMLInputElement | null>;
  onLocalLogoChange: (e: ChangeEvent<HTMLInputElement>) => void;
  logoUrl: string;
  onLogoUrlChange: (value: string) => void;
  logoResolving: boolean;
  logoResolveError: string | null;
  resolvedLogoDataUrl: string;
  onSelectImage: (url: string) => void;
};

export function LogoSearchSection({
  googleQuery,
  onGoogleQueryChange,
  logoSearchActive,
  onLogoSearchFocus,
  logoSearchTab,
  onLogoSearchTabChange,
  currentSearchImages,
  currentSearchLoading,
  googleSearching,
  googleImagesLength,
  googlePage,
  onSearchByActiveTab,
  onSearchGoogleMore,
  onPickLocalLogo,
  localImageInputRef,
  onLocalLogoChange,
  logoUrl,
  onLogoUrlChange,
  logoResolving,
  logoResolveError,
  resolvedLogoDataUrl,
  onSelectImage,
}: LogoSearchSectionProps) {
  const handleSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key !== 'Enter' && e.code !== 'Enter') || (e.nativeEvent as any)?.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-sky-200">图片</div>
      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">搜索图片</div>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={googleQuery}
            onChange={(e) => onGoogleQueryChange(e.target.value)}
            onFocus={onLogoSearchFocus}
            onKeyDown={handleSearchKey}
            onKeyUp={(e) => {
              handleSearchKey(e);
              if ((e.key !== 'Enter' && e.code !== 'Enter') || (e.nativeEvent as any)?.isComposing) return;
              onSearchByActiveTab();
            }}
            placeholder="输入关键词搜索图片"
          />
          <button
            type="button"
            className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500"
            onClick={onSearchByActiveTab}
            disabled={currentSearchLoading}
          >
            搜索
          </button>
          {logoSearchTab === 'google' && (
            <button
              type="button"
              className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
              onClick={() => onSearchGoogleMore(googlePage + 1)}
              disabled={googleSearching || !googleImagesLength}
            >
              更多
            </button>
          )}
        </div>
        {logoSearchActive && (
          <div className="flex items-center gap-2 text-[11px] text-zinc-300">
            <button
              type="button"
              className={`rounded px-2 py-0.5 ${logoSearchTab === 'token' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              onClick={() => onLogoSearchTabChange('token')}
            >
              代币
            </button>
            <button
              type="button"
              className={`rounded px-2 py-0.5 ${logoSearchTab === 'google' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              onClick={() => onLogoSearchTabChange('google')}
            >
              Google
            </button>
          </div>
        )}
        {currentSearchImages.length > 0 && (
          <div className="grid grid-cols-4 gap-2 max-h-40 overflow-auto pr-1">
            {currentSearchImages.map((item, idx) => (
              <button
                key={`${item.url}-${idx}`}
                type="button"
                className="h-16 rounded-md overflow-hidden border border-zinc-800 hover:border-emerald-500"
                onClick={() => onSelectImage(item.url)}
                title={item.title || item.url}
              >
                <img src={item.thumbnail || item.url} alt={item.title || 'img'} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">Logo 链接</div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:border-zinc-500"
            onClick={onPickLocalLogo}
          >
            上传本地图片
          </button>
          <input
            ref={localImageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            className="hidden"
            onChange={onLocalLogoChange}
          />
          <span className="text-[10px] text-zinc-500">支持 PNG/JPG/WEBP/GIF，≤5MB</span>
        </div>
        <input
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
          value={logoUrl}
          onChange={(e) => onLogoUrlChange(e.target.value)}
          placeholder="可手动粘贴图片地址"
        />
        {(logoResolving || logoResolveError || resolvedLogoDataUrl) && (
          <div className={`text-[10px] ${logoResolveError ? 'text-amber-300' : 'text-zinc-500'}`}>
            {logoResolving
              ? '图片预处理中...'
              : logoResolveError
                ? `图片预处理失败，将在提交时回退原地址：${logoResolveError}`
                : '图片已预处理，提交时可直接复用'}
          </div>
        )}
        {logoUrl && (
          <div className="mt-2 flex items-center gap-2">
            <div className="w-10 h-10 rounded-full border border-zinc-800 bg-zinc-950 overflow-hidden flex items-center justify-center">
              <img src={logoUrl} alt="Logo" className="max-w-full max-h-full" />
            </div>
            <div className="text-[11px] text-zinc-500 break-all">
              预览
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
