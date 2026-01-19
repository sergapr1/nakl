const { fetch, FormData, File } = require("undici");

async function transcribeOggWithGroq(audioBuf) {
  const fd = new FormData();
  fd.set("model", process.env.GROQ_ASR_MODEL || "whisper-large-v3"); // можно whisper-large-v3-turbo [web:237]
  fd.set("file", new File([audioBuf], "voice.ogg", { type: "audio/ogg" }));

  // Параметры совместимы с OpenAI-style transcription:
  fd.set("temperature", "0");
  fd.set("language", "ru");
  fd.set(
    "prompt",
    "Это накладная. Частые слова: накладная, доставка, штука, штук, по, тенге, тг, антигель, Mannol. Числа важны."
  );

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: fd
  });

  const j = await r.json();
  return (j.text || "").trim();
}

module.exports = { transcribeOggWithGroq };
