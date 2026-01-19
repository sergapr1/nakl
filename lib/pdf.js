const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("fs");

async function buildPdf(inv) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Берём кириллический TTF из npm пакета
  const fontPath = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
  const fontBytes = fs.readFileSync(fontPath);
  const font = await pdfDoc.embedFont(fontBytes);

  const page = pdfDoc.addPage([595, 842]); // A4
  let y = 800;

  const draw = (t, size = 12) => {
    page.drawText(String(t), { x: 50, y, size, font });
    y -= size + 6;
  };

  draw("НАКЛАДНАЯ", 18);
  draw(`ID: ${inv.invoiceId}`);
  draw(`Дата: ${inv.date}`);
  draw(`Поставщик: ${inv.supplier || "________________"}`);
  draw(`Доставка (ETA): ${inv.etaText || "—"}`);
  y -= 8;

  draw("№  Наименование                         Кол-во   Цена     Сумма", 10);
  y -= 4;

  inv.items.forEach((it, i) => {
    const name = (it.name || "").slice(0, 32);
    draw(`${i + 1}) ${name} | ${it.qty} | ${it.unit_price} | ${it.sum}`, 10);
  });

  y -= 8;
  draw(`ИТОГО: ${inv.total} тг`, 14);

  return await pdfDoc.save();
}

module.exports = { buildPdf };
