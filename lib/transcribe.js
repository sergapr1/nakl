const { fetch, FormData, File } = require("undici");

async function transcribeOggWithGroq(audioBuf) {
  const fd = new FormData();
  fd.set("model", "whisper-large-v3");
  fd.set("file", new File([audioBuf], "voice.ogg", { type: "audio/ogg" }));

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: fd
  });

  const j = await r.json();
  return (j.text || "").trim();
}

module.exports = { transcribeOggWithGroq };
