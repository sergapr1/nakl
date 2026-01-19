const { Redis } = require("@upstash/redis");
const redis = Redis.fromEnv();

async function setJSON(key, value) {
  if (value === null || value === undefined) {
    await redis.del(key);
    return;
  }
  await redis.set(key, value);
}

async function getJSON(key) {
  return await redis.get(key);
}

async function saveInvoice(chatId, inv) {
  await setJSON(`inv:${chatId}:${inv.invoiceId}`, inv);
  await redis.lpush(`invlist:${chatId}`, inv.invoiceId);
  await redis.ltrim(`invlist:${chatId}`, 0, 499); // последние 500
}

async function listInvoices(chatId, limit = 20) {
  const ids = await redis.lrange(`invlist:${chatId}`, 0, limit - 1);
  const out = [];
  for (const id of ids) {
    const inv = await redis.get(`inv:${chatId}:${id}`);
    if (inv) out.push(inv);
  }
  return out;
}

module.exports = { redis, setJSON, getJSON, saveInvoice, listInvoices };
