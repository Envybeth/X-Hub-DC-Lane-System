import { google } from 'googleapis';
import { supabase } from './supabase';

function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.trim() === '') return null;

  // Handle 4-digit year: "02/09/2026" or "1/30/2026"
  let dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const [_, month, day, year] = dateMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Handle 2-digit year: "1/30/26" or "2/4/26"
  dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (dateMatch) {
    const [_, month, day, yearShort] = dateMatch;
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

export async function syncGoogleSheetData() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    const sheetMetadata = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const firstSheetName = sheetMetadata.data.sheets?.[0]?.properties?.title;

    if (!firstSheetName) {
      throw new Error('No sheets found in the spreadsheet');
    }

    console.log(`📊 Syncing from sheet: ${firstSheetName}`);

    // Fetch columns A through S (18 columns)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${firstSheetName}!A:S`,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('No data found.');
      return { success: false, message: 'No data found' };
    }

    const dataRows = rows.slice(1);

    let syncedCount = 0;

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
        continue;
      }

      if (!pt_number || !po_number) continue;

      if (container_number) {
        await supabase
          .from('containers')
          .upsert(
            { container_number },
            { onConflict: 'container_number' }
          );
      }

      const { error } = await supabase
        .from('picktickets')
        .upsert(
          {
            customer,
            store_dc,
            pt_number,
            po_number,
            dept_number,
            qty: qty ? parseInt(qty) : null,
            ctn: ctn || null, // ADD THIS - Column G as text
            weight: weight ? parseFloat(weight) : null,
            cubic_feet: cubic_feet ? parseFloat(cubic_feet) : null,
            est_pallet: est_pallet ? parseInt(est_pallet) : null,
            start_date: parseDate(start_date),
            cancel_date: parseDate(cancel_date),
            container_number: container_number || null,
            routing_number: routing_number || null,
            pu_number: pu_number || null,
            carrier: carrier || null,
            pu_date: parseDate(pu_date),
          },
          { onConflict: 'pt_number,po_number' }
        );

      if (!error) {
        syncedCount++;
      } else {
        console.error('Error upserting PT:', pt_number, error);
      }
    }

    console.log(`✅ Synced ${syncedCount} picktickets from Google Sheets`);
    return { success: true, count: syncedCount };

  } catch (error) {
    console.error('Error syncing Google Sheets:', error);
    throw error;
  }
}