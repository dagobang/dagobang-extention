import { setupGmgnQuickBuyButtons, type QuickBuyCleanup } from './gmgn';

export type { QuickBuyCleanup };

export function setupQuickBuyButtonsForCurrentSite(): QuickBuyCleanup {
  const host = window.location.hostname;
  if (host.includes('gmgn.ai') && window.location.pathname === '/') {
    return setupGmgnQuickBuyButtons();
  }
  return () => {
  };
}

