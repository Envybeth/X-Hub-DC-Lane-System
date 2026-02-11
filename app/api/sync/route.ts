import { NextResponse } from 'next/server';
import { syncGoogleSheetData } from '@/lib/googleSheets';

export async function POST() {
  try {
    const result = await syncGoogleSheetData();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const result = await syncGoogleSheetData();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Sync failed:', error);
    return NextResponse.json(
      { error: 'Sync failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}