// Supabase Edge Function: read-invoice — v2 (دقة عالية + تحقق ذاتي)
// يقرأ فاتورة (صورة/مقاطع مكبّرة/PDF) ويرجّع الحقول مع نتيجة التحقق لكل حقل.
// الأسرار: ANTHROPIC_API_KEY (إلزامي)، INVOICE_MODEL_OVERRIDE (اختياري لفرض موديل معيّن).
// المدخلات (JSON): { data, media_type, tiles?: [base64 jpeg], qr?: {seller,vat_no,timestamp,date,date_alt,total,vat} }

const VERSION = 2;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const FAST_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5"];            // القراءتان المتوازيتان (سريع)
const STRONG_MODELS = ["claude-sonnet-5-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"]; // القراءة الحاسمة عند الاختلاف
const WORKING = {}; // أول موديل نجح لكل سلسلة (للنسخة الدافئة)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

// ---------- أدوات الأرقام والتواريخ ----------
const AR_DIGITS = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9" };
function westernDigits(s) { return String(s).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || d); }
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = westernDigits(v).replace(/٫/g, ".").replace(/[٬\s]/g, "").replace(/[^\d.,\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
const r2 = (n) => Math.round(n * 100) / 100;
function riyadhToday() { return new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); }
function iso(y, mo, d) {
  if (!(y > 1900 && y < 2200) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
function normDate(v) {
  if (!v) return null;
  const s = westernDigits(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s); // يوم/شهر/سنة (العرف السعودي)
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}
function daysBetween(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 864e5); }
function digitsOnly(s) { return westernDigits(s || "").replace(/\D/g, ""); }

// ---------- التعليمات ----------
function buildPrompt(isPdf, nTiles, variant) {
  let p = `You are a meticulous chartered accountant extracting data from ONE purchase invoice or receipt (usually Saudi; Arabic and/or English). A single wrong digit causes real financial damage, so precision matters more than anything.

${isPdf ? "The invoice is the attached PDF document." : `Image 1 is the whole invoice.${nTiles ? ` Images 2-${nTiles + 1} are high-resolution zoomed crops of the SAME invoice, ordered top to bottom and overlapping — use them to read small digits exactly (do not double-count overlapping lines).` : ""}`}

RULES
1. Copy values EXACTLY as printed. Never estimate, never invent. If a field is not printed or not legible, use null.
2. Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩ / ۰-۹) to Western digits. Remove thousands separators. Decimal point is "." (convert "٫" or a decimal comma). Watch carefully for 1 vs 7, 3 vs 8, 5 vs 6, 0 vs 6 and the position of the decimal point.
3. supplier = the SELLER / issuer of the invoice (normally at the top with its VAT and CR numbers). NOT the buyer/customer.
4. supplier_vat_no = the SELLER's VAT registration number (Saudi format: 15 digits starting and ending with 3). Not the buyer's.
5. invoice_number = the invoice number (رقم الفاتورة / فاتورة رقم / Invoice No / Bill No / Receipt No). Not phone, CR, order, customer or reference numbers unless it is clearly the invoice number.
6. invoice_date = the issue date (تاريخ الفاتورة / تاريخ الإصدار / Date). Output ISO YYYY-MM-DD. Saudi documents write DD/MM/YYYY (day first). Copy the printed date text into date_text. If only a Hijri date is printed, convert it to Gregorian accurately and set date_is_hijri=true. Never use a due/delivery/expiry date. If no date is printed: null.
7. Read the TOTALS block (usually at the bottom). Do NOT compute totals yourself by adding line items — read what is printed:
   - total = final amount payable INCLUDING VAT (الإجمالي شامل الضريبة / المبلغ المستحق / الإجمالي النهائي / الصافي / Total / Grand total / Amount due).
   - subtotal = total BEFORE VAT, after discounts (الإجمالي قبل الضريبة / المبلغ الخاضع للضريبة / Taxable amount / Total excl. VAT).
   - vat_amount = VAT amount (ضريبة القيمة المضافة / الضريبة / VAT / Tax).
   - vat_rate = VAT percentage as a number (e.g. 15).
   - discount = total discount, if printed.
8. line_totals = the printed line-total amount of EVERY line item, in order (numbers only); items_count = number of line items. Set items_include_vat=true if line totals include VAT.
9. Keep notes under 15 words. No other text.
10. confidence for each key field: "high" | "medium" | "low" ("low" when blurry, cut off, handwritten, covered or ambiguous).
`;
  if (variant === "B") p += `
READING ORDER for this pass: start with the TOTALS block (read every amount digit by digit), then the invoice number and date, then the seller name and VAT number, then the line items.
`;
  p += `
Return ONLY one JSON object (no markdown, no commentary) with exactly these keys:
{"supplier":string|null,"supplier_vat_no":string|null,"invoice_number":string|null,"invoice_date":"YYYY-MM-DD"|null,"date_text":string|null,"date_is_hijri":boolean,"currency":string,"subtotal":number|null,"discount":number|null,"vat_amount":number|null,"vat_rate":number|null,"total":number|null,"line_totals":[number],"items_count":number,"items_include_vat":boolean,"confidence":{"supplier":string,"invoice_number":string,"invoice_date":string,"total":string,"vat_amount":string},"notes":string}`;
  return p;
}

// ---------- استدعاء Claude مع تبديل تلقائي للموديل ----------
async function callClaude(key, content, tier = "fast") {
  const override = (Deno.env.get("INVOICE_MODEL_OVERRIDE") || "").trim();
  const chain = tier === "strong" ? STRONG_MODELS : FAST_MODELS;
  const list = [...new Set([override, WORKING[tier], ...chain].filter(Boolean))];
  const maxTokens = tier === "strong" ? 4000 : 1500;
  let lastErr = "";
  for (const model of list) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r, out;
      try {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
        });
        out = await r.json().catch(() => ({}));
      } catch (e) {
        lastErr = "تعذّر الاتصال بمزوّد الذكاء الاصطناعي: " + ((e && e.message) || e);
        await new Promise((s) => setTimeout(s, 1200));
        continue;
      }
      if (r.ok) {
        WORKING[tier] = model;
        const text = ((out && out.content) || []).filter((c) => c && c.type === "text").map((c) => c.text).join("").trim();
        return { text, model };
      }
      const msg = (out && out.error && out.error.message) || String(r.status);
      const type = (out && out.error && out.error.type) || "";
      lastErr = `${model}: ${msg}`;
      if (r.status === 401) throw new Error("مفتاح Anthropic غير صحيح أو منتهي (401)");
      if (r.status === 404 || r.status === 403 || type === "not_found_error" || type === "permission_error" || (r.status === 400 && /model/i.test(msg))) break; // الموديل غير متاح → التالي
      if (r.status === 400 && /credit|billing|balance/i.test(msg)) throw new Error("رصيد Anthropic غير كافٍ — اشحن الرصيد");
      if (r.status === 400) throw new Error("طلب غير صالح: " + msg);
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
      break;
    }
  }
  throw new Error("خطأ من مزوّد الذكاء الاصطناعي: " + lastErr);
}

function parseJSON(text) {
  if (!text) return null;
  const t = text.replace(/```json|```/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// ---------- التطبيع والتحقق ----------
function normalize(raw) {
  let items = [];
  if (Array.isArray(raw.items)) items = raw.items.map((it) => ({
    description: (it && it.description != null ? String(it.description) : "").trim(),
    quantity: num(it && it.quantity), unit_price: num(it && it.unit_price), line_total: num(it && it.line_total),
  }));
  else if (Array.isArray(raw.line_totals)) items = raw.line_totals.map((x) => ({ description: "", quantity: null, unit_price: null, line_total: num(x) }));
  return {
    supplier: raw.supplier ? String(raw.supplier).trim() : null,
    supplier_vat_no: raw.supplier_vat_no ? digitsOnly(raw.supplier_vat_no) || null : null,
    invoice_number: raw.invoice_number != null && String(raw.invoice_number).trim() !== "" ? westernDigits(String(raw.invoice_number)).trim() : null,
    invoice_date: normDate(raw.invoice_date),
    date_text: raw.date_text || null,
    date_is_hijri: !!raw.date_is_hijri,
    currency: raw.currency || "SAR",
    subtotal: num(raw.subtotal), discount: num(raw.discount), vat_amount: num(raw.vat_amount),
    vat_rate: num(raw.vat_rate), total: num(raw.total),
    items, items_include_vat: !!raw.items_include_vat,
    confidence: raw.confidence && typeof raw.confidence === "object" ? raw.confidence : {},
    notes: raw.notes ? String(raw.notes) : "",
  };
}

// يرجّع الفحوصات + الحقول المشكوك فيها + القيم المشتقّة
function validate(f, qr) {
  const checks = [];
  const warn = new Set();
  const derived = {};
  let sub = f.subtotal, vat = f.vat_amount, tot = f.total, rate = f.vat_rate;
  const nItems = f.items.length;

  if (tot == null && sub != null && vat != null) { tot = r2(sub + vat); derived.total = true; }
  if (sub == null && tot != null && vat != null) { sub = r2(tot - vat); derived.subtotal = true; }
  if (vat == null && tot != null && sub != null) { vat = r2(tot - sub); derived.vat = true; }
  if (rate == null && sub > 0 && vat != null) { rate = Math.round((vat / sub) * 1000) / 10; derived.vat_rate = true; }

  if (sub != null && vat != null && tot != null && !derived.total && !derived.subtotal && !derived.vat) {
    const ok = Math.abs(sub + vat - tot) <= 0.06 + 0.0005 * Math.abs(tot);
    checks.push({ id: "sum", ok, msg: ok ? "الإجمالي = قبل الضريبة + الضريبة" : `الإجمالي (${tot}) ≠ قبل الضريبة (${sub}) + الضريبة (${vat})` });
    if (!ok) ["total", "subtotal", "vat"].forEach((k) => warn.add(k));
  }
  if (sub > 0 && vat != null && rate != null) {
    const exp = (sub * rate) / 100;
    const ok = Math.abs(vat - exp) <= 0.06 + Math.min(0.5, 0.006 * nItems);
    if (!derived.vat_rate) {
      checks.push({ id: "rate", ok, msg: ok ? `الضريبة ${rate}% صحيحة` : `الضريبة (${vat}) لا تساوي ${rate}% من ${sub} (= ${r2(exp)})` });
      if (!ok) warn.add("vat");
    }
    if (![15, 5, 0].includes(Math.round(rate))) {
      checks.push({ id: "rate_value", ok: false, msg: `نسبة الضريبة ${rate}% غير معتادة (المعتاد 15%)` });
      warn.add("vat");
    }
  }

  const withTotals = f.items.filter((i) => i.line_total != null);
  if (nItems && withTotals.length === nItems) {
    const s = r2(withTotals.reduce((a, i) => a + i.line_total, 0));
    const tol = 0.06 + 0.01 * nItems;
    const d = f.discount || 0;
    const targets = [sub, tot, sub != null ? sub + d : null, tot != null ? tot + d : null].filter((x) => x != null);
    const ok = targets.length ? targets.some((t) => Math.abs(s - t) <= tol) : true;
    checks.push({ id: "items", ok, msg: ok ? `مجموع البنود (${nItems} بند) مطابق للإجمالي` : `مجموع البنود (${s}) لا يطابق الإجمالي` });
    if (!ok) { warn.add("total"); warn.add("subtotal"); }
    const badLines = f.items.filter((i) => i.quantity != null && i.unit_price != null && i.line_total != null && Math.abs(i.quantity * i.unit_price - i.line_total) > 0.06 + 0.002 * Math.abs(i.line_total));
    if (badLines.length) checks.push({ id: "lines", ok: false, soft: true, msg: `${badLines.length} بند: الكمية × السعر ≠ إجمالي البند (قد يكون خصماً أو ضريبة على البند)` });
  }

  const today = riyadhToday();
  if (f.invoice_date) {
    const ahead = daysBetween(f.invoice_date, today);
    if (ahead > 1) { checks.push({ id: "date", ok: false, msg: `التاريخ ${f.invoice_date} في المستقبل` }); warn.add("date"); }
    else if (-ahead > 548) { checks.push({ id: "date", ok: false, msg: `التاريخ ${f.invoice_date} قديم جداً — تأكد منه` }); warn.add("date"); }
    else checks.push({ id: "date", ok: true, msg: "التاريخ منطقي" });
  } else { checks.push({ id: "date", ok: false, soft: true, msg: "لم يُعثر على تاريخ مطبوع" }); warn.add("date"); }

  if (f.supplier_vat_no) {
    const ok = /^3\d{13}3$/.test(f.supplier_vat_no);
    checks.push({ id: "vatno", ok, msg: ok ? "الرقم الضريبي للمورّد صالح" : `الرقم الضريبي (${f.supplier_vat_no}) ليس 15 خانة تبدأ وتنتهي بـ 3` });
    if (!ok) warn.add("vat_no");
  }

  if (qr) {
    const conflicts = [];
    if (qr.total != null && tot != null && Math.abs(qr.total - tot) > 0.05) { conflicts.push(`الإجمالي المقروء ${tot} ≠ رمز QR ${qr.total}`); warn.add("total"); }
    if (qr.vat != null && vat != null && Math.abs(qr.vat - vat) > 0.05) { conflicts.push(`الضريبة المقروءة ${vat} ≠ رمز QR ${qr.vat}`); warn.add("vat"); }
    if (qr.vat_no && f.supplier_vat_no && qr.vat_no !== f.supplier_vat_no) { conflicts.push("الرقم الضريبي يختلف عن رمز QR"); warn.add("vat_no"); }
    if (qr.date && f.invoice_date && f.invoice_date !== qr.date && f.invoice_date !== qr.date_alt) { conflicts.push(`التاريخ المقروء ${f.invoice_date} ≠ رمز QR ${qr.date_alt || qr.date}`); warn.add("date"); }
    checks.push({ id: "qr", ok: !conflicts.length, msg: conflicts.length ? conflicts.join(" · ") : "مطابق لرمز QR الضريبي" });
  }

  const c = f.confidence || {};
  const cmap = { supplier: "party", invoice_number: "number", invoice_date: "date", total: "total", vat_amount: "vat" };
  for (const k in cmap) if (String(c[k] || "").toLowerCase() === "low") warn.add(cmap[k]);
  if (!f.invoice_number) warn.add("number");
  if (!f.supplier) warn.add("party");
  if (tot == null) warn.add("total");

  const hard = checks.filter((x) => !x.ok && !x.soft).length;
  return { checks, warn, derived, values: { sub, vat, tot, rate }, hard };
}

// ---------- مقارنة القراءات المستقلة ----------
const KEYS = ["party", "vat_no", "number", "date", "subtotal", "vat", "total"];
const NAME_STOP = new Set(["شركة", "شركه", "مؤسسة", "مؤسسه", "company", "co", "co.", "est", "est.", "establishment", "ltd", "llc", "for", "trading"]);
function normName(s) {
  return String(s || "").toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[إأآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .split(/\s+/).filter((t) => t && !NAME_STOP.has(t)).join("").replace(/[^\p{L}\p{N}]/gu, "");
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function sameName(a, b) { const x = normName(a), y = normName(b); if (!x || !y) return x === y; if (x === y || x.includes(y) || y.includes(x)) return true; return 1 - lev(x, y) / Math.max(x.length, y.length) >= 0.85; }
const normNo = (s) => westernDigits(String(s || "")).toUpperCase().replace(/[^A-Z0-9]/g, "");
function getVal(r, k) {
  switch (k) {
    case "party": return r.f.supplier; case "vat_no": return r.f.supplier_vat_no; case "number": return r.f.invoice_number; case "date": return r.f.invoice_date;
    case "subtotal": return r.v.values.sub; case "vat": return r.v.values.vat; case "total": return r.v.values.tot;
  }
}
const empty = (x) => x === null || x === undefined || x === "";
function same(k, a, b) {
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (k === "party") return sameName(a, b);
  if (k === "number") return normNo(a) === normNo(b);
  if (k === "vat_no" || k === "date") return String(a) === String(b);
  return Math.abs(Number(a) - Number(b)) <= 0.011;
}
// تصويت الأغلبية لكل حقل بين القراءات
function vote(reads) {
  const out = {};
  for (const k of KEYS) {
    const vals = reads.map((r) => getVal(r, k));
    let best = null, bestCount = 0;
    vals.forEach((x, i) => { const c = vals.filter((y) => same(k, x, y)).length; if (c > bestCount || (c === bestCount && i === vals.length - 1 && c > 1)) { best = x; bestCount = c; } });
    const agreed = reads.length >= 2 && bestCount >= 2;
    if (!agreed) best = vals[vals.length - 1]; // لا أغلبية: آخر قراءة (القراءة الحاسمة)
    out[k] = { val: best, count: bestCount, agreed, all: vals };
  }
  return out;
}
const fmtV = (k, x) => (empty(x) ? "—" : ["subtotal", "vat", "total"].includes(k) ? Number(x).toFixed(2) : String(x));
const KEY_AR = { party: "المورّد", vat_no: "الرقم الضريبي", number: "رقم الفاتورة", date: "التاريخ", subtotal: "قبل الضريبة", vat: "الضريبة", total: "الإجمالي" };

function merge(reads, qr) {
  const votes = vote(reads);
  const base = reads.slice().sort((a, b) => a.v.hard - b.v.hard)[0];
  const f = JSON.parse(JSON.stringify(base.f));
  f.supplier = votes.party.val || null; f.supplier_vat_no = votes.vat_no.val || null; f.invoice_number = votes.number.val || null; f.invoice_date = votes.date.val || null;
  f.subtotal = votes.subtotal.val; f.vat_amount = votes.vat.val; f.total = votes.total.val;
  const conf = Object.assign({}, f.confidence || {});
  const cmap = { party: "supplier", number: "invoice_number", date: "invoice_date", total: "total", vat: "vat_amount" };
  for (const k in cmap) if (votes[k].agreed) conf[cmap[k]] = "high";
  f.confidence = conf;
  const itemsRead = reads.find((r) => r.v.checks.some((c) => c.id === "items" && c.ok)) || base;
  f.items = itemsRead.f.items; f.items_include_vat = itemsRead.f.items_include_vat;
  let v = validate(f, qr);
  let disputed = new Set(reads.length >= 2 ? KEYS.filter((k) => !votes[k].agreed) : []);
  // إذا الأغلبية فشلت حسابياً وفيه قراءة سليمة حسابياً بالكامل → نعتمدها ونعلّم الحقول المختلفة للمراجعة
  if (v.hard > 0) {
    const clean = reads.filter((r) => r.v.hard === 0).pop();
    if (clean) {
      const f2 = JSON.parse(JSON.stringify(clean.f)); const v2 = validate(f2, qr);
      if (v2.hard < v.hard) { KEYS.forEach((k) => { if (!same(k, getVal(clean, k), votes[k].val)) disputed.add(k); }); return { f: f2, v: v2, votes, disputed }; }
    }
  }
  return { f, v, votes, disputed };
}

// ---------- الدمج النهائي مع رمز QR وحالة كل حقل ----------
function finalize(f, v, qr, votes, disputed, nReads) {
  const src = {};
  let { sub, vat, tot, rate } = v.values;
  let party = f.supplier, vatNo = f.supplier_vat_no, date = f.invoice_date;
  const printed = { party, vat_no: vatNo, date, subtotal: sub, vat, total: tot };
  if (qr) {
    const pick = (k, qv) => { src[k] = !empty(printed[k]) && same(k, printed[k], qv) ? "qr+print" : "qr"; return qv; };
    if (qr.total != null) tot = pick("total", qr.total);
    if (qr.vat != null) vat = pick("vat", qr.vat);
    if (qr.total != null && qr.vat != null) { sub = pick("subtotal", r2(qr.total - qr.vat)); if (sub > 0) rate = Math.round((qr.vat / sub) * 1000) / 10; }
    if (qr.vat_no) vatNo = pick("vat_no", qr.vat_no);
    if (qr.seller) party = pick("party", qr.seller);
    const qd = qr.date_alt || qr.date;
    if (qd) { if (date && (date === qr.date || date === qr.date_alt)) src.date = "qr+print"; else { date = qd; src.date = "qr"; } }
  }
  for (const k of KEYS) if (!src[k]) src[k] = votes && votes[k] && votes[k].agreed ? "print2" : "print";
  for (const k of ["total", "subtotal", "vat"]) if (v.derived[k] && src[k] === "print") src[k] = "derived";

  const status = {};
  for (const k of KEYS) {
    const qrSettled = src[k] === "qr+print"; // المطبوع والرمز متطابقان = أعلى ثقة
    if (v.warn.has(k) && !qrSettled) status[k] = "warn";
    else if (disputed && disputed.has(k) && !qrSettled) status[k] = "warn";
    else status[k] = "ok";
  }
  if (!vatNo) status.vat_no = "na";
  const fields = {
    party: party || "", vat_no: vatNo || "", number: f.invoice_number || "", date: date || "",
    subtotal: sub, vat, vat_rate: rate, total: tot, amount: tot, discount: f.discount, currency: f.currency,
    date_text: f.date_text, date_is_hijri: f.date_is_hijri,
  };
  return { fields, status, sources: src };
}

// ---------- المعالج ----------
async function extract(key, files, prompt, tier = "fast") {
  let { text, model } = await callClaude(key, [...files, { type: "text", text: prompt }], tier);
  let raw = parseJSON(text);
  if (!raw) { ({ text, model } = await callClaude(key, [...files, { type: "text", text: prompt + "\n\nIMPORTANT: respond with the JSON object only." }], tier)); raw = parseJSON(text); }
  if (!raw) throw new Error("تعذّر تفسير رد الذكاء الاصطناعي");
  return { raw, f: normalize(raw), model };
}

async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const key = (Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
    if (!key) return json({ error: "ANTHROPIC_API_KEY غير مضبوط في أسرار Supabase" }, 500);

    let body;
    try { body = await req.json(); } catch { return json({ error: "بيانات الطلب ليست JSON صالحاً" }, 400); }
    const { data, media_type } = body || {};
    if (!data || typeof data !== "string") return json({ error: "لا توجد بيانات صورة/ملف" }, 400);
    const tiles = Array.isArray(body.tiles) ? body.tiles.filter((t) => typeof t === "string" && t.length > 100).slice(0, 6) : [];
    const qr = body.qr && typeof body.qr === "object" && (body.qr.total != null || body.qr.vat_no) ? {
      seller: body.qr.seller ? String(body.qr.seller).trim() : null,
      vat_no: body.qr.vat_no ? digitsOnly(body.qr.vat_no) : null,
      timestamp: body.qr.timestamp ? String(body.qr.timestamp) : null,
      date: normDate(body.qr.date), date_alt: normDate(body.qr.date_alt),
      total: num(body.qr.total), vat: num(body.qr.vat),
    } : null;

    const mt = media_type || "image/jpeg";
    const isPdf = /pdf/i.test(mt);
    const files = isPdf
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }]
      : [{ type: "image", source: { type: "base64", media_type: mt, data } },
         ...tiles.map((t) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: t } }))];
    const nT = isPdf ? 0 : tiles.length;
    const promptA = buildPrompt(isPdf, nT, "A");

    // قراءتان مستقلتان للمكتوب بالتوازي (بدون إعطائهما رمز QR حتى تبقى المقارنة نزيهة)
    const settled = await Promise.allSettled([extract(key, files, promptA), extract(key, files, buildPrompt(isPdf, nT, "B"))]);
    const reads = settled.filter((x) => x.status === "fulfilled").map((x) => x.value);
    if (!reads.length) throw settled[0].reason;
    reads.forEach((r) => { r.v = validate(r.f, qr); });

    let m = merge(reads, qr);
    // قراءة ثالثة حاسمة عند أي اختلاف أو فحص فاشل
    if (m.disputed.size || m.v.hard > 0 || reads.length === 1) {
      {
        const lines = [];
        if (reads.length >= 2) for (const k of KEYS) if (!m.votes[k].agreed) lines.push(`- ${k}: ${m.votes[k].all.map((x) => fmtV(k, x)).join("  vs  ")}`);
        for (const c of m.v.checks) if (!c.ok && !c.soft) lines.push("- check failed: " + c.msg);
        const fixPrompt = promptA + `

VERIFICATION PASS. ${reads.length >= 2 ? "Independent readings of this same invoice produced different values" : "A previous reading produced values"} — problems found:
${lines.join("\n") || "- (confirm every value)"}
Look again very carefully at exactly these printed values (digit by digit, check decimal points, seller vs buyer, issue date vs other dates) and return the complete JSON with the values as truly PRINTED. Do not average or guess.`;
        try { const c = await extract(key, files, fixPrompt, "strong"); c.v = validate(c.f, qr); reads.push(c); m = merge(reads, qr); } catch (_) { /* نكمل بما لدينا */ }
      }
    }

    const out = finalize(m.f, m.v, qr, m.votes, m.disputed, reads.length);
    const checks = m.v.checks.slice();
    if (reads.length >= 2) {
      const dk = KEYS.filter((k) => m.disputed.has(k) && out.status[k] === "warn");
      checks.unshift(dk.length
        ? { id: "double", ok: false, msg: "القراءات المستقلة اختلفت في: " + dk.map((k) => `${KEY_AR[k]} (${[...new Set(m.votes[k].all.map((x) => fmtV(k, x)))].join(" / ")})`).join("، ") }
        : { id: "double", ok: true, msg: `${reads.length} قراءات مستقلة للمكتوب متطابقة` });
    }
    return json({ v: VERSION, ...out, checks, items: m.f.items, items_include_vat: m.f.items_include_vat, notes: m.f.notes, model: reads.map((r) => r.model).filter((x, i, a) => a.indexOf(x) === i).join(" + "), passes: reads.length, qr_used: !!qr });
  } catch (e) {
    return json({ error: (e && e.message) || String(e) }, 502);
  }
}

if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(handle);
export { handle, num, normDate, normalize, validate, finalize, parseJSON, sameName, vote, merge };
