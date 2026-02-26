import { NextRequest, NextResponse } from 'next/server';
import { syncGoogleSheetData } from '@/lib/googleSheets';
import { requireStaff } from '@/lib/serverAuth';

export async function POST(request: NextRequest) {
  const authResult = await requireStaff(request);
  if (!authResult.ok) {
    return authResult.response;
  }

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

export async function GET(request: NextRequest) {
  const authResult = await requireStaff(request);
  if (!authResult.ok) {
    return authResult.response;
  }

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
