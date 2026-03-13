'use client';

import { compareTextNumeric } from '@/lib/compiledPalletDisplay';

type CompiledPalletVerificationItem = {
  id: number;
  ptNumber: string;
  poNumber: string;
};

type CompiledPalletVerificationModalProps = {
  isOpen: boolean;
  items: CompiledPalletVerificationItem[];
  value: string;
  error?: string | null;
  title?: string;
  description?: string;
  placeholder?: string;
  confirmLabel?: string;
  zIndexClass?: string;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

export default function CompiledPalletVerificationModal({
  isOpen,
  items,
  value,
  error,
  title = 'Stage Compiled Pallet',
  description = 'OCR is skipped for compiled pallets. Enter any PT or PO from this group to stage all PTs together.',
  placeholder = 'Enter any PT or PO from this group',
  confirmLabel = 'Verify & Stage All',
  zIndexClass = 'z-[105]',
  onValueChange,
  onConfirm,
  onClose
}: CompiledPalletVerificationModalProps) {
  if (!isOpen) return null;

  const sortedItems = [...items].sort((left, right) => compareTextNumeric(left.ptNumber, right.ptNumber));

  return (
    <div className={`fixed inset-0 bg-black/90 ${zIndexClass} flex items-center justify-center p-4`}>
      <div className="w-full max-w-lg bg-gray-800 border border-orange-500 rounded-xl p-4 md:p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg md:text-xl font-bold text-orange-300">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-2xl leading-none hover:text-red-400"
          >
            &times;
          </button>
        </div>

        <p className="text-sm text-gray-300 mb-3">{description}</p>

        <div className="mb-3 max-h-40 overflow-auto rounded border border-gray-700 bg-gray-900/70 p-2 space-y-1">
          {sortedItems.map((item) => (
            <div key={item.id} className="text-xs md:text-sm text-gray-200">
              PT #{item.ptNumber} | PO {item.poNumber}
            </div>
          ))}
        </div>

        <input
          type="text"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm md:text-base"
          autoFocus
        />

        {error && (
          <div className="text-xs md:text-sm text-red-400 mt-2">{error}</div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 bg-green-600 hover:bg-green-700 px-3 py-2 rounded-lg font-semibold text-sm md:text-base"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 bg-gray-600 hover:bg-gray-700 px-3 py-2 rounded-lg font-semibold text-sm md:text-base"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
