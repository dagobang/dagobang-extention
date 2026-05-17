export type QuickBuyCleanup = () => void;

export function setupGmgnQuickBuyButtons(): QuickBuyCleanup {
  const CARD_SELECTOR = 'div[href*="/token/0x"]';
  const CONTAINER_CLASS = 'dagobang-quickbuy-container';
  const COOKING_BADGE_CLASS = 'dagobang-quickcooking-corner';
  const isQuickCookingEnabled = () => (window as any).__DAGOBANG_SETTINGS__?.ui?.quickCookingEnabled === true;

  const getCardTokenMeta = (card: HTMLElement) => {
    const href = card.getAttribute('href') || '';
    const parts = href.split('/').filter(Boolean);
    if (parts.length < 3 || parts[1] !== 'token') return null;
    const chain = String(parts[0] || '').trim().toLowerCase();
    const tokenAddress = String(parts[2] || '').trim();
    if (!chain || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return null;
    return { chain, tokenAddress };
  };

  const bindHover = (wrapper: HTMLDivElement, button: HTMLDivElement) => {
    wrapper.addEventListener('mouseenter', () => {
      wrapper.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.12)';
      button.style.backgroundColor = 'rgba(255,255,255,0.06)';
    });

    wrapper.addEventListener('mouseleave', () => {
      wrapper.style.boxShadow = '';
      button.style.backgroundColor = 'transparent';
    });
  };

  const makeQuickBuyButton = (tokenAddress: string, amount: string) => {
    const wrapper = document.createElement('div');
    wrapper.className =
      'pointer-events-auto relative !w-full !h-full !box-border rounded-[6px] border group-btns max-w-[200px] transition-all duration-[150ms] ease-in-out BuyButton-continer';
    wrapper.style.borderColor = 'rgb(var(--color-primary) / 0.08)';

    const button = document.createElement('div');
    button.className =
      'text-primary rounded-[6px] bg-btn-secondary-buy py-1.5 px-3 text-base font-semibold flex items-center gap-1 whitespace-nowrap justify-center cursor-pointer text-primary min-w-12 QuickBuy_btnForLoading__GcvLL !h-[28px] !px-[6px] !leading-[12px] !text-[12px] rounded-6px !h-full !bg-transparent !hover:bg-transparent !justify-end !text-[var(--customize-button2-ultra-color)] hover:!text-[var(--customize-button2-ultra-color)] !items-end !pl-[8px]';
    button.innerHTML = `<span class="mb-[40px]">${amount} BNB</span>`;
    bindHover(wrapper, button);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('dagobang-quickbuy', {
          detail: {
            tokenAddress,
            amountBnb: amount,
          },
        }),
      );
    });
    wrapper.appendChild(button);
    return wrapper;
  };

  const makeQuickCookingButton = (chain: string, tokenAddress: string) => {
    const wrapper = document.createElement('div');
    wrapper.className = `${COOKING_BADGE_CLASS} pointer-events-auto absolute right-0 top-0 z-30`;
    wrapper.style.width = '44px';
    wrapper.style.height = '44px';
    wrapper.style.opacity = '0';
    wrapper.style.transform = 'translate(6px, -6px) scale(0.92)';
    wrapper.style.transition = 'opacity 160ms ease, transform 160ms ease, filter 160ms ease';
    wrapper.style.filter = 'drop-shadow(0 0 0 rgba(251,191,36,0))';
    wrapper.title = 'Quick Cooking';

    const button = document.createElement('div');
    button.className = 'cursor-pointer';
    button.style.width = '100%';
    button.style.height = '100%';
    button.style.display = 'flex';
    button.style.alignItems = 'flex-start';
    button.style.justifyContent = 'flex-end';
    button.style.paddingTop = '4px';
    button.style.paddingRight = '4px';
    button.style.color = '#fbbf24';
    button.style.background = 'linear-gradient(135deg, rgba(251,191,36,0.98) 0%, rgba(245,158,11,0.96) 100%)';
    button.style.clipPath = 'polygon(0 0, 100% 0, 100% 100%)';
    button.style.setProperty('-webkit-clip-path', 'polygon(0 0, 100% 0, 100% 100%)');
    button.style.borderTopRightRadius = '2px';
    button.style.boxShadow = '0 0 0 1px rgba(250,204,21,0.58), 0 10px 22px rgba(245,158,11,0.3)';
    button.title = 'Quick Cooking';
    button.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 16.5c-1.5 1.5-1.5 4 0 4 1.5 0 3-2.5 3-4 0-1-1-1-1-1-.5 0-1.5 0-2 .5Z" stroke="#111111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m12 15-3-3a21.9 21.9 0 0 1 7.2-8.6 2 2 0 0 1 2.5.2 2 2 0 0 1 .2 2.5A21.9 21.9 0 0 1 12 15Z" stroke="#111111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9 12H4.5a1.5 1.5 0 0 1-1.2-2.4 14.5 14.5 0 0 1 3.4-3.4A1.5 1.5 0 0 1 9 7.5Z" stroke="#111111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M12 15v4.5a1.5 1.5 0 0 0 2.4 1.2 14.5 14.5 0 0 0 3.4-3.4 1.5 1.5 0 0 0-1.2-2.4Z" stroke="#111111" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="15" cy="9" r="1.1" fill="#111111"/>
      </svg>
    `;
    wrapper.addEventListener('mouseenter', () => {
      wrapper.style.filter = 'drop-shadow(0 4px 10px rgba(245,158,11,0.38))';
      button.style.transform = 'scale(1.03)';
    });
    wrapper.addEventListener('mouseleave', () => {
      wrapper.style.filter = 'drop-shadow(0 0 0 rgba(251,191,36,0))';
      button.style.transform = 'scale(1)';
    });
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('dagobang-quickcooking', {
          detail: {
            chain,
            tokenAddress,
            platform: 'gmgn',
          },
        }),
      );
    });
    wrapper.appendChild(button);
    return wrapper;
  };

  const injectButtons = () => {
    const cards = document.querySelectorAll<HTMLElement>(CARD_SELECTOR);
    cards.forEach((card) => {
      const existingContainer = card.querySelector(`.${CONTAINER_CLASS}`);
      const existingCookingBadge = card.querySelector(`.${COOKING_BADGE_CLASS}`);
      const tokenMeta = getCardTokenMeta(card);
      if (!tokenMeta) {
        existingCookingBadge?.remove();
        return;
      }
      if (window.getComputedStyle(card).position === 'static') {
        card.style.position = 'relative';
      }

      if (!existingContainer) {
        const container = document.createElement('div');
        container.className =
          `${CONTAINER_CLASS} absolute flex right-14px gap-4px items-center z-20 overflow-visible flex-shrink-0 font-medium pointer-events-none h-full min-w-[30%] !right-0 !bottom-0 pr-1 !w-[auto] min-w-[40%]`;
        container.style.bottom = '10px';

        const inner = document.createElement('div');
        inner.className = 'flex w-full h-full justify-end items-end gap-[4px] pointer-events-auto';

        const quick1 = (window as any).__DAGOBANG_SETTINGS__?.quickBuy1Bnb;
        const quick2 = (window as any).__DAGOBANG_SETTINGS__?.quickBuy2Bnb;
        if (Number(quick1) > 0) inner.appendChild(makeQuickBuyButton(tokenMeta.tokenAddress, quick1));
        if (Number(quick2) > 0) inner.appendChild(makeQuickBuyButton(tokenMeta.tokenAddress, quick2));

        container.appendChild(inner);
        card.appendChild(container);
      }

      if (!isQuickCookingEnabled()) {
        existingCookingBadge?.remove();
        return;
      }
      if (existingCookingBadge) return;

      const cookingBadge = makeQuickCookingButton(tokenMeta.chain, tokenMeta.tokenAddress);
      card.appendChild(cookingBadge);
      card.addEventListener('mouseenter', () => {
        cookingBadge.style.opacity = '1';
        cookingBadge.style.transform = 'translate(0, 0) scale(1)';
      });
      card.addEventListener('mouseleave', () => {
        cookingBadge.style.opacity = '0';
        cookingBadge.style.transform = 'translate(6px, -6px) scale(0.92)';
      });
    });
  };

  const observer = new MutationObserver(() => {
    injectButtons();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    injectButtons();
  } else {
    const onReady = () => {
      window.removeEventListener('DOMContentLoaded', onReady);
      if (!document.body) return;
      observer.observe(document.body, { childList: true, subtree: true });
      injectButtons();
    };
    window.addEventListener('DOMContentLoaded', onReady);
  }

  return () => {
    observer.disconnect();
  };
}
