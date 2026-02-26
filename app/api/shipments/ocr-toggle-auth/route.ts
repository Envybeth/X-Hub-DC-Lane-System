import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/serverAuth';

type OCRToggleAuthRequest = {
  password?: string;
};

export async function POST(request: NextRequest) {
  const authResult = await requireStaff(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  const expectedPassword = (process.env.OCR_TOGGLE_PASSWORD || '').trim();
  if (!expectedPassword) {
    return NextResponse.json(
      { authorized: false, message: 'OCR toggle password is not configured on server.' },
      { status: 500 }
    );
  }

  let body: OCRToggleAuthRequest;
  try {
    body = (await request.json()) as OCRToggleAuthRequest;
  } catch {
    return NextResponse.json(
      { authorized: false, message: 'Invalid request body.' },
      { status: 400 }
    );
  }

  const suppliedPassword = (body.password || '').trim();
  if (!suppliedPassword) {
    return NextResponse.json(
      { authorized: false, message: 'Password is required.' },
      { status: 400 }
    );
  }

  if (suppliedPassword !== expectedPassword) {
    return NextResponse.json(
      { authorized: false, message: 'Incorrect password.' },
      { status: 401 }
    );
  }

  return NextResponse.json({ authorized: true });
}
