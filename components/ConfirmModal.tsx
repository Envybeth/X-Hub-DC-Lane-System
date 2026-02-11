'use client';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel'
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[100]">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border-2 border-gray-600">
        <h3 className="text-xl font-bold mb-3">{title}</h3>
        <p className="text-gray-300 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="bg-gray-600 hover:bg-gray-700 px-6 py-2 rounded-lg font-semibold"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-semibold"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}