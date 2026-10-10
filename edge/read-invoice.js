// Supabase Edge Function logic: read-invoice
// يقرأ صورة/ملف فاتورة ويرجّع: المبلغ الإجمالي، الضريبة، المورّد، رقم الفاتورة، التاريخ
// المفتاح يُضبط كسرّ (Secret) باسم ANTHROPIC_API_KEY. اسم الموديل عبر سرّ INVOICE_MODEL (اختياري).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = Deno.env.get("INVOICE_MODEL") || "claude-haiku-4-5";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) {
      return json({ error: "ANTHROPIC_API_KEY غير مضبوط في أسرار Supabase" }, 500);
    }

    const { data, media_type } = await req.json();
    if (!data) return json({ error: "لا توجد بيانات صورة" }, 400);

    const mt = media_type || "image/jpeg";
    const isPdf = /pdf/i.test(mt);

    const fileBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: mt, data } };

    const prompt =
      "هذه فاتورة (شراء/مصروف). استخرج الحقول التالية وأعِدها بصيغة JSON فقط بدون أي كلام آخر:\n" +
      "{\"amount\": الإجمالي النهائي شامل الضريبة كرقم, \"vat\": قيمة ضريبة القيمة المضافة كرقم, " +
      "\"party\": اسم المورّد/البائع كنص, \"number\": رقم الفاتورة كنص, \"date\": تاريخ الفاتورة بصيغة YYYY-MM-DD}\n" +
      "قواعد: الأرقام بدون فواصل أو عملة. لو حقل غير موجود اجعله \"\" (أو 0 للأرقام). " +
      "amount = المبلغ الإجمالي المدفوع (شامل الضريبة). أعد JSON صالح فقط.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: "user", content: [fileBlock, { type: "text", text: prompt }] }],
      }),
    });

    const out = await r.json();
    if (!r.ok) {
      return json({ error: "خطأ من مزوّد الذكاء الاصطناعي: " + ((out && out.error && out.error.message) || r.status) }, 502);
    }

    const text = ((out && out.content) || []).map((c) => (c && c.text) || "").join("").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "تعذّر تفسير رد الذكاء الاصطناعي", raw: text }, 502);

    const f = JSON.parse(m[0]);
    const numOrNull = (v) => {
      const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
      return isFinite(n) ? n : null;
    };

    const fields = {
      amount: numOrNull(f.amount),
      vat: numOrNull(f.vat),
      party: (f.party == null ? "" : f.party).toString().trim(),
      number: (f.number == null ? "" : f.number).toString().trim(),
      date: (f.date == null ? "" : f.date).toString().trim(),
    };

    return json({ fields });
  } catch (e) {
    return json({ error: "خطأ: " + ((e && e.message) || String(e)) }, 500);
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
