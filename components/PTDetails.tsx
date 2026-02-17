'use client';

interface PTDetailsProps {
    pt: {
        pt_number: string;
        po_number: string;
        customer: string;
        store_dc: string;
        container_number: string;
        start_date: string;
        cancel_date: string;
        actual_pallet_count: number | null;
        assigned_lane: string | null;
        status?: string;
        qty?: number | null;
        ctn?: string;
        sample_checked?: boolean;
        sample_labeled?: boolean;
        sample_shipped?: boolean;
        last_synced_at?: string;
    };
    onClose: () => void;
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

export default function PTDetails({ pt, onClose }: PTDetailsProps) {
    const statusInfo = getStatusInfo(pt);


    return (
        <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-[100] p-4">
            <div className="bg-gray-800 rounded-lg p-4 md:p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center mb-4 md:mb-6">
                    <h3 className="text-lg md:text-2xl font-bold">PT Details</h3>
                    <button
                        onClick={onClose}
                        className="text-3xl md:text-4xl hover:text-red-500"
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
                    <div>
                        <div className="text-xs md:text-sm text-gray-400">Pallets</div>
                        <div className="font-bold text-blue-400">{pt.actual_pallet_count || 'TBD'}</div>
                    </div>
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
                    <div className="col-span-2">
                        <div className="text-xs md:text-sm text-gray-400">Location</div>
                        <div className="font-bold text-blue-400">
                            {pt.assigned_lane ? `Lane ${pt.assigned_lane}` : 'Unassigned'}
                        </div>
                    </div>
                    <div className="col-span-2">
                        <div className="text-xs md:text-sm text-gray-400">Status</div>
                        <div className={`inline-block px-3 py-1 rounded-lg font-bold text-sm ${statusInfo.color}`}>
                            {statusInfo.label}
                        </div>
                    </div>

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