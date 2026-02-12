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
        .or(`pt_number.eq.${inputVal.trim()},po_number.eq.${inputVal.trim()}`)
        .limit(1)
        .single();

      if (error || !data) {
        setStatusMsg('❌ No Pick Ticket found with that number.');
      } else {
        setPrintData(data);
        setPalletCount(1); // Reset pallet count
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
    setStatusMsg('⏳ Generating labels...');

    try {
      // Setup PDF (Standard 4x6 inch thermal label)
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'in',
        format: [4, 6]
      });

      // Loop for total pallets (e.g., 1 of 2, 2 of 2)
      for (let i = 1; i <= palletCount; i++) {
        // Loop for 2 copies per pallet
        for (let copy = 0; copy < 2; copy++) {
          
          // Add new page if not the first page
          if (!(i === 1 && copy === 0)) {
            doc.addPage();
          }

          const pageWidth = 4;
          const center = pageWidth / 2;

          // === TOP SECTION ===
          // Header: Customer (left) & DC# (right)
          doc.setFontSize(14);
          doc.setFont('helvetica', 'bold');
          doc.text(printData.customer || 'CUSTOMER', 0.2, 0.5);
          
          doc.setFontSize(12);
          doc.setFont('helvetica', 'normal');
          doc.text(`DC# ${printData.store_dc || 'N/A'}`, 3.8, 0.5, { align: 'right' });

          // Line separator
          doc.setLineWidth(0.02);
          doc.line(0.1, 0.7, 3.9, 0.7);

          // "Pick Ticket" title
          doc.setFontSize(16);
          doc.setFont('helvetica', 'normal');
          doc.text("Pick Ticket", center, 1.0, { align: 'center' });

          // Line separator
          doc.line(0.1, 1.2, 3.9, 1.2);

          // === MIDDLE SECTION ===
          // PT Number (LARGE)
          doc.setFontSize(32);
          doc.setFont('helvetica', 'bold');
          doc.text(printData.pt_number, center, 1.8, { align: 'center' });

          // PO Number (medium, bold)
          doc.setFontSize(20);
          doc.setFont('helvetica', 'bold');
          doc.text(`PO# ${printData.po_number}`, center, 2.3, { align: 'center' });

          // Cancel Date (formatted as MM/DD/YYYY)
          doc.setFontSize(10);
          doc.setFont('helvetica', 'normal');
          const formattedDate = formatDateForLabel(printData.cancel_date);
          doc.text(`Cancel Date: ${formattedDate}`, center, 2.6, { align: 'center' });

          // Line separator
          doc.line(0.1, 2.8, 3.9, 2.8);

          // === PALLET GRID BOX ===
          // Vertical "PLT#" text on left
          doc.setFontSize(10);
          doc.text("P", 0.3, 3.2);
          doc.text("L", 0.3, 3.4);
          doc.text("T", 0.3, 3.6);
          doc.text("#", 0.3, 3.8);

          // Vertical divider after PLT#
          doc.line(0.6, 2.8, 0.6, 4.2);

          // Current Pallet Number (HUGE)
          doc.setFontSize(48);
          doc.setFont('helvetica', 'bold');
          doc.text(`${i}`, 1.2, 3.8, { align: 'center' });

          // Divider before "of"
          doc.line(1.7, 2.8, 1.7, 4.2);

          // "of" text
          doc.setFontSize(12);
          doc.setFont('helvetica', 'normal');
          doc.text("of", 2.0, 3.6, { align: 'center' });

          // Divider after "of"
          doc.line(2.3, 2.8, 2.3, 4.2);

          // Total Pallets (HUGE)
          doc.setFontSize(48);
          doc.setFont('helvetica', 'bold');
          doc.text(`${palletCount}`, 3.0, 3.8, { align: 'center' });

          // Bottom line of grid
          doc.line(0.1, 4.2, 3.9, 4.2);

          // === BOTTOM SECTION (Footer repeat) ===
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

      // Auto-print and open PDF in new tab
      setStatusMsg('🖨️ Opening print dialog...');
      doc.autoPrint();
      const pdfBlob = doc.output('bloburl');
      window.open(pdfBlob, '_blank');

      setStatusMsg(`✅ Print dialog opened! ${palletCount * 2} labels ready.`);
      
      // Reset after 3 seconds
      setTimeout(() => {
        setPrinting(false);
        setPrintData(null);
        setInputVal('');
        setPalletCount(1);
        setStatusMsg('');
      }, 3000);

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Failed to generate PDF. Check console.');
      setPrinting(false);
    }
  }

  // Format date specifically for labels as MM/DD/YYYY
  function formatDateForLabel(dateStr: string | null): string {
    if (!dateStr) return 'N/A';
    // dateStr is YYYY-MM-DD from Supabase
    const [year, month, day] = dateStr.split('-');
    return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-2 md:p-8">
      <div className="max-w-2xl mx-auto">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 md:mb-8 gap-3">
          <h1 className="text-xl md:text-3xl font-bold">🖨️ Pallet Label Printer</h1>
          <Link 
            href="/" 
            className="bg-gray-700 hover:bg-gray-600 px-3 md:px-4 py-2 rounded text-sm md:text-base"
          >
            ← Back Home
          </Link>
        </div>

        {/* SEARCH BOX */}
        <div className="bg-gray-800 p-4 md:p-6 rounded-lg border border-gray-700 mb-6">
          <form onSubmit={handleSearch} className="flex flex-col gap-4">
            <label className="text-sm font-semibold text-gray-400">
              Scan or Type PT# / PO#
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder="Ex: 12345 or 123456789"
                className="flex-1 bg-gray-900 border border-gray-600 rounded-lg p-3 text-lg md:text-xl focus:border-blue-500 outline-none"
                autoFocus
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 px-4 md:px-6 py-3 rounded-lg font-bold disabled:opacity-50 text-sm md:text-base"
              >
                {loading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </form>
          {statusMsg && (
            <div className={`mt-4 text-center font-bold text-base md:text-lg ${statusMsg.includes('❌') ? 'text-red-400' : statusMsg.includes('✅') ? 'text-green-400' : 'text-blue-400'}`}>
              {statusMsg}
            </div>
          )}
        </div>

        {/* RESULT & PRINT CARD */}
        {printData && (
          <div className="bg-gray-800 p-4 md:p-6 rounded-lg border-2 border-blue-500 animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6 border-b border-gray-700 pb-4">
              <div>
                <p className="text-gray-400 text-xs md:text-sm">Customer</p>
                <p className="font-bold text-lg md:text-xl break-all">{printData.customer}</p>
              </div>
              <div className="sm:text-right">
                <p className="text-gray-400 text-xs md:text-sm">DC Number</p>
                <p className="font-bold text-lg md:text-xl">{printData.store_dc || 'N/A'}</p>
              </div>
              <div>
                <p className="text-gray-400 text-xs md:text-sm">PT Number</p>
                <p className="font-bold text-xl md:text-2xl text-blue-400">{printData.pt_number}</p>
              </div>
              <div className="sm:text-right">
                <p className="text-gray-400 text-xs md:text-sm">PO Number</p>
                <p className="font-bold text-lg md:text-xl break-all">{printData.po_number}</p>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <label className="text-base md:text-lg font-bold">How many pallets total?</label>
              <div className="flex flex-col sm:flex-row gap-3 md:gap-4 items-start sm:items-center">
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={palletCount}
                  onChange={(e) => setPalletCount(parseInt(e.target.value) || 1)}
                  className="bg-gray-900 border border-gray-600 rounded-lg p-3 md:p-4 text-2xl md:text-3xl font-bold w-full sm:w-32 text-center"
                />
                <div className="text-gray-400 text-xs md:text-sm">
                  x 2 copies = <span className="text-white font-bold text-sm md:text-base">{palletCount * 2}</span> total labels
                </div>
              </div>

              <button
                onClick={generateAndPrint}
                disabled={printing}
                className="mt-4 w-full bg-green-600 hover:bg-green-700 py-3 md:py-4 rounded-lg text-lg md:text-2xl font-bold transition-transform active:scale-95 disabled:bg-gray-600 disabled:scale-100"
              >
                {printing ? 'Generating...' : '🖨️ PRINT LABELS'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
