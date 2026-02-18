'use client';

import { useState } from 'react';
import { Pickticket } from '@/types/pickticket';
import { isPTDefunct } from '@/lib/utils';

interface PTDetailsProps {
    pt: Omit<Pickticket, 'id'> | any;
    onClose: () => void;
    mostRecentSync?: Date | null;
}

export default function PTDetails({ pt, onClose, mostRecentSync }: PTDetailsProps) {
    const isCompiled = pt.compiled_with && pt.compiled_with.length > 0;
    const allPTs = isCompiled ? [pt, ...pt.compiled_with] : [pt];
    const [selectedTabIndex, setSelectedTabIndex] = useState(0);
    const displayPT = allPTs[selectedTabIndex];

    const statusInfo = getStatusInfo(displayPT);
    const isDefunct = isPTDefunct(displayPT, mostRecentSync);

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[60] p-4">
            <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="flex justify-between items-start mb-4 gap-4">
                    <div className="flex-1">
                        <h2 className="text-xl md:text-2xl font-bold break-all">PT #{displayPT.pt_number}</h2>
                        <p className="text-xs md:text-sm text-gray-400 break-all">PO: {displayPT.po_number}</p>
                        {isCompiled && (
                            <div className="bg-orange-600 px-3 py-1 rounded font-bold text-sm inline-block mt-2">
                                COMPILED PALLET
                            </div>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="text-3xl md:text-4xl hover:text-red-500 flex-shrink-0"
                    >
                        &times;
                    </button>
                </div>

                {/* Tabs for Compiled PTs */}
                {isCompiled && (
                    <div className="mb-4 border-b-2 border-orange-500">
                        <div className="flex gap-2 overflow-x-auto pb-2">
                            {allPTs.map((tabPT: any, index: number) => (
                                <button
                                    key={index}
                                    onClick={() => setSelectedTabIndex(index)}
                                    className={`px-3 py-2 rounded-t-lg font-semibold text-sm whitespace-nowrap transition-colors ${selectedTabIndex === index
                                            ? 'bg-orange-600 text-white'
                                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                                        }`}
                                >
                                    PT #{tabPT.pt_number}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Details Grid */}
                <div className="grid grid-cols-2 gap-4">
                    {/* Customer */}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Customer</div>
                        <div className="text-base md:text-lg font-bold break-all">{displayPT.customer}</div>
                    </div>

                    {/* Store/DC */}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Store/DC</div>
                        <div className="text-base md:text-lg break-all">{displayPT.store_dc}</div>
                    </div>

                    {/* Container */}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Container</div>
                        <div className="text-base md:text-lg break-all">{displayPT.container_number}</div>
                    </div>

                    {/* Location OR DEFUNCT */}
                    <div className="col-span-2">
                        <div className="text-xs md:text-sm text-gray-400">
                            {isDefunct ? 'Status' : 'Location'}
                        </div>
                        {isDefunct ? (
                            <div className="bg-red-600 px-4 py-2 rounded-lg font-bold text-white inline-block text-xl">
                                DEFUNCT
                            </div>
                        ) : (
                            <div className="text-base md:text-lg font-bold">
                                {displayPT.assigned_lane ? `Lane ${displayPT.assigned_lane}` : 'Not Assigned'}
                            </div>
                        )}
                    </div>

                    {/* Pallet Count */}
                    {displayPT.actual_pallet_count && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">
                                {isCompiled ? 'Compiled Pallet(s)' : 'Pallets'}
                            </div>
                            <div className="font-bold text-purple-400">{displayPT.actual_pallet_count}</div>
                        </div>
                    )}

                    {/* Status */}
                    {!isDefunct &&
                        <div className="col-span-2">
                            <div className="text-xs md:text-sm text-gray-400">Status</div>
                            <div className={`inline-block px-3 py-1 rounded-lg font-bold text-sm ${statusInfo.color}`}>
                                {statusInfo.label}
                            </div>
                        </div>
                    }

                    {/* Start Date */}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Start Date</div>
                        <div className="text-base md:text-lg">{new Date(displayPT.start_date).toLocaleDateString()}</div>
                    </div>

                    {/* Cancel Date */}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Cancel Date</div>
                        <div className="text-base md:text-lg">{new Date(displayPT.cancel_date).toLocaleDateString()}</div>
                    </div>

                    {/* CTN */}
                    {displayPT.ctn && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">CTN</div>
                            <div className="text-base md:text-lg break-all">{displayPT.ctn}</div>
                        </div>
                    )}

                    {/* QTY */}
                    {displayPT.qty && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">Quantity</div>
                            <div className="text-base md:text-lg">{displayPT.qty}</div>
                        </div>
                    )}

                    {/* PU Number */}
                    {displayPT.pu_number && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">PU Number</div>
                            <div className="text-base md:text-lg">{displayPT.pu_number}</div>
                        </div>
                    )}

                    {/* Last Synced */}
                    {displayPT.last_synced_at && (
                        <div className="col-span-2">
                            <div className="text-xs md:text-sm text-gray-400">Last Synced</div>
                            <div className="text-sm md:text-base text-gray-300">
                                {new Date(displayPT.last_synced_at).toLocaleString()}
                                {isArchived(displayPT.last_synced_at) && (
                                    <span className="ml-2 bg-yellow-600 px-2 py-0.5 rounded text-xs font-bold">
                                        ARCHIVED
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function getStatusInfo(pt: any): { label: string; color: string } {
    if (!pt.status) return { label: 'Unknown', color: 'bg-gray-600' };

    // Sample workflow statuses
    if (pt.customer === 'PAPER') {
        if (pt.sample_shipped) return { label: 'Sample Shipped', color: 'bg-green-600' };
        if (pt.sample_labeled) return { label: 'Sample Labeled', color: 'bg-blue-600' };
        if (pt.sample_checked) return { label: 'Sample Checked', color: 'bg-yellow-600' };
        return { label: 'Sample Pending', color: 'bg-gray-600' };
    }

    // Regular PT statuses
    const statusMap: { [key: string]: { label: string; color: string } } = {
        shipped: { label: 'Shipped', color: 'bg-green-600' },
        ready_to_ship: { label: 'Ready to Ship', color: 'bg-green-600' },
        staged: { label: 'Staged', color: 'bg-blue-600' },
        labeled: { label: 'Labeled', color: 'bg-yellow-600' },
        unlabeled: { label: 'Unlabeled', color: 'bg-gray-600' }
    };

    return statusMap[pt.status] || { label: pt.status, color: 'bg-gray-600' };
}

function isArchived(lastSyncedAt: string): boolean {
    const syncDate = new Date(lastSyncedAt);
    const daysSinceSync = (Date.now() - syncDate.getTime()) / (1000 * 60 * 60 * 24);
    return daysSinceSync > 7;
}