'use client';
import { Pickticket } from '@/types/pickticket';
import { isPTDefunct } from '@/lib/utils';


interface PTDetailsProps {
    pt: Omit<Pickticket, 'id'> | any;
    onClose: () => void;
    mostRecentSync?: Date | null;
}

function getStatusInfo(pt: PTDetailsProps['pt']): { label: string; color: string } {
    const status = pt.status || 'unlabeled';

    // Check for sample workflow status
    if (pt.customer === 'PAPER') {
        if (pt.sample_shipped) {
            return { label: 'Sample Shipped', color: 'bg-green-600' };
        }
        if (pt.sample_labeled) {
            return { label: 'Sample Labeled', color: 'bg-blue-600' };
        }
        if (pt.sample_checked) {
            return { label: 'Sample Checked', color: 'bg-yellow-600' };
        }
        return { label: 'Sample Pending', color: 'bg-gray-600' };
    }

    // Regular PT status
    switch (status) {
        case 'shipped':
            return { label: 'Shipped', color: 'bg-gray-600' };
        case 'ready_to_ship':
            return { label: 'Ready to Ship', color: 'bg-green-600' };
        case 'staged':
            return { label: 'Staged', color: 'bg-purple-600' };
        case 'labeled':
            return { label: 'Labeled', color: 'bg-blue-600' };
        default:
            return { label: 'Unlabeled', color: 'bg-gray-600' };
    }
}

function isArchived(lastSynced: string): boolean {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return new Date(lastSynced) < sevenDaysAgo;
}

export default function PTDetails({ pt, onClose, mostRecentSync }: PTDetailsProps) {
    const statusInfo = getStatusInfo(pt);
    const isDefunct = isPTDefunct(pt, mostRecentSync);
    const isCompiled = pt.compiled_with && pt.compiled_with.length > 0;


    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[60] p-4">
            <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-start mb-4 gap-4">
                    <div className="flex-1">
                        <h2 className="text-xl md:text-2xl font-bold break-all">PT #{pt.pt_number}</h2>
                        <p className="text-xs md:text-sm text-gray-400 break-all">PO: {pt.po_number}</p>
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

                <div className="grid grid-cols-2 gap-3 md:gap-4 text-sm md:text-base">
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">PT #</div>
                        <div className="font-bold break-all">{pt.pt_number}</div>
                    </div>
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">PO #</div>
                        <div className="font-bold break-all">{pt.po_number}</div>
                    </div>
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Customer</div>
                        <div className="break-all">{pt.customer}</div>
                    </div>
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">CTN</div>
                        <div className="font-bold break-all">{pt.ctn || 'N/A'}</div>
                    </div>
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">DC #</div>
                        <div className="break-all">{pt.store_dc || 'N/A'}</div>
                    </div>
                    {pt.actual_pallet_count && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">
                                {isCompiled ? 'Compiled Pallet(s)' : 'Pallets'}
                            </div>
                            <div className="font-bold text-purple-400">{pt.actual_pallet_count}</div>
                        </div>
                    )}
                    {isCompiled && (
                        <div className="col-span-2">
                            <div className="text-xs md:text-sm text-gray-400 mb-2">Compiled With:</div>
                            <div className="bg-gray-700 p-3 rounded-lg space-y-2">
                                {pt.compiled_with!.map((compiledPT: any) => (
                                    <div key={compiledPT.id} className="border-l-4 border-orange-500 pl-3">
                                        <div className="font-bold">PT #{compiledPT.pt_number}</div>
                                        <div className="text-sm text-gray-300">PO: {compiledPT.po_number}</div>
                                        <div className="text-xs text-gray-400">{compiledPT.customer}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {pt.qty && (
                        <div>
                            <div className="text-xs md:text-sm text-gray-400">Shipment Qty</div>
                            <div className="font-bold text-purple-400">{pt.qty}</div>
                        </div>
                    )}
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Start Date</div>
                        <div>{pt.start_date || 'N/A'}</div>
                    </div>
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Cancel Date</div>
                        <div>{pt.cancel_date || 'N/A'}</div>
                    </div>
                    <div className="col-span-2">
                        <div className="text-xs md:text-sm text-gray-400">Container</div>
                        <div className="break-all">{pt.container_number}</div>
                    </div>
                    {/* Location OR DEFUNCT */}
                    <div className="col-span-2">
                        <div className="text-xs md:text-sm text-gray-400">
                            {isDefunct && !pt.assigned_lane ? 'Status' : 'Location'}
                        </div>
                        {isDefunct && !pt.assigned_lane ? (
                            <div className="bg-red-600 px-4 py-2 rounded-lg font-bold text-white inline-block text-xl">
                                DEFUNCT
                            </div>
                        ) : (
                            <div className="text-base md:text-2xl text-green-500 font-bold">
                                {pt.assigned_lane ? `Lane ${pt.assigned_lane}` : 'Not Assigned'}
                            </div>
                        )}
                    </div>
                    {!isDefunct &&
                        <div className="col-span-2">
                            <div className="text-xs md:text-sm text-gray-400">Status</div>
                            <div className={`inline-block px-3 py-1 rounded-lg font-bold text-sm ${statusInfo.color}`}>
                                {statusInfo.label}
                            </div>
                        </div>
                    }


                    {pt.last_synced_at && (
                        <div className="col-span-2">
                            <div className="text-xs md:text-sm text-gray-400">Last Synced</div>
                            <div className="text-sm">
                                {new Date(pt.last_synced_at).toLocaleString()}
                                {isArchived(pt.last_synced_at) && (
                                    <span className="ml-2 bg-red-600 px-2 py-1 rounded text-xs">ARCHIVED</span>
                                )}
                            </div>
                        </div>
                    )}

                </div>

                <button
                    onClick={onClose}
                    className="w-full mt-4 md:mt-6 bg-blue-600 hover:bg-blue-700 py-2 md:py-3 rounded-lg font-bold text-sm md:text-lg"
                >
                    Close
                </button>
            </div>
        </div>
    );
}