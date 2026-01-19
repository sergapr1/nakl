const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { fetch } = require("undici");

const { redis, getJSON, setJSON, saveInvoice, listInvoices } = require("../lib/redis");
const { transcribeOggWithGroq } = require("../lib/transcribe");
const { extractInvoiceWithLLM } = require("../lib/aiExtract");
const { todayISO, extractInvoiceFromText, formatInvoice, parseEta, applyDeliveryCommand, calc } = require("../lib/invoice");
const { buildPdf } = require("../lib/pdf");
const { makeGCalLink } = require("../lib/gcal");

const TG_TOKEN = process.env.TG_TOKEN;
const bot = new Bot(TG_TOKEN);

function invKey(chatId, invoiceId) { return `inv:${chatId}:${invoiceId}`; }
function activeKey(chatId) { return `active:${chatId}`; }
function awaitKey(chatId) { return `await:${chatId}`; }

function mainKb() {
  return new InlineKeyboard()
    .text("✅ PDF", "pdf")
    .row()
    .text("➕ Позиция", "add")
    .row()
    .text("✏️ Имя", "rename")
    .text("🔢 Кол-во", "qty")
    .text("💵 Цена", "price")
    .row()
    .text("🗑 Удалить", "del")
    .row()
    .text("📅 Доставка в Calendar", "eta");
}

function etaKb() {
  return new InlineKeyboard()
    .text("Сегодня 18:00", "eta_today_18")
    .row()
    .text("Завтра 09:00", "eta_tomorrow_09")
    .row()
    .text("Ввести вручную", "eta_manual");
}

// YYYY,MM,DD в Asia/Almaty
function getAlmatyYMD(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return { y: +get("year"), mo: +get("month"), d: +get("day") };
}

function makeCalendarLinkFromInv(inv, dt) {
  const details = inv.items
    .map((x, i) => `${i + 1}) ${x.name} — ${x.qty}×${x.unit_price}=${x.sum}`)
    .join("\n");

  return makeGCalLink({
    title: `Доставка накладной №${inv.invoiceId}`,
    details,
    startLocal: dt
  });
}

// ---- Commands
bot.command("start", (ctx) => ctx.reply("Кидай голосовое с позициями.\nКоманды:\n/history\n/search <текст>\n/open <id>"));

bot.command("history", async (ctx) => {
  const list = await listInvoices(ctx.chat.id, 20);
  if (!list.length) return ctx.reply("История пустая.");
  return ctx.reply(list.map(x => `${x.invoiceId} | ${x.date} | ${x.total} тг`).join("\n"));
});

bot.command("search", async (ctx) => {
  const q = (ctx.match || "").trim().toLowerCase();
  if (!q) return ctx.reply("Пример: /search антигель");
  const list = await listInvoices(ctx.chat.id, 200);
  const hit = list.filter(inv => inv.items.some(it => (it.name || "").toLowerCase().includes(q)));
  if (!hit.length) return ctx.reply("Ничего не найдено.");
  return ctx.reply(hit.slice(0, 30).map(x => `${x.invoiceId} | ${x.date} | ${x.total} тг`).join("\n"));
});

bot.command("open", async (ctx) => {
  const id = (ctx.match || "").trim();
  if (!id) return ctx.reply("Пример: /open 12");
  const inv = await getJSON(invKey(ctx.chat.id, id));
  if (!inv) return ctx.reply("Не нашёл такую накладную.");
  await setJSON(activeKey(ctx.chat.id), id);
  return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
});

// ---- Voice -> invoice (ASR -> LLM JSON -> invoice)
bot.on("message:voice", async (ctx) => {
  const chatId = ctx.chat.id;

  // numeric invoiceId
  const invoiceId = String(await redis.incr(`seq:${chatId}`));

  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;
  const audioBuf = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());

  // 1) Распознаём
  const text = await transcribeOggWithGroq(audioBuf);

  // 2) Пытаемся “понять” через LLM (если вернёт null — откатимся на regex)
  const llm = await extractInvoiceWithLLM(text);

  let inv;
  if (llm) {
    inv = {
      invoiceId,
      date: llm.date || todayISO(),
      supplier: llm.supplier || "",
      etaText: llm.etaText || null,
      items: llm.items,
      total: 0
    };
    calc(inv);
  } else {
    inv = extractInvoiceFromText(text, invoiceId);
  }

  await saveInvoice(chatId, inv);
  await setJSON(activeKey(chatId), inv.invoiceId);

  return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
});

// ---- PDF
bot.callbackQuery("pdf", async (ctx) => {
  const active = await getJSON(activeKey(ctx.chat.id));
  if (!active) return ctx.answerCallbackQuery({ text: "Нет активной накладной" });
  const inv = await getJSON(invKey(ctx.chat.id, active));
  if (!inv) return ctx.answerCallbackQuery({ text: "Накладная не найдена" });

  const pdfBytes = await buildPdf(inv);
  await ctx.replyWithDocument(new InputFile(Buffer.from(pdfBytes), `nakladnaya_${inv.invoiceId}.pdf`));
  return ctx.answerCallbackQuery();
});

// ---- ETA menu
bot.callbackQuery("eta", async (ctx) => {
  await ctx.answerCallbackQuery();
  return ctx.reply("Когда ожидается доставка?", { reply_markup: etaKb() });
});

bot.callbackQuery("eta_today_18", async (ctx) => {
  await ctx.answerCallbackQuery();
  const active = await getJSON(activeKey(ctx.chat.id));
  const inv = await getJSON(invKey(ctx.chat.id, active));
  const ymd = getAlmatyYMD(new Date());
  const dt = { ...ymd, hh: 18, mm: 0 };
  const link = makeCalendarLinkFromInv(inv, dt);
  const kb = new InlineKeyboard().url("📅 Добавить в Google Calendar", link);
  return ctx.reply("Готово:", { reply_markup: kb });
});

bot.callbackQuery("eta_tomorrow_09", async (ctx) => {
  await ctx.answerCallbackQuery();
  const active = await getJSON(activeKey(ctx.chat.id));
  const inv = await getJSON(invKey(ctx.chat.id, active));
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const ymd = getAlmatyYMD(tomorrow);
  const dt = { ...ymd, hh: 9, mm: 0 };
  const link = makeCalendarLinkFromInv(inv, dt);
  const kb = new InlineKeyboard().url("📅 Добавить в Google Calendar", link);
  return ctx.reply("Готово:", { reply_markup: kb });
});

bot.callbackQuery("eta_manual", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "eta" });
  return ctx.reply("Введи дату/время: 2026-01-20 15:30 или 20.01 15:30 (Алматы).");
});

// ---- Edit buttons (add/rename/qty/price/del) — оставь как у тебя сейчас, или если хочешь, пришлю “полный” файл целиком.
bot.callbackQuery("add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "add_value" });
  return ctx.reply("Введи: Название, кол-во, цена\nПример: Антигель Mannol 1л, 50, 2600");
});

bot.callbackQuery("rename", async (ctx) => { await ctx.answerCallbackQuery(); await setJSON(awaitKey(ctx.chat.id), { type: "rename_choose" }); return ctx.reply("Номер позиции?"); });
bot.callbackQuery("qty", async (ctx) => { await ctx.answerCallbackQuery(); await setJSON(awaitKey(ctx.chat.id), { type: "qty_choose" }); return ctx.reply("Номер позиции?"); });
bot.callbackQuery("price", async (ctx) => { await ctx.answerCallbackQuery(); await setJSON(awaitKey(ctx.chat.id), { type: "price_choose" }); return ctx.reply("Номер позиции?"); });
bot.callbackQuery("del", async (ctx) => { await ctx.answerCallbackQuery(); await setJSON(awaitKey(ctx.chat.id), { type: "del_choose" }); return ctx.reply("Номер позиции?"); });

bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const active = await getJSON(activeKey(chatId));
  if (!active) return;

  const inv = await getJSON(invKey(chatId, active));
  if (!inv) return;

  const awaiting = await getJSON(awaitKey(chatId));
  const t = ctx.message.text.trim();

  const chooseIndex = (s) => {
    const n = Number(s.trim()) - 1;
    if (Number.isNaN(n) || n < 0 || n >= inv.items.length) return null;
    return n;
  };

  if (awaiting) {
    if (awaiting.type === "add_value") {
      const parts = t.split(",").map(x => x.trim());
      if (parts.length < 3) return ctx.reply("Формат: Название, кол-во, цена");
      inv.items.push({
        name: parts[0],
        qty: Number(parts[1].replace(/[^\d]/g, "")) || 0,
        unit_price: Number(parts[2].replace(/[^\d]/g, "")) || 0,
        sum: 0
      });
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "rename_choose") {
      const idx = chooseIndex(t); if (idx === null) return ctx.reply("Неверный номер.");
      await setJSON(awaitKey(chatId), { type: "rename_value", idx });
      return ctx.reply("Новое имя:");
    }
    if (awaiting.type === "rename_value") {
      inv.items[awaiting.idx].name = t;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "qty_choose") {
      const idx = chooseIndex(t); if (idx === null) return ctx.reply("Неверный номер.");
      await setJSON(awaitKey(chatId), { type: "qty_value", idx });
      return ctx.reply("Новое кол-во (число):");
    }
    if (awaiting.type === "qty_value") {
      inv.items[awaiting.idx].qty = Number(t.replace(/[^\d]/g, "")) || 0;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "price_choose") {
      const idx = chooseIndex(t); if (idx === null) return ctx.reply("Неверный номер.");
      await setJSON(awaitKey(chatId), { type: "price_value", idx });
      return ctx.reply("Новая цена (число):");
    }
    if (awaiting.type === "price_value") {
      inv.items[awaiting.idx].unit_price = Number(t.replace(/[^\d]/g, "")) || 0;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "del_choose") {
      const idx = chooseIndex(t); if (idx === null) return ctx.reply("Неверный номер.");
      inv.items.splice(idx, 1);
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "eta") {
      const dt = parseEta(t);
      if (!dt) return ctx.reply("Не понял формат. Пример: 2026-01-20 15:30 или 20.01 15:30");
      inv.etaText = t;
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);

      const link = makeCalendarLinkFromInv(inv, dt);
      const kb = new InlineKeyboard().url("📅 Добавить в Google Calendar", link);
      return ctx.reply("Готово:", { reply_markup: kb });
    }

    return;
  }

  const { changed, inv: inv2 } = applyDeliveryCommand(inv, t);
  if (changed) {
    await setJSON(invKey(chatId, inv2.invoiceId), inv2);
    return ctx.reply("Ок, обновил доставку.\n\n" + formatInvoice(inv2), { reply_markup: mainKb() });
  }
});

// ---- Vercel handler
module.exports = async (req, res) => {
  try {
    const update = await readTelegramUpdate(req);
    if (!bot.isInited()) await bot.init();
    await bot.handleUpdate(update);
    return res.status(200).send("ok");
  } catch (e) {
    console.error("WEBHOOK_ERROR:", e);
    return res.status(200).send("ok");
  }
};

async function readTelegramUpdate(req) {
  if (req.body) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
