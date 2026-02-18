import { supabase } from './supabase';
import { Pickticket } from '@/types/pickticket';

export async function createCompiledPallet(
    ptIds: number[],
    compiledPalletCount: number,
    laneNumber: string
): Promise<{ success: boolean; compiledId?: number; error?: string }> {
    try {
        // Create compiled pallet record
        const { data: compiled, error: compiledError } = await supabase
            .from('compiled_pallets')
            .insert({ compiled_pallet_count: compiledPalletCount })
            .select()
            .single();

        if (compiledError) throw compiledError;

        // Link all PTs to this compiled pallet
        const ptLinks = ptIds.map((ptId, index) => ({
            compiled_pallet_id: compiled.id,
            pt_id: ptId,
            display_order: index + 1
        }));

        const { error: linkError } = await supabase
            .from('compiled_pallet_pts')
            .insert(ptLinks);

        if (linkError) throw linkError;

        // Create ONE lane assignment for the entire compiled group
        const { error: assignError } = await supabase
            .from('lane_assignments')
            .insert({
                lane_number: laneNumber,
                pt_id: ptIds[0], // Use first PT as representative
                pallet_count: compiledPalletCount,
                order_position: 1,
                compiled_pallet_id: compiled.id
            });

        if (assignError) throw assignError;

        // Update all PTs to be assigned and set their compiled reference
        const { error: updateError } = await supabase
            .from('picktickets')
            .update({
                assigned_lane: laneNumber,
                actual_pallet_count: compiledPalletCount,
                status: 'labeled',
                compiled_pallet_id: compiled.id
            })
            .in('id', ptIds);

        if (updateError) throw updateError;

        return { success: true, compiledId: compiled.id };
    } catch (error) {
        console.error('Error creating compiled pallet:', error);
        return { success: false, error: String(error) };
    }
}

export async function fetchCompiledPTInfo(ptIds: number[]): Promise<{ [key: number]: Pickticket[] }> {
    if (ptIds.length === 0) return {};

    // Get all compiled pallet IDs for these PTs
    const { data: links } = await supabase
        .from('compiled_pallet_pts')
        .select('compiled_pallet_id, pt_id')
        .in('pt_id', ptIds);

    if (!links || links.length === 0) return {};

    const compiledIds = [...new Set(links.map(l => l.compiled_pallet_id))];

    // Get all PTs in these compiled groups
    const { data: allLinks } = await supabase
        .from('compiled_pallet_pts')
        .select(`
      compiled_pallet_id,
      pt_id,
      picktickets (
        id,
        pt_number,
        po_number,
        customer,
        container_number,
        assigned_lane,
        store_dc,
        start_date,
        cancel_date,
        actual_pallet_count,
        status,
        pu_number,
        ctn,
        qty,
        last_synced_at,
        compiled_pallet_id
      )
    `)
        .in('compiled_pallet_id', compiledIds);

    if (!allLinks) return {};

    // Group by PT ID
    const result: { [key: number]: Pickticket[] } = {};

    ptIds.forEach(ptId => {
        const link = links.find(l => l.pt_id === ptId);
        if (!link) return;

        const groupPTs = allLinks
            .filter(l => l.compiled_pallet_id === link.compiled_pallet_id && l.pt_id !== ptId)
            .map(l => l.picktickets as any) // Cast to any first
            .filter(Boolean) as Pickticket[];

        if (groupPTs.length > 0) {
            result[ptId] = groupPTs;
        }
    });

    return result;
}

export async function deleteCompiledPallet(compiledId: number): Promise<boolean> {
    try {
        // Get all PT IDs in this group
        const { data: links } = await supabase
            .from('compiled_pallet_pts')
            .select('pt_id')
            .eq('compiled_pallet_id', compiledId);

        const ptIds = links?.map(l => l.pt_id) || [];

        // Delete lane assignments
        await supabase
            .from('lane_assignments')
            .delete()
            .eq('compiled_pallet_id', compiledId);

        // Reset PTs
        await supabase
            .from('picktickets')
            .update({
                assigned_lane: null,
                actual_pallet_count: null,
                status: 'unlabeled',
                compiled_pallet_id: null
            })
            .in('id', ptIds);

        // Delete compiled pallet (cascades to links)
        await supabase
            .from('compiled_pallets')
            .delete()
            .eq('id', compiledId);

        return true;
    } catch (error) {
        console.error('Error deleting compiled pallet:', error);
        return false;
    }
}