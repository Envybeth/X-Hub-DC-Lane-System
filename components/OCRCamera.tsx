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

    //manual override
    const [showManualOverride, setShowManualOverride] = useState(false);
    const [manualPTInput, setManualPTInput] = useState('');
    const [manualPOInput, setManualPOInput] = useState('');
    const [manualOverrideError, setManualOverrideError] = useState('');

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

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas context failed');

            ctx.drawImage(video, 0, 0);

            // Get base64 image (remove prefix)
            const base64Image = canvas.toDataURL('image/png').split(',')[1];

            console.log('Sending to server OCR endpoint...');

            // Call OUR server endpoint instead of Google directly
            const response = await fetch('/api/ocr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64Image })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'OCR failed');
            }

            const data = await response.json();
            const detectedText = data.text;

            console.log('Detected text:', detectedText);

            const expectedPTClean = normalizeDigits(expectedPT);
            const expectedPOClean = normalizeDigits(expectedPO);
            const { ptNumber, poNumber } = parseLabel(detectedText, expectedPTClean, expectedPOClean);

            console.log('Parsed PT:', ptNumber, 'PO:', poNumber);
            console.log('Expected PT:', expectedPT, 'PO:', expectedPO);

            const ptMatch = ptNumber === expectedPTClean;
            const poMatch = poNumber === expectedPOClean;

            if (ptMatch && poMatch) {
                console.log('✅ Perfect match!');
                stopCamera();
                onSuccess();
                return;
            } else {
                let errorMsg = `❌ Attempt ${attempts}\n`;
                if (!ptMatch) errorMsg += `PT: Expected ${expectedPT}, got ${ptNumber || 'none'}\n`;
                if (!poMatch) errorMsg += `PO: Expected ${expectedPO}, got ${poNumber || 'none'}`;
                setError(errorMsg);

                if (attempts >= 3) {
                    setShowManualOverride(true);
                }
            }

        } catch (err) {
            console.error('OCR error:', err);
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            setError(`❌ Attempt ${attempts}: ${errorMessage}`);
        }

        setScanning(false);
    }

    function normalizeDigits(value: string): string {
        return (value || '').replace(/\D/g, '');
    }

    function parseLabel(text: string, expectedPTDigits: string, expectedPODigits: string): { ptNumber: string; poNumber: string } {
        // Remove all whitespace and newlines
        const cleaned = text.replace(/\s+/g, '');
        const ptLength = expectedPTDigits.length;
        const poLength = expectedPODigits.length;

        // Extract all digit sequences
        const allNumbers: string[] = cleaned.match(/\d+/g) ?? [];

        console.log('All numbers found:', allNumbers);

        // Prefer a sequence that clearly includes PT followed by the full PO length.
        const concatenated = allNumbers
            .filter(n => n.length >= ptLength + poLength)
            .sort((a, b) => b.length - a.length)
            .find((value) => {
                const ptIndex = value.indexOf(expectedPTDigits);
                return ptIndex !== -1 && (ptIndex + ptLength + poLength) <= value.length;
            });

        if (concatenated) {
            const ptIndex = concatenated.indexOf(expectedPTDigits);
            const ptNumber = concatenated.substring(ptIndex, ptIndex + ptLength);
            const poNumber = concatenated.substring(ptIndex + ptLength, ptIndex + ptLength + poLength);
            console.log('Split concatenated number - PT:', ptNumber, 'PO:', poNumber);
            return { ptNumber, poNumber };
        }

        // Fallback: PT has fixed digits, PO can vary so we respect expected PO length.
        const ptExact = allNumbers.find((n) => n === expectedPTDigits);
        if (ptExact) {
            const ptIndex = allNumbers.indexOf(ptExact);
            const nextNumber = allNumbers[ptIndex + 1] || '';
            const poFromNext = nextNumber.includes(expectedPODigits)
                ? expectedPODigits
                : (nextNumber.length >= poLength ? nextNumber.substring(0, poLength) : nextNumber);
            return { ptNumber: ptExact, poNumber: poFromNext };
        }

        const ptCandidate = allNumbers.find((n) => n.length >= ptLength)?.substring(0, ptLength) || '';
        const poExact = allNumbers.find((n) => n.includes(expectedPODigits));
        const poCandidate = poExact
            ? expectedPODigits
            : (allNumbers.find((n) => n.length >= poLength)?.substring(0, poLength) || '');

        return {
            ptNumber: ptCandidate,
            poNumber: poCandidate
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

                {/* Manual Override - Collapsible */}
                <div className="mb-4">
                    <button
                        onClick={() => setShowManualOverride(!showManualOverride)}
                        className="w-full bg-orange-900 border-2 border-orange-600 p-3 rounded-lg text-sm flex items-center justify-between hover:bg-orange-800 transition-colors"
                    >
                        <span className="font-bold">🔓 Manual Override</span>
                        <span className="text-xl">{showManualOverride ? '▼' : '▶'}</span>
                    </button>

                    {showManualOverride && (
                        <div className="bg-orange-900 border-2 border-orange-600 border-t-0 p-4 rounded-b-lg">
                            <div className="text-xs text-gray-300 mb-3">
                                Skip OCR verification and stage PT manually by confirming PT and PO.
                            </div>
                            <input
                                type="text"
                                placeholder="Enter PT number"
                                value={manualPTInput}
                                onChange={(e) => {
                                    setManualPTInput(e.target.value);
                                    setManualOverrideError('');
                                }}
                                className="w-full bg-gray-900 text-white p-2 rounded mb-2"
                            />
                            <input
                                type="text"
                                placeholder="Enter PO number"
                                value={manualPOInput}
                                onChange={(e) => {
                                    setManualPOInput(e.target.value);
                                    setManualOverrideError('');
                                }}
                                className="w-full bg-gray-900 text-white p-2 rounded mb-2"
                            />
                            {manualOverrideError && (
                                <div className="text-red-400 text-xs mb-2">{manualOverrideError}</div>
                            )}
                            <button
                                onClick={() => {
                                    const expectedPTClean = normalizeDigits(expectedPT);
                                    const expectedPOClean = normalizeDigits(expectedPO);
                                    const enteredPTClean = normalizeDigits(manualPTInput);
                                    const enteredPOClean = normalizeDigits(manualPOInput);

                                    if (enteredPTClean === expectedPTClean && enteredPOClean === expectedPOClean) {
                                        console.log('✅ Manual override authorized');
                                        stopCamera();
                                        onSuccess();
                                    } else {
                                        setManualOverrideError('❌ PT/PO does not match this ticket');
                                    }
                                }}
                                className="w-full bg-red-600 hover:bg-red-700 py-2 rounded font-bold"
                            >
                                Override & Stage PT
                            </button>
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
