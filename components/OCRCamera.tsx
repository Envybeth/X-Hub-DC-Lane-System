'use client';

import { useState, useRef, useEffect } from 'react';
import Tesseract from 'tesseract.js';

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
        video: { facingMode: 'environment' } // Use back camera on mobile
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

    try {
      // Capture image from video
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) {
        throw new Error('Canvas context failed');
      }

      ctx.drawImage(video, 0, 0);
      const imageData = canvas.toDataURL('image/png');

      // Run OCR
      const result = await Tesseract.recognize(imageData, 'eng', {
        logger: (m) => console.log(m)
      });

      const text = result.data.text;
      console.log('OCR Result:', text);

      // Parse PT and PO numbers
      const { ptNumber, poNumber } = parseLabel(text);

      console.log('Parsed - PT:', ptNumber, 'PO:', poNumber);
      console.log('Expected - PT:', expectedPT, 'PO:', expectedPO);

      // Verify
      const ptMatch = ptNumber === expectedPT.replace(/\s/g, '');
      const poMatch = poNumber === expectedPO.replace(/\s/g, '');

      if (ptMatch && poMatch) {
        stopCamera();
        onSuccess();
      } else {
        let errorMsg = '❌ Mismatch:\n';
        if (!ptMatch) errorMsg += `PT: Expected ${expectedPT}, got ${ptNumber || 'none'}\n`;
        if (!poMatch) errorMsg += `PO: Expected ${expectedPO}, got ${poNumber || 'none'}`;
        setError(errorMsg);
      }

    } catch (err) {
      console.error('OCR error:', err);
      setError('Failed to scan label. Please try again.');
    }

    setScanning(false);
  }

  function parseLabel(text: string): { ptNumber: string; poNumber: string } {
    // Remove all whitespace and newlines
    const cleaned = text.replace(/\s+/g, '');
    
    // Look for sequences of 7-8 digits (typical PT/PO format)
    const numbers = cleaned.match(/\d{7,8}/g) || [];
    
    // First large number should be PT, second should be PO
    return {
      ptNumber: numbers[0] || '',
      poNumber: numbers[1] || ''
    };
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-95 flex items-center justify-center z-[100] p-4">
      <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-2xl font-bold">📷 Scan Pallet Label</h2>
          <button onClick={onCancel} className="text-3xl hover:text-red-500">
            &times;
          </button>
        </div>

        <div className="mb-4 bg-blue-900 p-3 rounded-lg text-sm">
          <div className="font-bold mb-1">Expected:</div>
          <div>PT: {expectedPT}</div>
          <div>PO: {expectedPO}</div>
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
            <div className="border-4 border-green-500 rounded-lg w-4/5 h-3/4 opacity-50"></div>
          </div>

          {scanning && (
            <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
              <div className="text-white text-xl animate-pulse">Scanning...</div>
            </div>
          )}
        </div>

        {/* Hidden canvas for capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Error message */}
        {error && (
          <div className="mb-4 bg-red-900 border-2 border-red-600 p-4 rounded-lg whitespace-pre-line">
            {error}
          </div>
        )}

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

        <div className="mt-4 text-center text-sm text-gray-400">
          Position label within the green box
        </div>
      </div>
    </div>
  );
}