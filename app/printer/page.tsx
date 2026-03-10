'use client';

import { useRef, useState } from 'react';
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
  source_pt_numbers?: string[];
  source_po_numbers?: string[];
}

type PalletLookupRow = {
  pt_number: unknown;
  po_number: unknown;
  actual_pallet_count: unknown;
};

// CHANGE THIS PASSWORD TO WHATEVER YOU WANT
const REPRINT_PASSWORD = '12345';
const MAX_PALLET_COUNT = 50;
const PALLET_LOOKUP_CHUNK_SIZE = 150;
const PALLET_LOOKUP_PAGE_SIZE = 1000;

export default function PrinterPage() {
  const [inputVal, setInputVal] = useState('');
  const [loading, setLoading] = useState(false);
  const [printData, setPrintData] = useState<PrintData | null>(null);
  const [multiPTMode, setMultiPTMode] = useState(false);
  const [palletCountInput, setPalletCountInput] = useState('1');
  const [printing, setPrinting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showAnnieModal, setShowAnnieModal] = useState(false);
  const [annieProcessing, setAnnieProcessing] = useState(false);
  const [annieMessage, setAnnieMessage] = useState('');
  const [annieDragActive, setAnnieDragActive] = useState(false);
  const annieFileInputRef = useRef<HTMLInputElement | null>(null);
  const palletCount = parsePalletCount(palletCountInput);

  function normalizeKey(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
      const maybeText = value as { text?: unknown; result?: unknown };
      if (typeof maybeText.text === 'string') return maybeText.text.trim();
      if (maybeText.result !== undefined) return normalizeKey(maybeText.result);
    }
    return String(value).trim();
  }

  function isBlankValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (typeof value === 'object') {
      const maybeFormula = value as { result?: unknown; text?: unknown };
      if (maybeFormula.result !== undefined) return isBlankValue(maybeFormula.result);
      if (typeof maybeFormula.text === 'string') return maybeFormula.text.trim().length === 0;
    }
    return false;
  }

  function getOutputFileName(originalName: string): string {
    const dotIndex = originalName.lastIndexOf('.');
    if (dotIndex <= 0) return `${originalName}-annie-utd.xlsx`;
    const nameOnly = originalName.slice(0, dotIndex);
    const ext = originalName.slice(dotIndex);
    return `${nameOnly}-annie-utd${ext}`;
  }

  function compareTicketByPt(a: { pt_number: string }, b: { pt_number: string }) {
    const aDigits = a.pt_number.replace(/\D/g, '');
    const bDigits = b.pt_number.replace(/\D/g, '');
    if (aDigits && bDigits) {
      const aNum = Number(aDigits);
      const bNum = Number(bDigits);
      if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
        return aNum - bNum;
      }
    }
    return a.pt_number.localeCompare(b.pt_number, undefined, { numeric: true, sensitivity: 'base' });
  }

  function parseMultiTokens(rawValue: string): string[] {
    return Array.from(
      new Set(
        rawValue
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      )
    );
  }

  function buildPtRange(ptNumbers: string[]): string {
    if (ptNumbers.length === 0) return '';
    if (ptNumbers.length === 1) return ptNumbers[0];
    const sorted = [...ptNumbers].sort((a, b) => compareTicketByPt({ pt_number: a }, { pt_number: b }));
    return `${sorted[0]} - ${sorted[sorted.length - 1]}`;
  }

  function parsePalletCount(rawValue: string): number | null {
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_PALLET_COUNT) return null;
    return parsed;
  }

  function getPalletCountOrShowError(): number | null {
    const parsed = parsePalletCount(palletCountInput);
    if (parsed === null) {
      setStatusMsg(`❌ Please add pallet qty (1-${MAX_PALLET_COUNT}) before printing.`);
      return null;
    }
    return parsed;
  }

  async function fetchPalletRowsByColumn(column: 'pt_number' | 'po_number', values: string[]): Promise<PalletLookupRow[]> {
    const uniqueValues = Array.from(new Set(values.filter(Boolean)));
    if (uniqueValues.length === 0) return [];

    const rows: PalletLookupRow[] = [];

    for (let i = 0; i < uniqueValues.length; i += PALLET_LOOKUP_CHUNK_SIZE) {
      const chunk = uniqueValues.slice(i, i + PALLET_LOOKUP_CHUNK_SIZE);
      let from = 0;

      while (true) {
        const to = from + PALLET_LOOKUP_PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from('picktickets')
          .select('pt_number, po_number, actual_pallet_count')
          .not('actual_pallet_count', 'is', null)
          .in(column, chunk)
          .range(from, to);

        if (error) throw error;

        const batch = (data || []) as PalletLookupRow[];
        rows.push(...batch);
        if (batch.length < PALLET_LOOKUP_PAGE_SIZE) break;
        from += PALLET_LOOKUP_PAGE_SIZE;
      }
    }

    return rows;
  }

  async function handleAnnieFile(file: File) {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.xlsx')) {
      setAnnieMessage('❌ Please upload an .xlsx file.');
      return;
    }

    setAnnieProcessing(true);
    setAnnieMessage('Reading file and matching PT/PO rows...');

    try {
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      const buffer = await file.arrayBuffer();
      await workbook.xlsx.load(buffer);

      const sheet = workbook.worksheets[0];
      if (!sheet) {
        setAnnieMessage('❌ No worksheet found in the uploaded file.');
        return;
      }

      const rowsNeedingPallets: Array<{ rowNumber: number; pt: string; po: string }> = [];
      const lastRowNumber = sheet.rowCount;

      for (let rowNumber = 2; rowNumber <= lastRowNumber; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const ptValue = normalizeKey(row.getCell(4).value);
        const poValue = normalizeKey(row.getCell(5).value);
        if (!ptValue || !poValue) continue;

        const palletsCell = row.getCell(7);
        if (!isBlankValue(palletsCell.value)) continue;

        rowsNeedingPallets.push({ rowNumber, pt: ptValue, po: poValue });
      }

      if (rowsNeedingPallets.length === 0) {
        setAnnieMessage('⚠️ No empty pallet cells found in Column G.');
        return;
      }

      setAnnieMessage('Matching PT/PO rows with Supabase pallet counts...');
      const uniquePts = Array.from(new Set(rowsNeedingPallets.map((entry) => entry.pt)));
      const uniquePos = Array.from(new Set(rowsNeedingPallets.map((entry) => entry.po)));

      let palletRowsByPt: PalletLookupRow[] = [];
      let palletRowsByPo: PalletLookupRow[] = [];
      try {
        [palletRowsByPt, palletRowsByPo] = await Promise.all([
          fetchPalletRowsByColumn('pt_number', uniquePts),
          fetchPalletRowsByColumn('po_number', uniquePos)
        ]);
      } catch (queryError) {
        console.error('Annie UTD pallet lookup failed:', queryError);
        const detail = queryError instanceof Error ? ` (${queryError.message})` : '';
        setAnnieMessage(`❌ Failed to load pallet data from Supabase${detail}`);
        return;
      }

      const palletMap = new Map<string, number>();
      [...palletRowsByPt, ...palletRowsByPo].forEach((row) => {
        const pt = normalizeKey(row.pt_number);
        const po = normalizeKey(row.po_number);
        const pallets = typeof row.actual_pallet_count === 'number'
          ? row.actual_pallet_count
          : Number.parseInt(String(row.actual_pallet_count ?? ''), 10);
        if (!pt || !po || Number.isNaN(pallets)) return;
        palletMap.set(`${pt}::${po}`, pallets);
      });

      let filledCount = 0;
      rowsNeedingPallets.forEach(({ rowNumber, pt, po }) => {
        const mapKey = `${pt}::${po}`;
        const pallets = palletMap.get(mapKey);
        if (pallets === undefined) return;

        const row = sheet.getRow(rowNumber);
        const palletsCell = row.getCell(7);

        palletsCell.value = pallets;
        palletsCell.font = {
          ...(palletsCell.font || {}),
          name: 'Calibri',
          size: 18,
          bold: true,
          color: { argb: 'FFFF0000' }
        };
        filledCount++;
      });

      const updatedBuffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob(
        [updatedBuffer],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      );
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = getOutputFileName(file.name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 2000);

      if (filledCount === 0) {
        setAnnieMessage('⚠️ Downloaded unchanged file. No PT/PO matches with stored pallet counts were found.');
      } else {
        setAnnieMessage(`✅ Done. Filled ${filledCount} pallet cell${filledCount === 1 ? '' : 's'} and downloaded.`);
        setShowAnnieModal(false);
      }
    } catch (processError) {
      console.error('Annie UTD processing failed:', processError);
      const detail = processError instanceof Error ? ` (${processError.message})` : '';
      setAnnieMessage(`❌ Failed to process the file${detail}`);
    } finally {
      setAnnieProcessing(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!inputVal.trim()) return;

    setLoading(true);
    setPrintData(null);
    setStatusMsg('');

    try {
      if (multiPTMode) {
        const tokens = parseMultiTokens(inputVal);
        if (tokens.length < 2) {
          setStatusMsg('❌ Multi-PT mode requires 2+ PT/PO values separated by commas.');
          return;
        }

        const [byPtResponse, byPoResponse] = await Promise.all([
          supabase
            .from('picktickets')
            .select('id, pt_number, po_number, customer, store_dc, cancel_date, ctn')
            .in('pt_number', tokens),
          supabase
            .from('picktickets')
            .select('id, pt_number, po_number, customer, store_dc, cancel_date, ctn')
            .in('po_number', tokens)
        ]);

        if (byPtResponse.error || byPoResponse.error) {
          throw byPtResponse.error || byPoResponse.error;
        }

        const matchedById = new Map<number, {
          id: number;
          pt_number: string;
          po_number: string;
          customer: string;
          store_dc: string;
          cancel_date: string;
          ctn: string | null;
        }>();

        (byPtResponse.data || []).forEach((row) => matchedById.set(row.id, row));
        (byPoResponse.data || []).forEach((row) => matchedById.set(row.id, row));

        const matches = Array.from(matchedById.values());
        if (matches.length === 0) {
          setStatusMsg('❌ No Pick Tickets found for the entered PT/PO values.');
          return;
        }

        const unmatchedTokens = tokens.filter((token) => !matches.some((row) => row.pt_number === token || row.po_number === token));
        if (unmatchedTokens.length > 0) {
          setStatusMsg(`❌ Missing in system: ${unmatchedTokens.join(', ')}`);
          return;
        }

        const sortedMatches = [...matches].sort(compareTicketByPt);
        const first = sortedMatches[0];

        const mismatch = sortedMatches.find((row) =>
          row.customer !== first.customer ||
          row.store_dc !== first.store_dc ||
          row.cancel_date !== first.cancel_date ||
          (row.ctn || '') !== (first.ctn || '')
        );
        if (mismatch) {
          setStatusMsg('❌ Multi-PT rows must share customer, DC, cancel date, and CTN.');
          return;
        }

        const ptNumbers = sortedMatches.map((row) => row.pt_number);
        const poNumbers = sortedMatches.map((row) => row.po_number);
        const ptRange = buildPtRange(ptNumbers);

        const { data: historyData } = await supabase
          .from('print_history')
          .select('id')
          .in('pt_number', ptNumbers);

        setPrintData({
          id: first.id,
          pt_number: ptRange,
          po_number: first.po_number,
          customer: first.customer,
          store_dc: first.store_dc,
          cancel_date: first.cancel_date,
          ctn: first.ctn || undefined,
          has_been_printed: Boolean(historyData && historyData.length > 0),
          source_pt_numbers: ptNumbers,
          source_po_numbers: poNumbers
        });
        setPalletCountInput('1');
        setStatusMsg('');
      } else {
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
        setPalletCountInput('1');
        setStatusMsg('');
      }

    } catch (err) {
      console.error(err);
      setStatusMsg('❌ Error searching');
    } finally {
      setLoading(false);
    }
  }

  async function handlePrintClick() {
    if (!printData) return;
    const palletQty = getPalletCountOrShowError();
    if (palletQty === null) return;

    // If already printed, show password prompt
    if (printData.has_been_printed) {
      setShowPasswordPrompt(true);
      return;
    }

    // First time print - send directly
    await sendToPrintQueue(palletQty);
  }

  async function handleReprintWithPassword() {
    const palletQty = getPalletCountOrShowError();
    if (palletQty === null) return;

    if (passwordInput !== REPRINT_PASSWORD) {
      alert('❌ Incorrect password');
      setPasswordInput('');
      return;
    }

    setShowPasswordPrompt(false);
    setPasswordInput('');
    await sendToPrintQueue(palletQty, true);
  }

  async function sendToPrintQueue(palletQty: number, isReprint = false) {
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
          pallet_count: palletQty,
          status: 'pending',
          is_reprint: isReprint,
          ctn: printData.ctn || null
        });

      if (queueError) throw queueError;

      // Add to print history if first time
      if (!isReprint) {
        const sourcePtNumbers = printData.source_pt_numbers && printData.source_pt_numbers.length > 0
          ? printData.source_pt_numbers
          : [printData.pt_number];

        await supabase
          .from('print_history')
          .insert(
            sourcePtNumbers.map((ptNumber) => ({
              pt_number: ptNumber,
              po_number: printData.po_number,
              customer: printData.customer,
              pallet_count: palletQty
            }))
          );
      }

      setStatusMsg(`✅ Sent to printer! ${palletQty * 2} labels queued.`);

      setTimeout(() => {
        setPrinting(false);
        setPrintData(null);
        setInputVal('');
        setPalletCountInput('1');
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setAnnieMessage('');
                setShowAnnieModal(true);
              }}
              className="hidden md:inline-block bg-pink-600 hover:bg-pink-700 px-3 md:px-4 py-2 rounded text-sm md:text-base font-bold"
            >
              Annie UTD
            </button>
            <Link
              href="/"
              className="bg-gray-700 hover:bg-gray-600 px-3 md:px-4 py-2 rounded text-sm md:text-base"
            >
              ← Back
            </Link>
          </div>
        </div>

        <div className="bg-gray-800 p-4 md:p-6 rounded-lg border border-gray-700 mb-6">
          <form onSubmit={handleSearch} className="flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <label className="text-sm font-semibold text-gray-400">
                {multiPTMode ? 'Enter PT#/PO# list (comma separated)' : 'Scan or Type PT# / PO#'}
              </label>
              <label className="flex items-center gap-2 text-xs md:text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={multiPTMode}
                  onChange={(event) => {
                    setMultiPTMode(event.target.checked);
                    setPrintData(null);
                    setStatusMsg('');
                  }}
                />
                Multi-PT mode
              </label>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                placeholder={multiPTMode ? 'Ex: 4756676, 4756677, 4756678' : 'Ex: 12345 or 123456789'}
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
            {multiPTMode && (
              <div className="text-xs text-gray-400">
                Uses the lowest PT as reference row, prints PT range (min-max), and keeps PO/customer/DC/date/CTN from that reference.
              </div>
            )}
          </form>
          {statusMsg && (
            <div className={`mt-4 text-center font-bold text-base md:text-lg ${statusMsg.includes('❌') ? 'text-red-400' : statusMsg.includes('✅') ? 'text-green-400' : 'text-blue-400'}`}>
              {statusMsg}
            </div>
          )}
        </div>

        {annieMessage && (
          <div className={`mb-6 text-center font-bold text-sm md:text-base ${annieMessage.startsWith('✅') ? 'text-green-400' : annieMessage.startsWith('❌') ? 'text-red-400' : 'text-blue-400'}`}>
            {annieMessage}
          </div>
        )}

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
              {printData.source_pt_numbers && printData.source_pt_numbers.length > 1 && (
                <div className="sm:col-span-2">
                  <p className="text-gray-400 text-xs md:text-sm">Included PTs</p>
                  <p className="font-semibold text-sm md:text-base break-all">
                    {printData.source_pt_numbers.join(', ')}
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4">
              <label className="text-base md:text-lg font-bold">How many pallets total?</label>
              <div className="flex flex-col sm:flex-row gap-3 md:gap-4 items-start sm:items-center">
                <input
                  type="number"
                  min="1"
                  max={MAX_PALLET_COUNT}
                  value={palletCountInput}
                  onChange={(e) => {
                    const nextValue = e.target.value.trim();
                    if (nextValue === '') {
                      setPalletCountInput('');
                      return;
                    }

                    if (!/^\d+$/.test(nextValue)) return;
                    const parsed = Number.parseInt(nextValue, 10);

                    if (!Number.isFinite(parsed) || parsed <= 0) {
                      setPalletCountInput('');
                      return;
                    }

                    const clamped = Math.min(parsed, MAX_PALLET_COUNT);
                    setPalletCountInput(String(clamped));
                    if (statusMsg.startsWith('❌ Please add pallet qty')) {
                      setStatusMsg('');
                    }
                  }}
                  className="bg-gray-900 border border-gray-600 rounded-lg p-3 md:p-4 text-2xl md:text-3xl font-bold w-full sm:w-32 text-center"
                  disabled={showPasswordPrompt}
                />
                <div className="text-gray-400 text-xs md:text-sm">
                  x 2 copies = <span className="text-white font-bold text-sm md:text-base">{palletCount === null ? '--' : palletCount * 2}</span> total labels
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

        {showAnnieModal && (
          <div className="fixed inset-0 bg-black/75 z-[70] flex items-center justify-center p-4">
            <div className="w-full max-w-2xl bg-gray-800 border border-gray-600 rounded-xl p-4 md:p-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg md:text-2xl font-bold text-pink-300">Annie UTD</h2>
                <button
                  onClick={() => setShowAnnieModal(false)}
                  className="text-2xl md:text-3xl hover:text-red-400"
                >
                  &times;
                </button>
              </div>

              <p className="text-xs md:text-sm text-gray-300 mb-4">
                Upload Annie&apos;s .xlsx file. Missing Column G pallet values will be filled from PT/PO matches in your system, then downloaded immediately.
              </p>

              <input
                ref={annieFileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => {
                  const selected = e.target.files?.[0];
                  if (selected) {
                    void handleAnnieFile(selected);
                  }
                  e.currentTarget.value = '';
                }}
              />

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setAnnieDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setAnnieDragActive(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setAnnieDragActive(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped) {
                    void handleAnnieFile(dropped);
                  }
                }}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${annieDragActive ? 'border-pink-400 bg-pink-900/20' : 'border-gray-500 bg-gray-900/40'}`}
              >
                <div className="text-sm md:text-lg font-semibold mb-2">
                  Drag and drop Annie&apos;s .xlsx here
                </div>
                <button
                  disabled={annieProcessing}
                  onClick={() => annieFileInputRef.current?.click()}
                  className="bg-pink-600 hover:bg-pink-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-bold text-sm md:text-base"
                >
                  {annieProcessing ? 'Processing...' : 'Browse File'}
                </button>
              </div>

              {annieProcessing && (
                <div className="mt-3 text-blue-300 text-sm font-semibold">
                  Processing file...
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
