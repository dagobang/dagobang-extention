import { Toaster, resolveValue, toast, type ToastPosition } from 'react-hot-toast';
import { X } from 'lucide-react';

type CustomToasterProps = {
  position?: ToastPosition;
};

export function CustomToaster({ position = 'top-center' }: CustomToasterProps) {
  const resolveToastVariantClass = (toastClassName: string | undefined, toastType: string) => {
    const custom = String(toastClassName || '').trim();
    if (custom) return custom;
    if (toastType === 'success') return 'border-emerald-400/25 ring-emerald-500/10';
    if (toastType === 'error') return 'border-rose-400/25 ring-rose-500/10';
    return 'border-white/8 ring-white/5';
  };

  return (
    <Toaster
      position={position}
      gutter={8}
      toastOptions={{
        duration: 3000,
        success: {
          iconTheme: {
            primary: '#10b981', // emerald-500
            secondary: '#064e3b', // emerald-900
          },
        },
        error: {
          iconTheme: {
            primary: '#f43f5e', // rose-500
            secondary: '#881337', // rose-900
          },
        },
      }}
    >
        {(t) => (
            <div
                className={`flex items-start gap-2.5 w-[340px] max-w-[calc(100vw-24px)] rounded-2xl border bg-[#101215] px-3.5 py-2.5 text-zinc-100 shadow-[0_16px_40px_rgba(0,0,0,0.38)] ring-1 transition-[border-color,box-shadow,ring-color] duration-150 ease-out pointer-events-auto ${resolveToastVariantClass(t.className, t.type)}`}
            >
                {t.icon ? (
                    <div className="mt-0.5 flex-shrink-0">
                        {t.icon}
                    </div>
                ) : null}
                <div className="flex-1 min-w-0 break-words leading-tight">
                    {resolveValue(t.message, t)}
                </div>
                {t.type !== 'loading' && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toast.dismiss(t.id);
                        }}
                        className="flex-shrink-0 ml-1.5 text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-white/10 cursor-pointer pointer-events-auto relative z-50"
                    >
                        <X size={12} />
                    </button>
                )}
            </div>
        )}
    </Toaster>
  );
}
