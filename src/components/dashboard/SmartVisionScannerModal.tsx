import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Camera,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Landmark,
  Loader2,
  ScanLine,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useAccounting } from '../../context/AccountingContext';
import { formatMoney, getTodayShamsi, toPersianDigits } from '../../lib/format';
import type { ChequeDirection, VoucherType } from '../../types/accounting';

interface ExtractedScanItem {
  name?: string;
  quantity?: number;
  unitPriceIrr?: number;
}

interface ExtractedVisionDocument {
  documentType: 'receipt' | 'invoice' | 'cheque' | 'voucher';
  confidencePct?: number;
  dateShamsi?: string;
  dueDateShamsi?: string;
  amountIrr: number;
  partyName?: string;
  bankName?: string;
  sayadiId?: string;
  serial?: string;
  chequeDirection?: ChequeDirection;
  invoiceType?: 'purchase' | 'sale' | 'proforma';
  description: string;
  suggestedDebitAccountCode?: string;
  suggestedCreditAccountCode?: string;
  items?: ExtractedScanItem[];
  warnings?: string[];
}

interface SmartVisionScannerModalProps {
  open: boolean;
  onClose: () => void;
  onCommitted?: (message: string) => void;
}

const DOC_HINT_OPTIONS = [
  { id: 'auto', label: 'تشخیص خودکار' },
  { id: 'receipt', label: 'فیش بانکی / کارتخوان' },
  { id: 'invoice', label: 'فاکتور خرید / فروش' },
  { id: 'cheque', label: 'چک صیادی' },
] as const;

type DocumentHint = (typeof DOC_HINT_OPTIONS)[number]['id'];

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('خواندن فایل تصویر ناموفق بود.'));
    reader.readAsDataURL(file);
  });
}

async function compressImageIfNeeded(file: File): Promise<{ base64: string; mimeType: string; previewUrl: string }> {
  const dataUrl = await readFileAsDataUrl(file);
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
  const originalMime = allowedMimes.includes(file.type.toLowerCase()) ? file.type.toLowerCase() : 'image/jpeg';

  // Keep images under ~3.5MB for fast multimodal Vision OCR upload
  if (file.size <= 3_500_000 && allowedMimes.includes(file.type.toLowerCase())) {
    const base64 = dataUrl.split(',')[1] || '';
    return { base64, mimeType: originalMime, previewUrl: dataUrl };
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        const base64 = dataUrl.split(',')[1] || '';
        resolve({ base64, mimeType: originalMime, previewUrl: dataUrl });
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL('image/jpeg', 0.84);
      resolve({
        base64: compressed.split(',')[1] || '',
        mimeType: 'image/jpeg',
        previewUrl: compressed,
      });
    };
    img.onerror = () => reject(new Error('تصویر انتخاب‌شده قابل پردازش نیست.'));
    img.src = dataUrl;
  });
}

export const SmartVisionScannerModal: React.FC<SmartVisionScannerModalProps> = ({
  open,
  onClose,
  onCommitted,
}) => {
  const {
    profile,
    accounts,
    parties,
    products,
    createVoucher,
    addCheque,
    createInvoice,
    showToast,
  } = useAccounting();

  const unit = profile.currencyUnit;
  const todayShamsi = getTodayShamsi();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const [documentHint, setDocumentHint] = useState<DocumentHint>('auto');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confidencePct, setConfidencePct] = useState<number | null>(null);

  // Editable form fields (populated automatically by Gemini Vision OCR, or manually editable)
  const [docType, setDocType] = useState<'receipt' | 'invoice' | 'cheque' | 'voucher'>('receipt');
  const [dateShamsi, setDateShamsi] = useState(todayShamsi);
  const [dueDateShamsi, setDueDateShamsi] = useState(todayShamsi);
  const [amountIrr, setAmountIrr] = useState<number>(0);
  const [partyName, setPartyName] = useState('');
  const [bankName, setBankName] = useState('');
  const [sayadiId, setSayadiId] = useState('');
  const [serial, setSerial] = useState('');
  const [chequeDirection, setChequeDirection] = useState<ChequeDirection>('receivable');
  const [description, setDescription] = useState('');
  const [debitCode, setDebitCode] = useState('60101');
  const [creditCode, setCreditCode] = useState('10201');
  const [extractedItems, setExtractedItems] = useState<ExtractedScanItem[]>([]);

  const leafAccounts = useMemo(
    () => accounts.filter((a) => a.level === 'moein' || a.level === 'tafsili'),
    [accounts]
  );

  if (!open) return null;

  const findAccountByCode = (code: string, fallbackPrefix: string) => {
    const exact = leafAccounts.find((a) => a.code === code);
    if (exact) return exact;
    const pref = leafAccounts.find((a) => a.code.startsWith(fallbackPrefix));
    return pref ?? leafAccounts[0];
  };

  const matchParty = (name: string) => {
    const clean = name.trim().toLowerCase();
    if (!clean) return undefined;
    return (
      parties.find((p) => p.name.toLowerCase().includes(clean) || clean.includes(p.name.toLowerCase())) ??
      undefined
    );
  };

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setErrorMsg(null);
    setWarnings([]);
    setScanning(true);

    try {
      const { base64, mimeType, previewUrl: url } = await compressImageIfNeeded(file);
      setPreviewUrl(url);

      const { detectOptionalBackendServer, isJsonHttpResponse } = await import('../../lib/staticRuntimeGuard');
      const hasBackend = await detectOptionalBackendServer();
      if (!hasBackend) {
        setErrorMsg(
          'برنامه در حالت مستقل بدون سرور (Static PWA) اجرا می‌شود. تصویر پیش‌نمایش بارگذاری شد؛ می‌توانید فیلدهای زیر را مستقیم و کاملاً آفلاین تکمیل و ثبت کنید یا از ورود گروهی اکسل استفاده نمایید.'
        );
        return;
      }

      const accountsHint = leafAccounts.slice(0, 24).map((a) => `${a.code}:${a.title}`);
      const resp = await fetch('/api/ai/vision-scan', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'HolooApex',
        },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType,
          documentHint,
          accountsHint,
        }),
      });

      const payload = (
        isJsonHttpResponse(resp) ? await resp.json().catch(() => ({})) : {}
      ) as {
        ok?: boolean;
        error?: string;
        extracted?: ExtractedVisionDocument;
      };

      if (!resp.ok || !payload.extracted) {
        setErrorMsg(payload.error || 'استخراج هوشمند تصویر انجام نشد. می‌توانید اطلاعات سند را به صورت دستی ثبت کنید.');
        return;
      }

      const ext = payload.extracted;
      const normalizedType =
        ext.documentType === 'invoice' ||
        ext.documentType === 'cheque' ||
        ext.documentType === 'voucher' ||
        ext.documentType === 'receipt'
          ? ext.documentType
          : 'receipt';

      setDocType(normalizedType);
      setConfidencePct(typeof ext.confidencePct === 'number' ? Math.round(ext.confidencePct) : 92);
      setDateShamsi(ext.dateShamsi && ext.dateShamsi.trim() ? ext.dateShamsi.trim() : todayShamsi);
      setDueDateShamsi(
        ext.dueDateShamsi && ext.dueDateShamsi.trim() ? ext.dueDateShamsi.trim() : ext.dateShamsi || todayShamsi
      );
      setAmountIrr(Math.max(0, Math.round(Number(ext.amountIrr) || 0)));
      setPartyName(ext.partyName?.trim() || '');
      setBankName(ext.bankName?.trim() || '');
      setSayadiId(ext.sayadiId?.replace(/\D/g, '').slice(0, 16) || '');
      setSerial(ext.serial?.trim() || '');
      setChequeDirection(ext.chequeDirection === 'payable' ? 'payable' : 'receivable');
      setDescription(ext.description?.trim() || 'سند استخراج‌شده با اسکنر هوشمند OCR');
      setWarnings(Array.isArray(ext.warnings) ? ext.warnings.filter(Boolean) : []);
      setExtractedItems(Array.isArray(ext.items) ? ext.items : []);

      const debAcc = findAccountByCode(
        ext.suggestedDebitAccountCode || (normalizedType === 'invoice' ? '10501' : '60101'),
        normalizedType === 'invoice' ? '105' : '601'
      );
      const crdAcc = findAccountByCode(
        ext.suggestedCreditAccountCode || (normalizedType === 'invoice' ? '30101' : '10201'),
        normalizedType === 'invoice' ? '301' : '102'
      );
      if (debAcc) setDebitCode(debAcc.code);
      if (crdAcc) setCreditCode(crdAcc.code);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'خطا در برقراری ارتباط با سرویس اسکن هوشمند.');
    } finally {
      setScanning(false);
    }
  };

  const handleCommitDraftVoucher = async () => {
    if (amountIrr <= 0) {
      setErrorMsg('مبلغ سند باید بزرگ‌تر از صفر باشد.');
      return;
    }
    setCommitting(true);
    setErrorMsg(null);
    try {
      const debAcc = findAccountByCode(debitCode, '601');
      const crdAcc = findAccountByCode(creditCode, '102');
      if (!debAcc || !crdAcc) {
        setErrorMsg('حساب بدهکار یا بستانکار معتبر در کدینگ یافت نشد.');
        return;
      }
      const matched = matchParty(partyName);
      const vType: VoucherType =
        docType === 'cheque' || docType === 'receipt'
          ? 'treasury'
          : docType === 'invoice'
            ? 'purchase'
            : 'general';

      const created = await createVoucher({
        date: dateShamsi || todayShamsi,
        description: description.trim() || `ثبت خودکار OCR${partyName ? ` — ${partyName}` : ''}`,
        voucherType: vType,
        status: 'draft',
        lines: [
          {
            accountCode: debAcc.code,
            accountTitle: debAcc.title,
            partyId: debAcc.requiresParty ? matched?.id : undefined,
            partyName: debAcc.requiresParty ? matched?.name : undefined,
            description: description.trim() || 'آرتیکل بدهکار اسکن هوشمند',
            debit: Math.round(amountIrr),
            credit: 0,
          },
          {
            accountCode: crdAcc.code,
            accountTitle: crdAcc.title,
            partyId: crdAcc.requiresParty ? matched?.id : undefined,
            partyName: crdAcc.requiresParty ? matched?.name : undefined,
            description: description.trim() || 'آرتیکل بستانکار اسکن هوشمند',
            debit: 0,
            credit: Math.round(amountIrr),
          },
        ],
      });

      const msg = `سند موقت #${toPersianDigits(created.voucherNumber)} از روی تصویر در کارتابل تأیید ثبت شد.`;
      showToast(msg, 'success');
      onCommitted?.(msg);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'خطا در ثبت سند حسابداری موقت.');
    } finally {
      setCommitting(false);
    }
  };

  const handleCommitSayadiCheque = async () => {
    if (amountIrr <= 0) {
      setErrorMsg('مبلغ چک باید بزرگ‌تر از صفر باشد.');
      return;
    }
    setCommitting(true);
    setErrorMsg(null);
    try {
      const matched = matchParty(partyName) ?? parties[0];
      await addCheque({
        sayadiId: sayadiId.length === 16 ? sayadiId : String(Date.now()).padEnd(16, '0').slice(0, 16),
        serial: serial || `OCR-${String(Date.now()).slice(-6)}`,
        direction: chequeDirection,
        partyId: matched?.id || 'general',
        partyName: partyName.trim() || matched?.name || 'طرف حساب عمومی',
        bankName: bankName.trim() || 'بانک ملت',
        amount: Math.round(amountIrr),
        issueDate: dateShamsi || todayShamsi,
        dueDate: dueDateShamsi || dateShamsi || todayShamsi,
        status: 'in_box',
        notes: description.trim() || 'ثبت خودکار از اسکن تصویری چک صیادی',
      });
      const msg = `چک صیادی ${chequeDirection === 'receivable' ? 'دریافتی' : 'پرداختی'} به مبلغ ${formatMoney(amountIrr, unit)} در خزانه‌داری ثبت شد.`;
      showToast(msg, 'success');
      onCommitted?.(msg);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'خطا در ثبت چک صیادی.');
    } finally {
      setCommitting(false);
    }
  };

  const handleCommitProforma = async () => {
    if (amountIrr <= 0) {
      setErrorMsg('مبلغ فاکتور باید بزرگ‌تر از صفر باشد.');
      return;
    }
    setCommitting(true);
    setErrorMsg(null);
    try {
      const matchedParty = matchParty(partyName) ?? parties[0];
      const defaultProduct = products[0];
      if (!matchedParty || !defaultProduct) {
        setErrorMsg('حداقل یک طرف‌حساب و یک کالا در سیستم برای ثبت پیش‌فاکتور لازم است.');
        return;
      }

      const firstItem = extractedItems[0];
      const qty = firstItem?.quantity && firstItem.quantity > 0 ? firstItem.quantity : 1;
      const subtotal = Math.round(amountIrr / 1.1);
      const vatAmount = Math.round(amountIrr - subtotal);
      const unitPrice = Math.max(1, Math.round(subtotal / qty));

      const created = await createInvoice({
        invoiceNumber: `PF-OCR-${String(Date.now()).slice(-5)}`,
        invoiceType: 'proforma',
        date: dateShamsi || todayShamsi,
        partyId: matchedParty.id,
        partyName: partyName.trim() || matchedParty.name,
        warehouse: defaultProduct.warehouse || 'انبار مرکزی',
        subtotal,
        discount: 0,
        vatAmount,
        grandTotal: Math.round(amountIrr),
        paidCash: 0,
        paidBank: 0,
        paidCheque: 0,
        creditAmount: Math.round(amountIrr),
        status: 'issued',
        items: [
          {
            productId: defaultProduct.id,
            sku: defaultProduct.sku,
            productName: firstItem?.name?.trim() || defaultProduct.name,
            unit: defaultProduct.unit,
            quantity: qty,
            unitPrice,
            discount: 0,
            vatAmount,
            lineTotal: Math.round(amountIrr),
          },
        ],
      });

      const msg = `پیش‌فاکتور ${created.invoiceNumber} در کارتابل تأیید فاکتورها ثبت شد.`;
      showToast(msg, 'success');
      onCommitted?.(msg);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'خطا در ثبت پیش‌فاکتور.');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/60 backdrop-blur-xs no-print"
      role="dialog"
      aria-modal="true"
      aria-label="اسکنر هوشمند اسناد مالی (Vision OCR)"
    >
      <div className="w-full max-w-3xl max-h-[90dvh] overflow-y-auto rounded-2xl bg-white dark:bg-[#151A24] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl">
        {/* Modal Header */}
        <div className="px-5 py-4 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-3 sticky top-0 bg-white/95 dark:bg-[#151A24]/95 backdrop-blur-md z-10">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shrink-0">
              <ScanLine className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                ثبت خودکار اسناد از روی تصویر (Vision OCR)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                عکس فاکتور، فیش بانکی یا چک صیادی را بارگذاری کنید تا فیلدها استخراج و آماده ثبت در کارتابل شوند
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره اسکن هوشمند"
            className="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Document Hint Segmented Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="tablist"
              aria-label="نوع سند برای اسکن دقیق‌تر"
              className="inline-flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800"
            >
              {DOC_HINT_OPTIONS.map((opt) => {
                const active = documentHint === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setDocumentHint(opt.id)}
                    className={`h-8 px-3 rounded-lg text-xs transition-colors cursor-pointer ${
                      active
                        ? 'bg-white dark:bg-[#151A24] text-slate-900 dark:text-white font-semibold shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 font-medium'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {confidencePct !== null && (
              <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5 tabular-nums">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>دقت استخراج تصویر: {toPersianDigits(confidencePct)}٪</span>
              </div>
            )}
          </div>

          {/* Upload / Camera Capture Drop Zone */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
            <div className="md:col-span-5 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-950/40 p-4 flex flex-col items-center justify-center text-center gap-3 min-h-[210px]">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="پیش‌نمایش سند اسکن‌شده"
                  className="max-h-44 w-full object-contain rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
                />
              ) : (
                <div className="space-y-1.5">
                  <Sparkles className="w-7 h-7 text-indigo-600 dark:text-indigo-400 mx-auto" />
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    تصویر فاکتور، فیش یا چک صیادی را انتخاب کنید
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    پشتیبانی از JPG، PNG و WEBP (حداکثر ۶ مگابایت)
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic"
                  className="hidden"
                  onChange={(e) => {
                    void handleFileSelected(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    void handleFileSelected(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  <span>{scanning ? 'در حال تحلیل تصویر...' : previewUrl ? 'تغییر تصویر' : 'انتخاب تصویر'}</span>
                </button>
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => cameraInputRef.current?.click()}
                  className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>دوربین</span>
                </button>
              </div>
            </div>

            {/* Editable Extracted Fields */}
            <div className="md:col-span-7 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    نوع سند تشخیص‌داده‌شده
                  </label>
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as typeof docType)}
                    className="w-full h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                  >
                    <option value="receipt">فیش بانکی / هزینه</option>
                    <option value="invoice">فاکتور خرید / فروش</option>
                    <option value="cheque">چک صیادی</option>
                    <option value="voucher">سند حسابداری عمومی</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    مبلغ کل (ریال)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={amountIrr || ''}
                    onChange={(e) => setAmountIrr(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    placeholder="مثلاً 450000000"
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-slate-900 dark:text-white"
                  />
                  {amountIrr > 0 && (
                    <div className="text-[10.5px] text-slate-500 dark:text-slate-400 mt-0.5 font-code tabular-nums">
                      معادل نمایشی: {formatMoney(amountIrr, unit)}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    تاریخ سند (شمسی)
                  </label>
                  <input
                    type="text"
                    value={dateShamsi}
                    onChange={(e) => setDateShamsi(e.target.value)}
                    placeholder="1405/01/15"
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    طرف حساب / فروشنده / صادرکننده
                  </label>
                  <input
                    type="text"
                    value={partyName}
                    onChange={(e) => setPartyName(e.target.value)}
                    placeholder="نام شخص یا شرکت"
                    className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                  />
                </div>

                {docType === 'cheque' && (
                  <>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        شناسه صیادی ۱۶ رقمی
                      </label>
                      <input
                        type="text"
                        value={sayadiId}
                        onChange={(e) => setSayadiId(e.target.value.replace(/\D/g, '').slice(0, 16))}
                        placeholder="16 رقم شناسه صیادی"
                        className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        تاریخ سررسید و بانک
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          type="text"
                          value={dueDateShamsi}
                          onChange={(e) => setDueDateShamsi(e.target.value)}
                          placeholder="سررسید"
                          className="h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-code tabular-nums text-slate-900 dark:text-white"
                        />
                        <input
                          type="text"
                          value={bankName}
                          onChange={(e) => setBankName(e.target.value)}
                          placeholder="نام بانک"
                          className="h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    حساب بدهکار پیشنهادی
                  </label>
                  <select
                    value={debitCode}
                    onChange={(e) => setDebitCode(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                  >
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.code}>
                        {toPersianDigits(a.code)} — {a.title}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    حساب بستانکار پیشنهادی
                  </label>
                  <select
                    value={creditCode}
                    onChange={(e) => setCreditCode(e.target.value)}
                    className="w-full h-9 px-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                  >
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.code}>
                        {toPersianDigits(a.code)} — {a.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  شرح سند
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="توضیحات استخراج‌شده از تصویر..."
                  className="w-full h-9 px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-900 dark:text-white"
                />
              </div>
            </div>
          </div>

          {/* Warnings or Error Banner */}
          {warnings.length > 0 && (
            <div className="rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/70 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-200 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>نکات کنترلی استخراج تصویر:</span>
              </div>
              <div className="text-[11px] leading-relaxed">{warnings.join(' · ')}</div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-xl bg-rose-50/90 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 px-3.5 py-2.5 text-xs text-rose-800 dark:text-rose-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="leading-relaxed">{errorMsg}</span>
            </div>
          )}

          {/* Action Footer */}
          <div className="pt-3 border-t border-slate-200/80 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              پس از ثبت، سند بلافاصله در کارتابل تأیید داشبورد با ممیزی خودکار نمایش داده می‌شود.
            </span>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={committing || amountIrr <= 0}
                onClick={() => void handleCommitDraftVoucher()}
                className="h-9 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookOpen className="w-3.5 h-3.5" />}
                <span>ثبت سند موقت در کارتابل</span>
              </button>

              {docType === 'cheque' && (
                <button
                  type="button"
                  disabled={committing || amountIrr <= 0}
                  onClick={() => void handleCommitSayadiCheque()}
                  className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Landmark className="w-3.5 h-3.5" />
                  <span>ثبت چک صیادی</span>
                </button>
              )}

              {docType === 'invoice' && (
                <button
                  type="button"
                  disabled={committing || amountIrr <= 0}
                  onClick={() => void handleCommitProforma()}
                  className="h-9 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>ثبت پیش‌فاکتور</span>
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                className="h-9 px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer transition-colors"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
