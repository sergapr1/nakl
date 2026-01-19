function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

function calc(inv) {
  inv.items.forEach(it => {
    it.qty = Number(it.qty) || 0;
    it.unit_price = Number(it.unit_price) || 0;
    it.sum = it.qty * it.unit_price;
  });
  inv.total = inv.items.reduce((a, it) => a + (Number(it.sum) || 0), 0);
  return inv;
}

// Очень простой MVP-парсер под “Антигель маннол 1л 50 штук по 2600 тг, доставка 5000”
function extractInvoiceFromText(text) {
  const parts = text
    .replace(/[;,]/g, "\n")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const items = [];
  for (const p of parts) {
    const ship = p.match(/доставк\w*\s+(\d+)/i);
    if (ship) {
      items.push({ name: "Доставка", qty: 1, unit_price: Number(ship[1]) });
      continue;
    }

    const m = p.match(/(.+?)\s+(\d+)\s*(штук|шт)?\s*(по)?\s*(\d+)\s*(тг|тенге)?/i);
    if (m) {
      items.push({ name: m[1].trim(), qty: Number(m[2]), unit_price: Number(m[5]) });
      continue;
    }

    // если не распарсилось — сохраняем как “непонятная позиция”
    items.push({ name: p, qty: 1, unit_price: 0 });
  }

  return calc({
    invoiceId: newId(),
    date: todayISO(),
    supplier: "",
    etaText: null, // дата доставки (строкой)
    items,
    total: 0
  });
}

function formatInvoice(inv) {
  const lines = inv.items.map((it, i) =>
    `${i + 1}) ${it.name} — ${it.qty} × ${it.unit_price} = ${it.sum}`
  ).join("\n");

  return [
    `Накладная: ${inv.invoiceId}`,
    `Дата: ${inv.date}`,
    `Поставщик: ${inv.supplier || "—"}`,
    inv.etaText ? `Доставка (ETA): ${inv.etaText}` : `Доставка (ETA): —`,
    "",
    lines,
    "",
    `Итого: ${inv.total} тг`
  ].join("\n");
}

// Парсит: "2026-01-20 15:30" или "20.01.2026 15:30" или "20.01 15:30"
function parseEta(text) {
  const t = text.trim();

  let y, mo, d, hh, mm;

  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3]; hh = +m[4]; mm = +m[5];
    return { y, mo, d, hh, mm };
  }

  m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (m) {
    d = +m[1]; mo = +m[2]; y = +m[3]; hh = +m[4]; mm = +m[5];
    return { y, mo, d, hh, mm };
  }

  m = t.match(/^(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/);
  if (m) {
    const now = new Date();
    d = +m[1]; mo = +m[2]; y = now.getFullYear(); hh = +m[3]; mm = +m[4];
    return { y, mo, d, hh, mm };
  }

  return null;
}

function applyDeliveryCommand(inv, text) {
  const t = text.trim();

  const m = t.match(/добавь\s+доставк\w*\s+(\d+)/i) || t.match(/доставк\w*\s+(\d+)/i);
  if (!m) return { changed: false, inv };

  const val = Number(m[1]);
  const idx = inv.items.findIndex(x => (x.name || "").toLowerCase().includes("достав"));
  if (idx >= 0) inv.items[idx] = { name: "Доставка", qty: 1, unit_price: val };
  else inv.items.push({ name: "Доставка", qty: 1, unit_price: val });

  return { changed: true, inv: calc(inv) };
}

module.exports = {
  extractInvoiceFromText,
  formatInvoice,
  parseEta,
  applyDeliveryCommand,
  calc
};
