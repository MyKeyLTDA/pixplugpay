// Recebe as notificações da PlugPay e grava no Supabase.
// URL para informar à PlugPay: https://SEU-SITE.netlify.app/.netlify/functions/plugpay-webhook

const crypto = require("crypto");
const db = require("../lib/supabase");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Comparação em tempo constante
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function autorizado(headers) {
  const token = process.env.WEBHOOK_TOKEN;
  if (!token) return false; // sem token configurado, não aceita nada
  const nome = (process.env.WEBHOOK_AUTH_HEADER || "authorization").toLowerCase();
  const recebido = String(headers[nome] || "").replace(/^Bearer\s+/i, "");
  return safeEqual(recebido, token);
}

const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");

function normalizar(b) {
  return {
    ambiente: db.ambiente(),
    id_transacao: pick(b.IdTransacao, b.idTransacao),
    metodo: pick(b.paymentMethod, b.metodo),
    referencia: pick(b.referenciaInterna, b.serialNumber),
    serial_number: b.serialNumber,
    status: pick(b.status),
    status_descricao: b.statusDescription,
    moeda: pick(b.currency, b.originCurrencie),
    valor: b.value,
    valor_brl: b.valueBRL,
    documento_merchant: b.documentMerchant,
    codigo_transacao: b.transactionCode,
    e2e: pick(b.e2e, b.endToEndId),
    pago_em: b.paidAt,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
  if (!db.enabled()) return json(500, { error: "Supabase não configurado" });
  if (!autorizado(event.headers || {})) return json(401, { error: "Não autorizado" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }

  const p = normalizar(body);
  const base = {
    ambiente: p.ambiente,
    id_transacao: p.id_transacao ? Number(p.id_transacao) : null,
    status: p.status !== undefined ? Number(p.status) : null,
    payload: body,
  };

  if (!p.id_transacao) {
    // Sem IdTransacao não há como gravar a transação, mas guarda o payload para análise.
    try { await db.logWebhook({ ...base, processado: false, erro: "payload sem IdTransacao" }); } catch (_) {}
    return json(200, { ok: true, ignorado: "sem IdTransacao" });
  }

  try {
    await db.registrar(p);
    await db.logWebhook({ ...base, processado: true });
    return json(200, { ok: true });
  } catch (e) {
    // Falha de banco: tenta guardar o payload e devolve 500 para a PlugPay reenviar.
    try { await db.logWebhook({ ...base, processado: false, erro: e.message.slice(0, 500) }); } catch (_) {}
    return json(500, { error: "Falha ao gravar" });
  }
};
