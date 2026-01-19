function pad2(n) {
  return String(n).padStart(2, "0");
}

// Google Calendar link: action=TEMPLATE + dates(start/end) + ctz [web:125][web:138]
function makeGCalLink({ title, details, startLocal }) {
  // Важно: start/end должны быть оба, иначе ссылка может не работать [web:138]
  const start = `${startLocal.y}${pad2(startLocal.mo)}${pad2(startLocal.d)}T${pad2(startLocal.hh)}${pad2(startLocal.mm)}00`;

  // end = +10 минут
  const endMinTotal = (startLocal.hh * 60 + startLocal.mm) + 10;
  const endH = Math.floor(endMinTotal / 60) % 24;
  const endM = endMinTotal % 60;
  const end = `${startLocal.y}${pad2(startLocal.mo)}${pad2(startLocal.d)}T${pad2(endH)}${pad2(endM)}00`;

  const base = "https://calendar.google.com/calendar/render?action=TEMPLATE";
  const params = new URLSearchParams({
    text: title,
    dates: `${start}/${end}`,
    details,
    ctz: "Asia/Almaty"
  });

  return `${base}&${params.toString()}`;
}

module.exports = { makeGCalLink };
