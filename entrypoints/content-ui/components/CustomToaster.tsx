import { Toaster, ToastBar, toast, type ToastPosition } from 'react-hot-toast';
import { X } from 'lucide-react';

const baseToastStyle = '!bg-[#18181b] !text-zinc-100 !border !shadow-lg !rounded-lg !text-xs !font-medium !max-w-[300px] !p-2';

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
        className: `${baseToastStyle} !border-zinc-800 !shadow-black/50`,
        success: {
          iconTheme: {
            primary: '#10b981', // emerald-500
            secondary: '#064e3b', // emerald-900
          },
          // Distinct success style: Green border + slight green glow
          className: `${baseToastStyle} !border-emerald-500 !shadow-emerald-500/20`,
        },
        error: {
          iconTheme: {
            primary: '#f43f5e', // rose-500
            secondary: '#881337', // rose-900
          },
          // Distinct error style: Red border + slight red glow
          className: `${baseToastStyle} !border-rose-500 !shadow-rose-500/20`,
        },
      }}
    >
        {(t) => (
            <ToastBar toast={t} style={{
                padding: 0,
                background: 'transparent',
                boxShadow: 'none',
                color: 'inherit',
            }}>
                {({ icon, message }) => (
                    <div className="flex items-center gap-2 w-full">
                        <div className="flex-shrink-0">
                            {icon}
                        </div>
                        <div className="flex-1 break-all leading-tight">
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
                                className="flex-shrink-0 ml-2 text-zinc-500 hover:text-zinc-300 transition-colors p-0.5 rounded hover:bg-zinc-800 cursor-pointer pointer-events-auto relative z-50"
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
