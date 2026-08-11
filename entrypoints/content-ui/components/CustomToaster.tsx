import { Toaster, ToastBar, toast, type ToastPosition } from 'react-hot-toast';
import { X } from 'lucide-react';

const baseToastStyle = '!bg-[#101215] !text-zinc-100 !border !rounded-2xl !text-xs !font-medium !max-w-[340px] !p-0 !shadow-[0_16px_40px_rgba(0,0,0,0.38)]';

type CustomToasterProps = {
  position?: ToastPosition;
};

export function CustomToaster({ position = 'top-center' }: CustomToasterProps) {
  return (
    <Toaster
      position={position}
      gutter={8}
      toastOptions={{
        duration: 3000,
        // Default style
        className: `${baseToastStyle} !border-white/8 !shadow-black/40`,
        success: {
          iconTheme: {
            primary: '#10b981', // emerald-500
            secondary: '#064e3b', // emerald-900
          },
          // Distinct success style: Green border + slight green glow
          className: `${baseToastStyle} !border-emerald-400/25 !shadow-[0_16px_40px_rgba(0,0,0,0.38)]`,
        },
        error: {
          iconTheme: {
            primary: '#f43f5e', // rose-500
            secondary: '#881337', // rose-900
          },
          // Distinct error style: Red border + slight red glow
          className: `${baseToastStyle} !border-rose-400/25 !shadow-[0_16px_40px_rgba(0,0,0,0.38)]`,
        },
      }}
    >
        {(t) => (
            <ToastBar toast={t} style={{
                padding: 0,
                background: 'transparent',
                boxShadow: 'none',
                color: 'inherit',
                pointerEvents: 'auto',
            }}>
                {({ icon, message }) => (
                    <div className={`flex items-start gap-3 w-full rounded-2xl border bg-[#101215] px-4 py-3 text-zinc-100 shadow-[0_16px_40px_rgba(0,0,0,0.38)] ring-1 ring-white/5 transition-all duration-300 ease-out pointer-events-auto ${t.className || ''}`}>
                        <div className="mt-0.5 flex-shrink-0">
                            {icon}
                        </div>
                        <div className="flex-1 min-w-0 break-words leading-tight">
                            {message}
                        </div>
                        {t.type !== 'loading' && (
                            <button 
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    toast.dismiss(t.id);
                                }}
                                className="flex-shrink-0 ml-2 text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded-md hover:bg-white/10 cursor-pointer pointer-events-auto relative z-50"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                )}
            </ToastBar>
        )}
    </Toaster>
  );
}
