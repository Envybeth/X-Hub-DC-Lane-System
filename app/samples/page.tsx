'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import PTDetails from '@/components/PTDetails';
import Link from 'next/link';

interface PT {
    id: number;
    pt_number: string;
    po_number: string;
    customer: string;
    container_number: string;
    store_dc: string;
    start_date: string;
    cancel_date: string;
    actual_pallet_count: number | null;
    ctn?: string;
    status?: string;
    assigned_lane: string | null;
    sample_checked?: boolean;
    sample_labeled?: boolean;
    sample_shipped?: boolean;
}

interface ContainerGroup {
    container_number: string;
    pts: PT[];
    allChecked: boolean;
}

export default function SamplesPage() {
    const [containers, setContainers] = useState<ContainerGroup[]>([]);
    const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [viewingPTDetails, setViewingPTDetails] = useState<PT | null>(null);
    const [showConfirm, setShowConfirm] = useState<{
        isOpen: boolean;
        ptId: number;
        ptNumber: string;
        type: 'checked' | 'labeled' | 'shipped'; // ADD shipped
    } | null>(null);

    useEffect(() => {
        fetchSamples();
    }, []);

    async function fetchSamples() {
        setLoading(true);
        try {
            const { data: pts } = await supabase
                .from('picktickets')
                .select('*')
                .eq('customer', 'PAPER')
                .order('container_number');

            if (pts) {
                const grouped = pts.reduce((acc: ContainerGroup[], pt: PT) => {
                    const container = pt.container_number || 'NO CONTAINER';
                    const existing = acc.find((g: ContainerGroup) => g.container_number === container);

                    if (existing) {
                        existing.pts.push(pt);
                    } else {
                        acc.push({
                            container_number: container,
                            pts: [pt],
                            allChecked: false
                        });
                    }
                    return acc;
                }, [] as ContainerGroup[]);

                grouped.forEach((group: ContainerGroup) => {
                    group.allChecked = group.pts.every((pt: PT) =>
                        pt.sample_checked === true &&
                        pt.sample_labeled === true &&
                        pt.sample_shipped === true
                    );
                });

                setContainers(grouped);
            }
        } catch (error) {
            console.error('Error fetching samples:', error);
        } finally {
            setLoading(false);
        }
    }

    function toggleContainer(containerNumber: string) {
        setExpandedContainers(prev => {
            const newSet = new Set(prev);
            if (newSet.has(containerNumber)) {
                newSet.delete(containerNumber);
            } else {
                newSet.add(containerNumber);
            }
            return newSet;
        });
    }

    async function handleCheckToggle(pt: PT, currentValue: boolean) {
        if (currentValue) {
            setShowConfirm({
                isOpen: true,
                ptId: pt.id,
                ptNumber: pt.pt_number,
                type: 'checked'
            });
            return;
        }

        await updateStatus(pt.id, 'sample_checked', true);
    }

    async function handleLabeledToggle(pt: PT, currentValue: boolean) {
        if (currentValue) {
            setShowConfirm({
                isOpen: true,
                ptId: pt.id,
                ptNumber: pt.pt_number,
                type: 'labeled'
            });
            return;
        }

        await updateStatus(pt.id, 'sample_labeled', true);
    }

    async function handleShippedToggle(pt: PT, currentValue: boolean) {
        if (currentValue) {
            setShowConfirm({
                isOpen: true,
                ptId: pt.id,
                ptNumber: pt.pt_number,
                type: 'shipped'
            });
            return;
        }

        await updateStatus(pt.id, 'sample_shipped', true);
    }

    async function confirmUncheck() {
        if (!showConfirm) return;

        if (showConfirm.type === 'checked') {
            // Uncheck all three
            await updateStatus(showConfirm.ptId, 'sample_checked', false);
            await updateStatus(showConfirm.ptId, 'sample_labeled', false);
            await updateStatus(showConfirm.ptId, 'sample_shipped', false);
        } else if (showConfirm.type === 'labeled') {
            // Uncheck labeled and shipped
            await updateStatus(showConfirm.ptId, 'sample_labeled', false);
            await updateStatus(showConfirm.ptId, 'sample_shipped', false);
        } else if (showConfirm.type === 'shipped') {
            // Just uncheck shipped
            await updateStatus(showConfirm.ptId, 'sample_shipped', false);
        }

        setShowConfirm(null);
    }

    async function updateStatus(ptId: number, field: 'sample_checked' | 'sample_labeled' | 'sample_shipped', value: boolean) {
        try {
            await supabase
                .from('picktickets')
                .update({ [field]: value })
                .eq('id', ptId);

            await fetchSamples();
        } catch (error) {
            console.error('Error updating status:', error);
        }
    }

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
            <div className="max-w-7xl mx-auto">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 md:mb-8 gap-4">
                    <h1 className="text-3xl md:text-4xl font-bold">📋 Sample Containers (PAPER)</h1>
                    <Link
                        href="/"
                        className="bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-lg font-semibold"
                    >
                        ← Back
                    </Link>
                </div>

                {loading ? (
                    <div className="text-center py-12">
                        <div className="text-2xl animate-pulse">Loading samples...</div>
                    </div>
                ) : containers.length === 0 ? (
                    <div className="bg-gray-800 p-8 rounded-lg text-center">
                        <div className="text-2xl mb-4">No PAPER samples found</div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {containers.map((group: ContainerGroup) => {
                            const isExpanded = expandedContainers.has(group.container_number);

                            return (
                                <div
                                    key={group.container_number}
                                    className={`bg-gray-800 rounded-lg border-2 ${group.allChecked ? 'border-green-500' : 'border-gray-600'
                                        }`}
                                >
                                    <button
                                        onClick={() => toggleContainer(group.container_number)}
                                        className="w-full p-5 flex items-center justify-between hover:bg-gray-750 transition-colors"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="text-2xl text-blue-400">
                                                {isExpanded ? '▼' : '▶'}
                                            </div>
                                            <div className="text-left">
                                                <div className="text-2xl font-bold">
                                                    Container #{group.container_number}
                                                </div>
                                                <div className="text-sm text-gray-400 mt-1">
                                                    {group.pts.length} PT{group.pts.length !== 1 ? 's' : ''} •
                                                    {group.pts.filter((pt: PT) => pt.sample_checked && pt.sample_labeled && pt.sample_shipped).length} complete
                                                </div>
                                            </div>
                                        </div>
                                        {group.allChecked && (
                                            <div className="bg-green-600 px-4 py-2 rounded-lg font-bold text-white">
                                                ✓ DONE
                                            </div>
                                        )}
                                    </button>

                                    {isExpanded && (
                                        <div className="p-6 border-t-2 border-gray-700 space-y-3">
                                            {group.pts.map((pt: PT) => (
                                                <div
                                                    key={pt.id}
                                                    className="bg-gray-700 p-4 rounded-lg flex items-center justify-between gap-4"
                                                >
                                                    <div className="flex items-center gap-4 flex-1">
                                                        {/* Main Checkbox */}
                                                        <input
                                                            type="checkbox"
                                                            checked={pt.sample_checked || false}
                                                            onChange={(e) => {
                                                                e.stopPropagation();
                                                                handleCheckToggle(pt, pt.sample_checked || false);
                                                            }}
                                                            onClick={(e) => e.stopPropagation()}
                                                            className="w-6 h-6 cursor-pointer flex-shrink-0"
                                                        />

                                                        {/* Labeled Button - Only shows when checked */}
                                                        {pt.sample_checked && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleLabeledToggle(pt, pt.sample_labeled || false);
                                                                }}
                                                                className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-2 flex-shrink-0 ${pt.sample_labeled
                                                                    ? 'bg-green-600 hover:bg-green-700'
                                                                    : 'bg-gray-600 hover:bg-gray-500'
                                                                    }`}
                                                            >
                                                                {pt.sample_labeled && '✓'} Labeled
                                                            </button>
                                                        )}

                                                        {/* Ship Button - Only shows when labeled */}
                                                        {pt.sample_checked && pt.sample_labeled && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleShippedToggle(pt, pt.sample_shipped || false);
                                                                }}
                                                                className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-2 flex-shrink-0 ${pt.sample_shipped
                                                                    ? 'bg-green-600 hover:bg-green-700'
                                                                    : 'bg-gray-600 hover:bg-gray-500'
                                                                    }`}
                                                            >
                                                                {pt.sample_shipped && '✓'} Ship
                                                            </button>
                                                        )}

                                                        <div className="flex-1 min-w-0">
                                                            <div className="font-bold text-lg">PT #{pt.pt_number}</div>
                                                            <div className="text-sm text-gray-300 truncate">
                                                                PO: {pt.po_number} | CTN: {pt.ctn || 'N/A'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setViewingPTDetails(pt);
                                                        }}
                                                        className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold flex-shrink-0"
                                                    >
                                                        Details
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {viewingPTDetails && (
                <PTDetails
                    pt={viewingPTDetails}
                    onClose={() => setViewingPTDetails(null)}
                />
            )}

            {showConfirm && (
                <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
                    <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold mb-4">
                            {showConfirm.type === 'checked'
                                ? 'Uncheck Sample?'
                                : showConfirm.type === 'labeled'
                                    ? 'Unmark as Labeled?'
                                    : 'Unmark as Shipped?'
                            }
                        </h3>
                        <p className="text-gray-300 mb-6">
                            {showConfirm.type === 'checked'
                                ? `This will reset all statuses for PT #${showConfirm.ptNumber}. Continue?`
                                : showConfirm.type === 'labeled'
                                    ? `This will unmark PT #${showConfirm.ptNumber} as labeled and shipped. Continue?`
                                    : `Are you sure you want to unmark PT #${showConfirm.ptNumber} as shipped?`
                            }
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={confirmUncheck}
                                className="flex-1 bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg font-semibold"
                            >
                                Yes, Confirm
                            </button>
                            <button
                                onClick={() => setShowConfirm(null)}
                                className="flex-1 bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded-lg font-semibold"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}