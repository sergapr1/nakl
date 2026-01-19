// api/webhook.js (CommonJS)
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const { fetch } = require("undici");

const { getJSON, setJSON, saveInvoice, listInvoices } = require("../lib/redis");
const { transcribeOggWithGroq } = require("../lib/transcribe");
const {
  extractInvoiceFromText,
  formatInvoice,
  parseEta,
  applyDeliveryCommand,
  calc
} = require("../lib/invoice");
const { buildPdf } = require("../lib/pdf");
const { makeGCalLink } = require("../lib/gcal");

const TG_TOKEN = process.env.TG_TOKEN;
const bot = new Bot(TG_TOKEN);

function invKey(chatId, invoiceId) {
  return `inv:${chatId}:${invoiceId}`;
}
function activeKey(chatId) {
  return `active:${chatId}`;
}
function awaitKey(chatId) {
  return `await:${chatId}`;
}

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

// ---- Commands
bot.command("start", (ctx) => {
  return ctx.reply(
    "Кидай голосовое с позициями.\nКоманды:\n/history\n/search <текст>\n/open <id>"
  );
});

bot.command("history", async (ctx) => {
  const list = await listInvoices(ctx.chat.id, 20);
  if (!list.length) return ctx.reply("История пустая.");
  const txt = list
    .map((x) => `${x.invoiceId} | ${x.date} | ${x.total} тг | ${x.supplier || "—"}`)
    .join("\n");
  return ctx.reply(txt);
});

bot.command("search", async (ctx) => {
  const q = (ctx.match || "").trim().toLowerCase();
  if (!q) return ctx.reply("Пример: /search антигель");
  const list = await listInvoices(ctx.chat.id, 200);
  const hit = list.filter((inv) =>
    inv.items.some((it) => (it.name || "").toLowerCase().includes(q))
  );
  if (!hit.length) return ctx.reply("Ничего не найдено.");
  return ctx.reply(
    hit.slice(0, 30).map((x) => `${x.invoiceId} | ${x.date} | ${x.total} тг`).join("\n")
  );
});

bot.command("open", async (ctx) => {
  const id = (ctx.match || "").trim();
  if (!id) return ctx.reply("Пример: /open ABC123");
  const inv = await getJSON(invKey(ctx.chat.id, id));
  if (!inv) return ctx.reply("Не нашёл такую накладную.");
  await setJSON(activeKey(ctx.chat.id), id);
  return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
});

// ---- Voice -> invoice
bot.on("message:voice", async (ctx) => {
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`;
  const audioBuf = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());

  const text = await transcribeOggWithGroq(audioBuf);
  const inv = extractInvoiceFromText(text);

  await saveInvoice(ctx.chat.id, inv);
  await setJSON(activeKey(ctx.chat.id), inv.invoiceId);

  return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
});

// ---- Inline actions
bot.callbackQuery("pdf", async (ctx) => {
  const active = await getJSON(activeKey(ctx.chat.id));
  if (!active) return ctx.answerCallbackQuery({ text: "Нет активной накладной" });

  const inv = await getJSON(invKey(ctx.chat.id, active));
  if (!inv) return ctx.answerCallbackQuery({ text: "Накладная не найдена" });

  const pdfBytes = await buildPdf(inv);
  const filename = `nakladnaya_${inv.invoiceId}.pdf`;

  await ctx.replyWithDocument(new InputFile(Buffer.from(pdfBytes), filename));
  return ctx.answerCallbackQuery();
});

bot.callbackQuery("add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "add_value" });
  return ctx.reply(
    "Введи новую позицию в формате:\nНазвание, кол-во, цена\nПример: Антигель Mannol 1л, 50, 2600"
  );
});

bot.callbackQuery("rename", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "rename_choose" });
  return ctx.reply("Номер позиции для переименования? (например: 1)");
});
bot.callbackQuery("qty", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "qty_choose" });
  return ctx.reply("Номер позиции для изменения кол-ва? (например: 1)");
});
bot.callbackQuery("price", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "price_choose" });
  return ctx.reply("Номер позиции для изменения цены? (например: 1)");
});
bot.callbackQuery("del", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "del_choose" });
  return ctx.reply("Номер позиции для удаления? (например: 1)");
});
bot.callbackQuery("eta", async (ctx) => {
  await ctx.answerCallbackQuery();
  await setJSON(awaitKey(ctx.chat.id), { type: "eta" });
  return ctx.reply(
    "Когда ожидается доставка?\nФормат: 2026-01-20 15:30 или 20.01 15:30 (Алматы)."
  );
});

// ---- Text handler
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
      const parts = t.split(",").map((x) => x.trim());
      if (parts.length < 3) return ctx.reply("Формат: Название, кол-во, цена");
      const name = parts[0];
      const qty = Number(parts[1].replace(/[^\d]/g, "")) || 0;
      const price = Number(parts[2].replace(/[^\d]/g, "")) || 0;
      inv.items.push({ name, qty, unit_price: price, sum: 0 });
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "rename_choose") {
      const idx = chooseIndex(t);
      if (idx === null) return ctx.reply("Неверный номер позиции.");
      await setJSON(awaitKey(chatId), { type: "rename_value", idx });
      return ctx.reply("Введи новое название:");
    }

    if (awaiting.type === "qty_choose") {
      const idx = chooseIndex(t);
      if (idx === null) return ctx.reply("Неверный номер позиции.");
      await setJSON(awaitKey(chatId), { type: "qty_value", idx });
      return ctx.reply("Введи новое кол-во (число):");
    }

    if (awaiting.type === "price_choose") {
      const idx = chooseIndex(t);
      if (idx === null) return ctx.reply("Неверный номер позиции.");
      await setJSON(awaitKey(chatId), { type: "price_value", idx });
      return ctx.reply("Введи новую цену (число):");
    }

    if (awaiting.type === "del_choose") {
      const idx = chooseIndex(t);
      if (idx === null) return ctx.reply("Неверный номер позиции.");
      inv.items.splice(idx, 1);
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "rename_value") {
      inv.items[awaiting.idx].name = t;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "qty_value") {
      const val = Number(t.replace(/[^\d]/g, ""));
      if (!Number.isFinite(val)) return ctx.reply("Не понял число.");
      inv.items[awaiting.idx].qty = val;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "price_value") {
      const val = Number(t.replace(/[^\d]/g, ""));
      if (!Number.isFinite(val)) return ctx.reply("Не понял число.");
      inv.items[awaiting.idx].unit_price = val;
      calc(inv);
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);
      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    if (awaiting.type === "eta") {
      const dt = parseEta(t);
      if (!dt) {
        return ctx.reply("Не понял формат. Пример: 2026-01-20 15:30 или 20.01 15:30");
      }

      inv.etaText = t;
      await setJSON(invKey(chatId, inv.invoiceId), inv);
      await setJSON(awaitKey(chatId), null);

      const details = inv.items
        .map((x, i) => `${i + 1}) ${x.name} — ${x.qty}×${x.unit_price}=${x.sum}`)
        .join("\n");

      const link = makeGCalLink({
        title: `Доставка накладной ${inv.invoiceId}`,
        details,
        startLocal: dt
      });

      const kb = new InlineKeyboard().url("📅 Добавить в Google Calendar", link);
      await ctx.reply("Готово. Нажми кнопку — откроется Google Calendar с заполненным событием.", {
        reply_markup: kb
      });

      return ctx.reply(formatInvoice(inv), { reply_markup: mainKb() });
    }

    return;
  }

  // Произвольная команда (MVP): доставка
  const { changed, inv: inv2 } = applyDeliveryCommand(inv, t);
  if (changed) {
    await setJSON(invKey(chatId, inv2.invoiceId), inv2);
    return ctx.reply("Ок, обновил доставку.\n\n" + formatInvoice(inv2), {
      reply_markup: mainKb()
    });
  }
});

// ---- Vercel handler (init + надёжный body)
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
