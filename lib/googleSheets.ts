import 'server-only';
import { google } from 'googleapis';
import { getSupabaseAdmin } from './supabaseAdmin';

function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.trim() === '') return null;

  // Handle 4-digit year: "02/09/2026" or "1/30/2026"
  let dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const month = dateMatch[1];
    const day = dateMatch[2];
    const year = dateMatch[3];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Handle 2-digit year: "1/30/26" or "2/4/26"
  dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (dateMatch) {
    const month = dateMatch[1];
    const day = dateMatch[2];
    const yearShort = dateMatch[3];
    const year = `20${yearShort}`;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

const getGoogleAuth = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    return new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
};

const auth = getGoogleAuth();
const sheets = google.sheets({ version: 'v4', auth });
const UPSERT_CHUNK_SIZE = 500;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function quoteSheetNameForRange(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

async function resolveSourceSheetName(spreadsheetId: string): Promise<string> {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const firstSheetName = metadata.data.sheets?.[0]?.properties?.title;
  if (!firstSheetName) {
    throw new Error('No sheets found in the spreadsheet');
  }

  return firstSheetName;
}

export async function syncGoogleSheetData() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEET_ID is not configured');
    }
    const supabaseAdmin = getSupabaseAdmin();
    const sourceSheetName = await resolveSourceSheetName(spreadsheetId);

    console.log(`📊 Syncing from sheet: ${sourceSheetName}`);

    // Fetch columns A through S (19 columns)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetNameForRange(sourceSheetName)}!A:S`,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('No data found.');
      return { success: false, message: 'No data found', sourceSheet: sourceSheetName, count: 0, skipped: 0, errors: 0 };
    }

    const dataRows = rows.slice(1);

    let syncedCount = 0;
    let errorCount = 0;
    const skippedBreakdown = {
      picked_up: 0,
      paper: 0,
      missing_pt_or_po: 0
    };
    const containerNumbers = new Set<string>();
    const nowIso = new Date().toISOString();
    type PickticketUpsertRow = {
      customer?: string;
      store_dc?: string;
      pt_number: string;
      po_number: string;
      dept_number?: string;
      qty: number | null;
      ctn: string | null;
      weight: number | null;
      cubic_feet: number | null;
      est_pallet: number | null;
      start_date: string | null;
      cancel_date: string | null;
      container_number: string | null;
      routing_number: string | null;
      pu_number: string | null;
      carrier: string | null;
      pu_date: string | null;
      last_synced_at: string;
    };
    const pickticketRows: PickticketUpsertRow[] = [];

    for (const row of dataRows) {
      const [
        customer,           // A (0)
        store_dc,          // B (1)
        pt_number,         // C (2)
        po_number,         // D (3)
        dept_number,       // E (4)
        qty,               // F (5)
        ctn,               // G (6) - CTN field (text)
        weight,            // H (7)
        cubic_feet,        // I (8)
        est_pallet,        // J (9)
        start_date,        // K (10)
        cancel_date,       // L (11)
        container_number,  // M (12)
        routing_number,    // N (13)
        pu_number,         // O (14)
        carrier,           // P (15)
        pu_date,           // Q (16)
        // R (17) - skipped/not used
        pickup_status,     // S (18)
      ] = row;

      // SKIP if already picked up
      if (pickup_status && pickup_status.toLowerCase().includes('picked up')) {
        skippedBreakdown.picked_up += 1;
        continue;
      }

      // SKIP if customer is PAPER
      if (customer && customer.trim().toUpperCase() === 'PAPER') {
        skippedBreakdown.paper += 1;
        continue;
      }

      if (!pt_number || !po_number) {
        skippedBreakdown.missing_pt_or_po += 1;
        continue;
      }

      if (container_number) {
        containerNumbers.add(container_number);
      }

      pickticketRows.push({
        customer,
        store_dc,
        pt_number,
        po_number,
        dept_number,
        qty: qty ? parseInt(qty) : null,
        ctn: ctn || null,
        weight: weight ? parseFloat(weight) : null,
        cubic_feet: cubic_feet ? parseFloat(cubic_feet) : null,
        est_pallet: est_pallet ? parseInt(est_pallet) : null,
        start_date: parseDate(start_date),
        cancel_date: parseDate(cancel_date),
        container_number: container_number || null,
        routing_number: routing_number || null,
        pu_number: pu_number || null,
        carrier: carrier?.trim() || null,
        pu_date: parseDate(pu_date),
        last_synced_at: nowIso,
      });
    }

    const containerRows = Array.from(containerNumbers).map((value) => ({ container_number: value }));
    for (const chunk of chunkArray(containerRows, UPSERT_CHUNK_SIZE)) {
      const { error: containerBatchError } = await supabaseAdmin
        .from('containers')
        .upsert(chunk, { onConflict: 'container_number' });

      if (!containerBatchError) continue;
      console.error('Container batch upsert failed, falling back to per-row upsert:', containerBatchError);

      for (const item of chunk) {
        const { error: containerRowError } = await supabaseAdmin
          .from('containers')
          .upsert(item, { onConflict: 'container_number' });
        if (containerRowError) {
          errorCount += 1;
          console.error('Error upserting container:', item.container_number, containerRowError);
        }
      }
    }

    for (const chunk of chunkArray(pickticketRows, UPSERT_CHUNK_SIZE)) {
      const { error: ptBatchError } = await supabaseAdmin
        .from('picktickets')
        .upsert(chunk, { onConflict: 'pt_number,po_number' });

      if (!ptBatchError) {
        syncedCount += chunk.length;
        continue;
      }

      console.error('Pickticket batch upsert failed, falling back to per-row upsert:', ptBatchError);
      for (const item of chunk) {
        const { error: ptRowError } = await supabaseAdmin
          .from('picktickets')
          .upsert(item, { onConflict: 'pt_number,po_number' });
        if (ptRowError) {
          errorCount += 1;
          console.error('Error upserting PT:', item.pt_number, ptRowError);
        } else {
          syncedCount += 1;
        }
      }
    }

    const skippedCount = skippedBreakdown.picked_up + skippedBreakdown.paper + skippedBreakdown.missing_pt_or_po;
    const success = errorCount === 0;
    const message = success
      ? `Synced ${syncedCount} picktickets from "${sourceSheetName}"`
      : `Sync completed with errors from "${sourceSheetName}"`;

    console.log(`✅ ${message}. skipped=${skippedCount} errors=${errorCount}`);
    return {
      success,
      message,
      count: syncedCount,
      skipped: skippedCount,
      skipped_breakdown: skippedBreakdown,
      errors: errorCount,
      sourceSheet: sourceSheetName
    };

  } catch (error) {
    console.error('Error syncing Google Sheets:', error);
    throw error;
  }
}
