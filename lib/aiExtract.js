const { fetch } = require("undici");

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function extractInvoiceWithLLM(transcribedText) {
  const model = process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile";

  const system = [
    "Ты — парсер накладных.",
    "Верни ТОЛЬКО валидный JSON без комментариев и без markdown.",
    "Схема JSON:",
    "{ supplier: string, date: string|null, etaText: string|null, items: [{name:string, qty:number, unit_price:number}], note?:string }",
    "Правила:",
    "- Если дата не указана, date=null (потом бот сам поставит сегодняшнюю).",
    "- 'Доставка 5000' = отдельная позиция name='Доставка', qty=1, unit_price=5000.",
    "- Если не уверен в цене/кол-ве — ставь 0, но имя заполняй.",
    "- Не придумывай товары."
  ].join("\n");

  const user = `Текст:\n${transcribedText}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content?.trim() || "";
  const parsed = safeJsonParse(content);
  if (!parsed || !parsed.items) return null;

  // нормализация
  parsed.supplier = (parsed.supplier || "").trim();
  parsed.etaText = parsed.etaText ? String(parsed.etaText).trim() : null;
  parsed.date = parsed.date ? String(parsed.date).trim() : null;

  parsed.items = (parsed.items || []).map((x) => ({
    name: String(x?.name || "").trim() || "—",
    qty: Number(x?.qty) || 0,
    unit_price: Number(x?.unit_price) || 0
  }));

  return parsed;
}

module.exports = { extractInvoiceWithLLM };
