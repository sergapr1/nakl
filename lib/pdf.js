const { PDFDocument, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("fs");

async function buildPdf(inv) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const regularPath = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
  const boldPath = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");
  const fontRegular = await pdfDoc.embedFont(fs.readFileSync(regularPath));
  const fontBold = await pdfDoc.embedFont(fs.readFileSync(boldPath));

  const page = pdfDoc.addPage([595, 842]); // A4
  const W = 595, H = 842;

  const margin = 40;
  let y = H - margin;

  const drawText = (text, x, y, size, font) => {
    page.drawText(String(text), { x, y, size, font, color: rgb(0, 0, 0) });
  };

  // Заголовок
  drawText("НАКЛАДНАЯ", margin, y - 10, 20, fontBold);
  drawText(`№${inv.invoiceId}`, W - margin - 80, y - 8, 16, fontBold);
  y -= 40;

  drawText(`Дата: ${inv.date}`, margin, y, 12, fontRegular);
  drawText(`Поставщик: ${inv.supplier || "________________"}`, margin, y - 18, 12, fontRegular);
  drawText(`Доставка (ETA): ${inv.etaText || "—"}`, margin, y - 36, 12, fontRegular);
  y -= 60;

  // Таблица: колонки
  const tableX = margin;
  const tableW = W - margin * 2;

  const colNo = 35;
  const colName = 290;
  const colQty = 60;
  const colPrice = 80;
  const colSum = tableW - (colNo + colName + colQty + colPrice);

  const rowH = 26;

  // Шапка таблицы
  page.drawRectangle({ x: tableX, y: y - rowH, width: tableW, height: rowH, color: rgb(0.93, 0.93, 0.93) });
  drawText("№", tableX + 10, y - 18, 12, fontBold);
  drawText("Наименование", tableX + colNo + 8, y - 18, 12, fontBold);
  drawText("Кол-во", tableX + colNo + colName + 8, y - 18, 12, fontBold);
  drawText("Цена", tableX + colNo + colName + colQty + 8, y - 18, 12, fontBold);
  drawText("Сумма", tableX + colNo + colName + colQty + colPrice + 8, y - 18, 12, fontBold);

  // Сетка вертикальная
  const x1 = tableX + colNo;
  const x2 = x1 + colName;
  const x3 = x2 + colQty;
  const x4 = x3 + colPrice;

  const line = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: rgb(0.75, 0.75, 0.75) });

  // Верхняя граница
  line(tableX, y, tableX + tableW, y);
  y -= rowH;
  line(tableX, y, tableX + tableW, y);

  line(x1, y + rowH, x1, y - rowH * (inv.items.length));
  line(x2, y + rowH, x2, y - rowH * (inv.items.length));
  line(x3, y + rowH, x3, y - rowH * (inv.items.length));
  line(x4, y + rowH, x4, y - rowH * (inv.items.length));
  line(tableX, y + rowH, tableX, y - rowH * (inv.items.length));
  line(tableX + tableW, y + rowH, tableX + tableW, y - rowH * (inv.items.length));

  // Строки
  for (let i = 0; i < inv.items.length; i++) {
    const it = inv.items[i];
    const rowTop = y - i * rowH;
    const rowBottom = rowTop - rowH;

    line(tableX, rowBottom, tableX + tableW, rowBottom);

    drawText(String(i + 1), tableX + 10, rowTop - 18, 12, fontRegular);

    const name = String(it.name || "").slice(0, 40);
    drawText(name, tableX + colNo + 8, rowTop - 18, 12, fontRegular);

    drawText(String(it.qty), tableX + colNo + colName + 8, rowTop - 18, 12, fontRegular);
    drawText(String(it.unit_price), tableX + colNo + colName + colQty + 8, rowTop - 18, 12, fontRegular);
    drawText(String(it.sum), tableX + colNo + colName + colQty + colPrice + 8, rowTop - 18, 12, fontRegular);
  }

  y = y - inv.items.length * rowH - 30;

  // Итог
  drawText(`ИТОГО: ${inv.total} тг`, W - margin - 220, y, 16, fontBold);

  return await pdfDoc.save();
}

module.exports = { buildPdf };
