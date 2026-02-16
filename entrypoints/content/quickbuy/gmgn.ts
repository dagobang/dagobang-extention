export type QuickBuyCleanup = () => void;

export function setupGmgnQuickBuyButtons(): QuickBuyCleanup {
    const injectButtons = () => {
        const cards = document.querySelectorAll<HTMLElement>('div[href^="/bsc/token/0x"]');
        cards.forEach((card) => {
            if (card.querySelector('.dagobang-quickbuy-container')) return;
            const href = card.getAttribute('href') || '';
            const parts = href.split('/');
            const tokenAddress = parts[parts.length - 1];
            if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return;

            const container = document.createElement('div');
            container.className =
                'dagobang-quickbuy-container absolute flex right-14px gap-4px items-center z-20 overflow-visible flex-shrink-0 font-medium pointer-events-none h-full min-w-[30%] !right-0 !bottom-0 pr-1 !w-[auto] min-w-[40%]';
            container.style.bottom = '10px';

            const inner = document.createElement('div');
            inner.className = 'flex w-full h-full justify-end items-end gap-[4px] pointer-events-auto';

            const makeButton = (amount: string, primary: boolean) => {
                const wrapper = document.createElement('div');
                wrapper.className =
                    'pointer-events-auto relative !w-full !h-full !box-border rounded-[6px] border group-btns max-w-[200px] transition-all duration-[150ms] ease-in-out BuyButton-continer';
                wrapper.style.borderColor = primary
                    ? 'rgb(var(--color-primary) / 0.08)'
                    : 'rgb(var(--color-primary) / 0.08)';

                const button = document.createElement('div');
                button.className =
                    'text-primary rounded-[6px] bg-btn-secondary-buy py-1.5 px-3 text-base font-semibold flex items-center gap-1 whitespace-nowrap justify-center cursor-pointer text-primary min-w-12 QuickBuy_btnForLoading__GcvLL !h-[28px] !px-[6px] !leading-[12px] !text-[12px] rounded-6px !h-full !bg-transparent !hover:bg-transparent !justify-end !text-[var(--customize-button2-ultra-color)] hover:!text-[var(--customize-button2-ultra-color)] !items-end !pl-[8px]';
                button.innerHTML = `<span class="mb-[40px]">${amount} BNB</span>`;

                wrapper.addEventListener('mouseenter', () => {
                    wrapper.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.12)';
                    button.style.backgroundColor = 'rgba(255,255,255,0.06)';
                });

                wrapper.addEventListener('mouseleave', () => {
                    wrapper.style.boxShadow = '';
                    button.style.backgroundColor = 'transparent';
                });

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

            const quick1 = (window as any).__DAGOBANG_SETTINGS__?.quickBuy1Bnb;
            const quick2 = (window as any).__DAGOBANG_SETTINGS__?.quickBuy2Bnb;

            if (Number(quick1) > 0) inner.appendChild(makeButton(quick1, true));
            if (Number(quick2) > 0) inner.appendChild(makeButton(quick2, false));
            container.appendChild(inner);
            card.appendChild(container);
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

