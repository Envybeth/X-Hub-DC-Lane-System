import { google } from 'googleapis';
import { supabase } from './supabase';



function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.trim() === '') return null;
  
  console.log('🔍 Parsing date:', dateStr);
  
  // Handle 4-digit year: "02/09/2026 - @9.00 am" or "1/30/2026" or "01/31/2026 C02U0201483"
  let dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const [_, month, day, year] = dateMatch;
    const formatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    console.log('✅ Formatted date (4-digit year):', formatted);
    return formatted;
  }
  
  // Handle 2-digit year: "1/30/26" or "2/4/26"
  dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (dateMatch) {
    const [_, month, day, yearShort] = dateMatch;
    // Assume 20XX for years 00-99
    const year = `20${yearShort}`;
    const formatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    console.log('✅ Formatted date (2-digit year):', formatted);
    return formatted;
  }
  
  console.log('❌ Date did not match any regex:', dateStr);
  return null;
}

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

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
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${firstSheetName}!A:Q`,
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
    ctn_qty,           // G (6)
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
  ] = row;

  if (!pt_number || !po_number) continue;

  // DEBUG: Log EVERY row's date columns
  console.log(`PT ${pt_number}:`, {
    'K (start_date)': start_date,
    'L (cancel_date)': cancel_date,
    'Raw row length': row.length,
    'Row[10]': row[10],
    'Row[11]': row[11]
  });

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
        ctn_qty: ctn_qty ? parseInt(ctn_qty) : null,
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



