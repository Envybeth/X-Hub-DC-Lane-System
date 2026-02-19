'use client';

import { useState, useRef, useEffect } from 'react';

interface OCRCameraProps {
  expectedPT: string;
  expectedPO: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function OCRCamera({ expectedPT, expectedPO, onSuccess, onCancel }: OCRCameraProps) {
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [showTips, setShowTips] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setCameraActive(true);
      }
    } catch (err) {
      console.error('Camera error:', err);
      setError('Failed to access camera. Please allow camera permissions.');
    }
  }

  function stopCamera() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  }

  async function captureAndScan() {
    if (!videoRef.current || !canvasRef.current) return;

    setScanning(true);
    setError('');
    setAttempts(prev => prev + 1);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      // Capture at full resolution
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context failed');

      ctx.drawImage(video, 0, 0);
      
      // Get base64 image (remove data:image/png;base64, prefix)
      const base64Image = canvas.toDataURL('image/png').split(',')[1];

      // Verify API key exists
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_VISION_KEY;
      if (!apiKey) {
        throw new Error('Google Vision API key not configured');
      }

      console.log('Sending to Google Vision API...');

      // Call Google Cloud Vision API
      const response = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            requests: [
              {
                image: { 
                  content: base64Image 
                },
                features: [
                  { 
                    type: 'TEXT_DETECTION',
                    maxResults: 1 
                  }
                ]
              }
            ]
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Vision API error:', errorData);
        throw new Error(`API Error: ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      
      console.log('Google Vision response:', data);

      if (!data.responses?.[0]?.textAnnotations?.[0]) {
        throw new Error('No text detected. Ensure label is clearly visible.');
      }

      const detectedText = data.responses[0].textAnnotations[0].description;
      console.log('Detected text:', detectedText);

      // Parse PT and PO numbers
      const { ptNumber, poNumber } = parseLabel(detectedText);

      console.log('Parsed PT:', ptNumber, 'PO:', poNumber);
      console.log('Expected PT:', expectedPT, 'PO:', expectedPO);

      // Verify match
      const ptMatch = ptNumber === expectedPT.replace(/\s/g, '');
      const poMatch = poNumber === expectedPO.replace(/\s/g, '');

      if (ptMatch && poMatch) {
        console.log('✅ Match confirmed!');
        stopCamera();
        onSuccess();
        return;
      } else {
        let errorMsg = `❌ Attempt ${attempts}\n`;
        if (!ptMatch) errorMsg += `PT: Expected ${expectedPT}, got ${ptNumber || 'not found'}\n`;
        if (!poMatch) errorMsg += `PO: Expected ${expectedPO}, got ${poNumber || 'not found'}`;
        setError(errorMsg);
      }

    } catch (err) {
      console.error('OCR error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`❌ Attempt ${attempts}: ${errorMessage}`);
    }

    setScanning(false);
  }

  function parseLabel(text: string): { ptNumber: string; poNumber: string } {
    // Remove all whitespace and newlines
    const cleaned = text.replace(/\s+/g, '');
    
    // Extract all digit sequences
    const allNumbers = cleaned.match(/\d+/g) || [];
    
    console.log('All numbers found:', allNumbers);
    
    // Filter to 7-8 digit numbers (PT/PO format)
    const validNumbers = allNumbers.filter(n => n.length >= 7 && n.length <= 8);
    
    console.log('Valid 7-8 digit numbers:', validNumbers);
    
    return {
      ptNumber: validNumbers[0] || '',
      poNumber: validNumbers[1] || ''
    };
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-95 flex items-center justify-center z-[100] p-4">
      <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full max-h-[95vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-2xl font-bold">📷 Scan Pallet Label</h2>
            <div className="text-sm text-gray-400 mt-1">Attempts: {attempts}</div>
          </div>
          <button onClick={onCancel} className="text-3xl hover:text-red-500">
            &times;
          </button>
        </div>

        <div className="mb-4 bg-blue-900 p-3 rounded-lg text-sm">
          <div className="font-bold mb-1">Expected:</div>
          <div className="font-mono">PT: {expectedPT}</div>
          <div className="font-mono">PO: {expectedPO}</div>
        </div>

        {/* Camera preview */}
        <div className="relative bg-black rounded-lg overflow-hidden mb-4" style={{ aspectRatio: '4/3' }}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          
          {/* Scan guide overlay */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="border-4 border-green-500 rounded-lg w-11/12 h-2/3 opacity-70 flex items-center justify-center">
              <div className="text-green-400 text-sm bg-black bg-opacity-50 px-2 py-1 rounded">
                Align label here
              </div>
            </div>
          </div>

          {scanning && (
            <div className="absolute inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center gap-2">
              <div className="text-white text-xl animate-pulse">Scanning...</div>
              <div className="text-gray-400 text-sm">Powered by Google Vision</div>
            </div>
          )}
        </div>

        {/* Hidden canvas */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Error message */}
        {error && (
          <div className="mb-4 bg-red-900 border-2 border-red-600 p-4 rounded-lg whitespace-pre-line font-mono text-sm">
            {error}
          </div>
        )}

        {/* Tips - Collapsible */}
        <div className="mb-4">
          <button
            onClick={() => setShowTips(!showTips)}
            className="w-full bg-yellow-900 border-2 border-yellow-600 p-3 rounded-lg text-sm flex items-center justify-between hover:bg-yellow-800 transition-colors"
          >
            <span className="font-bold">📋 Tips for best results</span>
            <span className="text-xl">{showTips ? '▼' : '▶'}</span>
          </button>
          
          {showTips && (
            <div className="bg-yellow-900 border-2 border-yellow-600 border-t-0 p-3 rounded-b-lg text-sm">
              <ul className="text-xs space-y-1 ml-4 list-disc">
                <li>Hold phone steady</li>
                <li>Ensure good lighting (no shadows)</li>
                <li>Label should be flat (no wrinkles)</li>
                <li>Fill the green box with the label</li>
                <li>Keep camera perpendicular to label</li>
              </ul>
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={captureAndScan}
            disabled={!cameraActive || scanning}
            className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 py-3 rounded-lg font-bold text-lg"
          >
            {scanning ? 'Scanning...' : '📸 Capture & Verify'}
          </button>
          <button
            onClick={onCancel}
            className="flex-1 bg-gray-600 hover:bg-gray-700 py-3 rounded-lg font-bold text-lg"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}