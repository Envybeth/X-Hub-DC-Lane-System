'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import jsPDF from 'jspdf';
import Link from 'next/link';

interface PrintData {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  store_dc: string;
  cancel_date: string;
}

export default function PrinterPage() {
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [printData, setPrintData] = useState<PrintData | null>(null);
  const [palletCount, setPalletCount] = useState<number>(1);
  const [printing, setPrinting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inputVal.trim()) return;

    setLoading(true);
    setPrintData(null);
    setStatusMsg('');

    try {
      // Search by PT Number OR PO Number
      const { data, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, store_dc, cancel_date')
        .or(`pt_number.eq.${inputVal},po_number.eq.${inputVal}`)
        .limit(1)
        .single();

      if (error || !data) {
        setStatusMsg('❌ No Pick Ticket found with that number.');
      } else {
        setPrintData(data);
        setStatusMsg('');
      }
    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Error searching.');
    } finally {
      setLoading(false);
    }
  }

  async function generateAndPrint() {
    if (!printData) return;
    setPrinting(true);
    setStatusMsg('⏳ Generating PDF...');

    try {
      // 1. Setup PDF (Standard 4x6 inch label)
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'in',
        format: [4, 6]
      });

      // Loop for total pallets (e.g., 1 of 2, 2 of 2)
      for (let i = 1; i <= palletCount; i++) {
        // Loop for copies (2 copies per pallet)
        for (let copy = 0; copy < 2; copy++) {
          
          // Add new page if it's not the very first page
          if (!(i === 1 && copy === 0)) {
            doc.addPage();
          }

          // --- PDF DRAWING LOGIC (Matching Screenshot) ---
          
          const pageWidth = 4;
          const center = pageWidth / 2;

          // Header: Customer & DC
          doc.setFontSize(14);
          doc.setFont('helvetica', 'bold');
          doc.text(printData.customer || 'CUSTOMER', 0.2, 0.5);
          
          doc.setFontSize(12);
          doc.setFont('helvetica', 'normal');
          doc.text(`DC# ${printData.store_dc || 'N/A'}`, 3.8, 0.5, { align: 'right' });

          // Line 1
          doc.setLineWidth(0.02);
          doc.line(0.1, 0.7, 3.9, 0.7);

          // "Pick Ticket" Title
          doc.setFontSize(16);
          doc.setFont('helvetica', 'normal');
          doc.text("Pick Ticket", center, 1.0, { align: 'center' });

          // Line 2
          doc.line(0.1, 1.2, 3.9, 1.2);

          // PT Number (Large)
          doc.setFontSize(32);
          doc.setFont('helvetica', 'bold');
          doc.text(printData.pt_number, center, 1.8, { align: 'center' });

          // PO Number
          doc.setFontSize(12);
          doc.setFont('helvetica', 'normal');
          // Helper to bold just the number part if possible, otherwise simple text
          doc.text(`PO# ${printData.po_number}`, center, 2.3, { align: 'center' });

          // Cancel Date
          doc.setFontSize(10);
          doc.text(`Cancel Date: ${formatDate(printData.cancel_date)}`, center, 2.6, { align: 'center' });

          // Line 3
          doc.line(0.1, 2.8, 3.9, 2.8);

          // Pallet Grid Box
          // Vertical "P L T #" text logic
          doc.setFontSize(10);
          doc.text("P", 0.3, 3.2);
          doc.text("L", 0.3, 3.4);
          doc.text("T", 0.3, 3.6);
          doc.text("#", 0.3, 3.8);

          // Vertical Divider
          doc.line(0.6, 2.8, 0.6, 4.2);

          // Current Pallet Number (Huge)
          doc.setFontSize(48);
          doc.setFont('helvetica', 'bold');
          doc.text(`${i}`, 1.2, 3.8, { align: 'center' });

          // "of"
          doc.setFontSize(12);
          doc.setFont('helvetica', 'normal');
          doc.text("of", 2.0, 3.6, { align: 'center' });

          // Divider between numbers
          doc.line(1.7, 2.8, 1.7, 4.2); // Left of 'of'
          doc.line(2.3, 2.8, 2.3, 4.2); // Right of 'of'

          // Total Pallets (Huge)
          doc.setFontSize(48);
          doc.setFont('helvetica', 'bold');
          doc.text(`${palletCount}`, 3.0, 3.8, { align: 'center' });

          // Bottom Line
          doc.line(0.1, 4.2, 3.9, 4.2);

          // Footer Repeat (As seen in screenshot)
          doc.setFontSize(12);
          doc.setFont('helvetica', 'bold');
          doc.text(printData.customer || 'CUSTOMER', 0.2, 4.6);
          doc.setFont('helvetica', 'normal');
          doc.text(`DC# ${printData.store_dc || 'N/A'}`, 3.8, 4.6, { align: 'right' });
          
          doc.line(0.1, 4.8, 3.9, 4.8);
          
          doc.setFontSize(14);
          doc.text("Pick Ticket", center, 5.2, { align: 'center' });
        }
      }

      // 2. Upload to Supabase Storage
      const pdfBlob = doc.output('blob');
      const fileName = `labels/${printData.pt_number}-${Date.now()}.pdf`;
      
      setStatusMsg('☁️ Uploading file...');
      const { error: uploadError } = await supabase.storage
        .from('labels') // Ensure this bucket exists in Supabase
        .upload(fileName, pdfBlob);

      if (uploadError) throw uploadError;

      // 3. Get Public URL
      const { data: { publicUrl } } = supabase.storage
        .from('labels')
        .getPublicUrl(fileName);

      // 4. Send to Print Queue
      setStatusMsg('📡 Sending to office printer...');
      const { error: queueError } = await supabase
        .from('print_queue')
        .insert({
          file_url: publicUrl,
          status: 'pending',
          created_at: new Date().toISOString()
        });

      if (queueError) throw queueError;

      setStatusMsg('✅ Sent successfully! Printing should start shortly.');
      
      // Reset after 3 seconds
      setTimeout(() => {
        setPrinting(false);
        setPrintData(null);
        setInputVal('');
        setStatusMsg('');
      }, 3000);

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Failed to print. Check console.');
      setPrinting(false);
    }
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return 'N/A';
    // dateStr is likely YYYY-MM-DD from supabase
    const [y, m, d] = dateStr.split('-');
    return `${m}/${d}/${y}`;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">🖨️ Pallet Label Printer</h1>
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded">
            Back Home
          </Link>
        </div>

        {/* SEARCH BOX */}
        <div className="bg-gray-800 p-6 rounded-lg border border-gray-700 mb-6">
          <form onSubmit={handleSearch} className="flex flex-col gap-4">
            <label className="text-sm font-semibold text-gray-400">
              Scan or Type PT # / PO #
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="Ex: 12345 or 123456789"
                className="flex-1 bg-gray-900 border border-gray-600 rounded-lg p-3 text-xl focus:border-blue-500 outline-none"
                autoFocus
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-bold disabled:opacity-50"
              >
                {loading ? '...' : 'Search'}
              </button>
            </div>
          </form>
          {statusMsg && <div className="mt-4 text-center font-bold text-lg animate-pulse">{statusMsg}</div>}
        </div>

        {/* RESULT & PRINT CARD */}
        {printData && (
          <div className="bg-gray-800 p-6 rounded-lg border-2 border-blue-500 animate-fade-in-up">
            <div className="grid grid-cols-2 gap-4 mb-6 border-b border-gray-700 pb-4">
              <div>
                <p className="text-gray-400 text-sm">Customer</p>
                <p className="font-bold text-xl">{printData.customer}</p>
              </div>
              <div className="text-right">
                <p className="text-gray-400 text-sm">DC Number</p>
                <p className="font-bold text-xl">{printData.store_dc}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">PT Number</p>
                <p className="font-bold text-2xl text-blue-400">{printData.pt_number}</p>
              </div>
              <div className="text-right">
                <p className="text-gray-400 text-sm">PO Number</p>
                <p className="font-bold text-xl">{printData.po_number}</p>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <label className="text-lg font-bold">How many pallets total (1 of X)?</label>
              <div className="flex gap-4 items-center">
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={palletCount}
                  onChange={(e) => setPalletCount(parseInt(e.target.value) || 1)}
                  className="bg-gray-900 border border-gray-600 rounded-lg p-4 text-3xl font-bold w-32 text-center"
                />
                <div className="text-gray-400 text-sm">
                  x 2 copies = <span className="text-white font-bold">{palletCount * 2}</span> total labels
                </div>
              </div>

              <button
                onClick={generateAndPrint}
                disabled={printing}
                className="mt-4 w-full bg-green-600 hover:bg-green-700 py-4 rounded-lg text-2xl font-bold transition-transform active:scale-95 disabled:bg-gray-600 disabled:scale-100"
              >
                {printing ? 'Sending to Printer...' : '🖨️ PRINT LABELS'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}