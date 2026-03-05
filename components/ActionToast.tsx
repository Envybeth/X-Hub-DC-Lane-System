'use client';

type ActionToastType = 'success' | 'error' | 'info';

interface ActionToastProps {
  message: string | null;
  type?: ActionToastType;
  zIndexClass?: string;
}

export default function ActionToast({
  message,
  type = 'success',
  zIndexClass = 'z-[120]'
}: ActionToastProps) {
  if (!message) return null;

  const colorClasses = type === 'success'
    ? 'bg-green-600 text-white'
    : type === 'error'
      ? 'bg-red-600 text-white'
      : 'bg-gray-900 border border-gray-600 text-white';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-4 left-1/2 -translate-x-1/2 ${zIndexClass} px-5 md:px-8 py-3 md:py-4 rounded-xl font-semibold shadow-2xl animate-toast-fade-in-out text-base md:text-lg text-center max-w-[92vw] ${colorClasses}`}
    >
      {message}
    </div>
  );
}
