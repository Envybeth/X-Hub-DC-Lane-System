'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';

interface PrintData {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  store_dc: string;
  cancel_date: string;
  has_been_printed: boolean;
  ctn?: string;
}

// CHANGE THIS PASSWORD TO WHATEVER YOU WANT
const REPRINT_PASSWORD = '12345';

export default function PrinterPage() {
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [printData, setPrintData] = useState<PrintData | null>(null);
  const [palletCount, setPalletCount] = useState<number>(1);
  const [printing, setPrinting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inputVal.trim()) return;

    setLoading(true);
    setPrintData(null);
    setStatusMsg('');

    try {
      // Check if PT exists
      const { data, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, store_dc, cancel_date, ctn')
        .or(`pt_number.eq.${inputVal.trim()},po_number.eq.${inputVal.trim()}`)
        .limit(1)
        .single();

      if (error || !data) {
        setStatusMsg('❌ No Pick Ticket found');
        return;
      }

      // Check if already printed
      const { data: historyData } = await supabase
        .from('print_history')
        .select('id')
        .eq('pt_number', data.pt_number)
        .limit(1);

      const hasPrinted = historyData && historyData.length > 0;

      setPrintData({
        ...data,
        has_been_printed: hasPrinted || false
      });
      setPalletCount(1);
      setStatusMsg('');

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Error searching');
    } finally {
      setLoading(false);
    }
  }

  async function handlePrintClick() {
    if (!printData) return;

    // If already printed, show password prompt
    if (printData.has_been_printed) {
      setShowPasswordPrompt(true);
      return;
    }

    // First time print - send directly
    await sendToPrintQueue();
  }

  async function handleReprintWithPassword() {
    if (passwordInput !== REPRINT_PASSWORD) {
      alert('❌ Incorrect password');
      setPasswordInput('');
      return;
    }

    setShowPasswordPrompt(false);
    setPasswordInput('');
    await sendToPrintQueue(true);
  }

  async function sendToPrintQueue(isReprint = false) {
    if (!printData) return;
    setPrinting(true);
    setStatusMsg('⏳ Sending to printer...');

    try {
      // Add to print queue
      const { error: queueError } = await supabase
        .from('print_queue')
        .insert({
          pt_number: printData.pt_number,
          po_number: printData.po_number,
          customer: printData.customer,
          store_dc: printData.store_dc,
          cancel_date: printData.cancel_date,
          pallet_count: palletCount,
          status: 'pending',
          is_reprint: isReprint,
          ctn: printData.ctn || null
        });

      if (queueError) throw queueError;

      // Add to print history if first time
      if (!isReprint) {
        await supabase
          .from('print_history')
          .insert({
            pt_number: printData.pt_number,
            po_number: printData.po_number,
            customer: printData.customer,
            pallet_count: palletCount
          });
      }

      setStatusMsg(`✅ Sent to printer! ${palletCount * 2} labels queued.`);

      setTimeout(() => {
        setPrinting(false);
        setPrintData(null);
        setInputVal('');
        setPalletCount(1);
        setStatusMsg('');
      }, 2000);

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Failed to send to printer');
      setPrinting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-2 md:p-8">
      <div className="max-w-2xl mx-auto">

        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6 md:mb-8 gap-3">
          <h1 className="text-xl md:text-3xl font-bold">🖨️ Pallet Label Printer</h1>
          <Link
            href="/"
            className="bg-gray-700 hover:bg-gray-600 px-3 md:px-4 py-2 rounded text-sm md:text-base"
          >
            ← Back
          </Link>
        </div>

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

        {printData && (
          <div className="bg-gray-800 p-4 md:p-6 rounded-lg border-2 border-blue-500 animate-fade-in relative">

            {/* PRINTED BADGE */}
            {printData.has_been_printed && (
              <div className="absolute top-4 right-4 bg-red-600 px-4 py-2 rounded-lg border-2 border-red-400 animate-pulse">
                <div className="text-white font-bold text-lg">⚠️ PRINTED</div>
              </div>
            )}

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
              <div>
                <p className="text-gray-400 text-xs md:text-sm">CTN</p>
                <p className="font-bold text-lg md:text-xl">{printData.ctn || 'N/A'}</p>
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
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      setPalletCount(0); // Allow empty temporarily
                    } else {
                      setPalletCount(parseInt(val) || 1);
                    }
                  }}
                  onBlur={(e) => {
                    // Set to 1 if empty when user leaves the field
                    if (e.target.value === '' || palletCount === 0) {
                      setPalletCount(1);
                    }
                  }}
                  className="bg-gray-900 border border-gray-600 rounded-lg p-3 md:p-4 text-2xl md:text-3xl font-bold w-full sm:w-32 text-center"
                  disabled={showPasswordPrompt}
                />
                <div className="text-gray-400 text-xs md:text-sm">
                  x 2 copies = <span className="text-white font-bold text-sm md:text-base">{palletCount * 2}</span> total labels
                </div>
              </div>

              {!showPasswordPrompt ? (
                <button
                  onClick={handlePrintClick}
                  disabled={printing}
                  className={`mt-4 w-full py-3 md:py-4 rounded-lg text-lg md:text-2xl font-bold transition-transform active:scale-95 disabled:bg-gray-600 disabled:scale-100 ${printData.has_been_printed
                    ? 'bg-orange-600 hover:bg-orange-700'
                    : 'bg-green-600 hover:bg-green-700'
                    }`}
                >
                  {printing ? 'Sending...' : printData.has_been_printed ? '🔒 REPRINT (Password Required)' : '🖨️ PRINT LABELS'}
                </button>
              ) : (
                <div className="mt-4 bg-red-900 border-2 border-red-600 p-4 rounded-lg">
                  <label className="block text-sm font-bold mb-2 text-white">Enter Reprint Password:</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="Password"
                      className="flex-1 bg-gray-900 border border-gray-600 rounded-lg p-3 text-lg"
                      autoFocus
                    />
                    <button
                      onClick={handleReprintWithPassword}
                      className="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-lg font-bold"
                    >
                      Submit
                    </button>
                    <button
                      onClick={() => {
                        setShowPasswordPrompt(false);
                        setPasswordInput('');
                      }}
                      className="bg-gray-600 hover:bg-gray-700 px-4 py-3 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}