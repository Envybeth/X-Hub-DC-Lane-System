import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { image } = await request.json();

    if (!image) {
      return NextResponse.json(
        { error: 'No image provided' },
        { status: 400 }
      );
    }

    // API key is now server-side only (not exposed to client)
    const apiKey = process.env.GOOGLE_VISION_KEY;
    
    if (!apiKey) {
      console.error('GOOGLE_VISION_KEY not configured');
      return NextResponse.json(
        { error: 'OCR service not configured' },
        { status: 500 }
      );
    }

    // Call Google Vision API from server
    const response = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: image },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
          }]
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Vision API error:', errorData);
      return NextResponse.json(
        { error: errorData.error?.message || 'OCR failed' },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    if (!data.responses?.[0]?.textAnnotations?.[0]) {
      return NextResponse.json(
        { error: 'No text detected' },
        { status: 400 }
      );
    }

    const detectedText = data.responses[0].textAnnotations[0].description;
    
    return NextResponse.json({ text: detectedText });

  } catch (error) {
    console.error('OCR API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}