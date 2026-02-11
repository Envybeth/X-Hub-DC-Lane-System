'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

interface EditModalProps {
  onClose: () => void;
}

export default function EditModal({ onClose }: EditModalProps) {
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [clearing, setClearing] = useState(false);

  async function handleClearAll() {
    if (deleteConfirmText !== 'DELETE') {
      alert('❌ You must type DELETE (all caps) to confirm');
      return;
    }

    setClearing(true);

    try {
      // Clear all lane assignments
      const { error: assignError } = await supabase
        .from('lane_assignments')
        .delete()
        .neq('id', 0); // This deletes all rows

      if (assignError) throw assignError;

      // Reset all picktickets
      const { error: ptError } = await supabase
        .from('picktickets')
        .update({
          assigned_lane: null,
          actual_pallet_count: null,
          status: 'unlabeled'
        })
        .neq('id', 0); // This updates all rows

      if (ptError) throw ptError;

      alert('✅ All lane assignments cleared successfully!');
      setShowClearConfirm(false);
      setDeleteConfirmText('');
      onClose();
      window.location.reload(); // Refresh to show updated lanes
      
    } catch (error) {
      console.error('Error clearing data:', error);
      alert('❌ Failed to clear data');
    }

    setClearing(false);
  }

  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleClearAll();
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg p-8 max-w-2xl w-full">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold">Edit Options</h2>
          <button onClick={onClose} className="text-4xl hover:text-red-500">&times;</button>
        </div>

        {!showClearConfirm ? (
          <div className="space-y-4">
            {/* Clear All Button */}
            <button
              onClick={() => setShowClearConfirm(true)}
              className="w-full bg-red-600 hover:bg-red-700 p-6 rounded-lg text-xl font-bold"
            >
              🗑️ Clear All Lane Assignments
            </button>

            <div className="text-gray-400 text-sm text-center">
              More edit options coming soon...
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-red-900 border-2 border-red-500 p-6 rounded-lg">
              <h3 className="text-2xl font-bold text-red-400 mb-4">⚠️ WARNING</h3>
              <p className="text-lg mb-4">
                This will permanently delete ALL lane assignments and reset all picktickets to unassigned status.
              </p>
              <p className="text-lg font-bold">
                This action cannot be undone!
              </p>
            </div>

            <div>
              <label className="block text-lg font-semibold mb-2">
                Type <span className="text-red-400 font-mono">DELETE</span> to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type DELETE (all caps)"
                className="w-full bg-gray-700 text-white p-3 rounded-lg text-lg font-mono"
                autoFocus
              />
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => {
                  setShowClearConfirm(false);
                  setDeleteConfirmText('');
                }}
                className="flex-1 bg-gray-600 hover:bg-gray-700 p-4 rounded-lg text-lg font-bold"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAll}
                disabled={clearing || deleteConfirmText !== 'DELETE'}
                className="flex-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed p-4 rounded-lg text-lg font-bold"
              >
                {clearing ? 'Clearing...' : 'Confirm Clear All'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}