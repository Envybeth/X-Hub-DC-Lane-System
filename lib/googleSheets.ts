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

// Handle both local file and Vercel environment variable
const getGoogleAuth = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Vercel: Use JSON from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    // Local: Use file
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
        customer,
        store_dc,
        pt_number,
        po_number,
        dept_number,
        qty,
        ctn_qty,
        weight,
        cubic_feet,
        est_pallet,
        start_date,
        cancel_date,
        container_number,
        routing_number,
        pu_number,
        carrier,
        pu_date,
      ] = row;

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