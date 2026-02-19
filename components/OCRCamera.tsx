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

    function preprocessImage(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, mode: 'contrast' | 'sharp' | 'invert'): string {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        if (mode === 'contrast') {
            // High contrast black/white
            for (let i = 0; i < data.length; i += 4) {
                const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                const value = gray > 140 ? 255 : 0; // Adjusted threshold
                data[i] = value;
                data[i + 1] = value;
                data[i + 2] = value;
            }
        } else if (mode === 'sharp') {
            // Sharpening filter
            const original = new Uint8ClampedArray(data);
            for (let i = 0; i < data.length; i += 4) {
                const gray = original[i] * 0.299 + original[i + 1] * 0.587 + original[i + 2] * 0.114;
                const enhanced = gray < 128 ? Math.max(0, gray - 40) : Math.min(255, gray + 40);
                data[i] = enhanced;
                data[i + 1] = enhanced;
                data[i + 2] = enhanced;
            }
        } else if (mode === 'invert') {
            // Invert for dark labels
            for (let i = 0; i < data.length; i += 4) {
                const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
                const inverted = 255 - gray;
                const value = inverted > 140 ? 255 : 0;
                data[i] = value;
                data[i + 1] = value;
                data[i + 2] = value;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL('image/png');
    }

    async function captureAndScan() {
        if (!videoRef.current || !canvasRef.current) return;

        setScanning(true);
        setError('');
        setAttempts(prev => prev + 1);

        try {
            const video = videoRef.current;
            const canvas = canvasRef.current;

            // Use full resolution
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas context failed');

            // Capture original
            ctx.drawImage(video, 0, 0);

            // Try multiple preprocessing techniques
            const preprocessModes: Array<'contrast' | 'sharp' | 'invert'> = ['contrast', 'sharp', 'invert'];
            const results: Array<{ pt: string; po: string; confidence: number }> = [];

            for (const mode of preprocessModes) {
                // Reset canvas
                ctx.drawImage(video, 0, 0);

                // Preprocess
                const processedImage = preprocessImage(ctx, canvas, mode);

                // Create worker for this attempt
                const worker = await Tesseract.createWorker('eng');

                try {
                    const result = await worker.recognize(processedImage);
                    const text = result.data.text;
                    const confidence = result.data.confidence;

                    console.log(`${mode} OCR:`, text, 'Confidence:', confidence);

                    const { ptNumber, poNumber } = parseLabel(text);

                    if (ptNumber && poNumber) {
                        results.push({
                            pt: ptNumber,
                            po: poNumber,
                            confidence
                        });
                    }
                } finally {
                    await worker.terminate();
                }
            }

            console.log('All results:', results);

            // Find best match
            const bestMatch = findBestMatch(results);

            if (bestMatch) {
                console.log('Best match:', bestMatch);

                const ptMatch = bestMatch.pt === expectedPT.replace(/\s/g, '');
                const poMatch = bestMatch.po === expectedPO.replace(/\s/g, '');

                if (ptMatch && poMatch) {
                    stopCamera();
                    onSuccess();
                    return;
                } else {
                    let errorMsg = `❌ Attempt ${attempts}\n`;
                    if (!ptMatch) errorMsg += `PT: Expected ${expectedPT}, got ${bestMatch.pt}\n`;
                    if (!poMatch) errorMsg += `PO: Expected ${expectedPO}, got ${bestMatch.po}`;
                    setError(errorMsg);
                }
            } else {
                setError(`❌ Attempt ${attempts}: No numbers detected. Try better lighting/angle.`);
            }

        } catch (err) {
            console.error('OCR error:', err);
            setError(`❌ Attempt ${attempts}: Scan failed. Try again.`);
        }

        setScanning(false);
    }

    function parseLabel(text: string): { ptNumber: string; poNumber: string } {
        // Remove all whitespace
        const cleaned = text.replace(/\s+/g, '');

        // Extract all sequences of digits
        const allNumbers = cleaned.match(/\d+/g) || [];

        // Filter to 7-8 digit numbers (typical PT/PO format)
        const validNumbers = allNumbers.filter(n => n.length >= 7 && n.length <= 8);

        console.log('Valid numbers found:', validNumbers);

        // PT is first, PO is second
        return {
            ptNumber: validNumbers[0] || '',
            poNumber: validNumbers[1] || ''
        };
    }

    function findBestMatch(results: Array<{ pt: string; po: string; confidence: number }>): { pt: string; po: string } | null {
        if (results.length === 0) return null;

        // Count occurrences of each PT/PO combination
        const counts = new Map<string, { count: number; avgConfidence: number }>();

        results.forEach(r => {
            const key = `${r.pt}-${r.po}`;
            if (counts.has(key)) {
                const existing = counts.get(key)!;
                counts.set(key, {
                    count: existing.count + 1,
                    avgConfidence: (existing.avgConfidence + r.confidence) / 2
                });
            } else {
                counts.set(key, { count: 1, avgConfidence: r.confidence });
            }
        });

        // Find most common result with highest confidence
        let best: { pt: string; po: string } | null = null;
        let bestScore = 0;

        counts.forEach((value, key) => {
            const score = value.count * 100 + value.avgConfidence;
            if (score > bestScore) {
                bestScore = score;
                const [pt, po] = key.split('-');
                best = { pt, po };
            }
        });

        return best;
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

                    {/* Scan guide overlay - narrower for label */}
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
                            <div className="text-gray-400 text-sm">Running 3 detection passes</div>
                        </div>
                    )}
                </div>

                {/* Hidden canvas for capture */}
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
                        <div className="bg-yellow-900 border-2 border-yellow-600 border-t-0 p-3 rounded-b-lg text-sm animate-fade-in">
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