export type QuickBuyCleanup = () => void;

import { setupGmgnQuickBuyButtons } from './gmgn';

export function setupQuickBuyButtonsForCurrentSite(): QuickBuyCleanup {
  const hostname = String(window.location.hostname || '').toLowerCase();
  if (hostname.includes('gmgn.ai')) {
    return setupGmgnQuickBuyButtons();
  }
  return () => {
  };
}
