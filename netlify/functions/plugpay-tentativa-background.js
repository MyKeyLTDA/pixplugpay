// Função em segundo plano: executa UMA tentativa de gerar o Pix, 30 s depois da anterior, numa chamada própria.
// Só aceita chamadas internas (cabeçalho x-interno), disparadas pela própria função plugpay.
const crypto = require("crypto");

exports.handler = async (event) => {
  const { processarTentativaAgendada, segredoInterno } = require("./plugpay");
  const recebido = Buffer.from(String((event.headers || {})["x-interno"] || ""));
  const esperado = Buffer.from(segredoInterno());
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return { statusCode: 401, body: "" };
  let id; try { id = Number(JSON.parse(event.body || "{}").id); } catch { id = NaN; }
  if (!Number.isFinite(id)) return { statusCode: 400, body: "" };
  try { await processarTentativaAgendada(id); } catch (e) { console.error("tentativa em segundo plano:", e.message); }
  return { statusCode: 202, body: "" };
};
