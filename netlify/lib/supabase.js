// Acesso mínimo ao Supabase via REST (sem biblioteca). Usa a chave de SERVIÇO: só no servidor.

function cfg() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

const enabled = () => !!cfg();

async function req(path, { method = "POST", body, headers = {} } = {}) {
  const c = cfg();
  if (!c) throw new Error("Supabase não configurado");
  const res = await fetch(c.url + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: c.key,
      // chave antiga (service_role) é JWT e vai também em Authorization; a nova (sb_secret_...) só em apikey
      ...(c.key.startsWith("sb_") ? {} : { Authorization: "Bearer " + c.key }),
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + text.slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

// Grava/atualiza a transação (função SQL idempotente)
const registrar = (p) => req("rpc/plugpay_registrar", { body: { p } });

// Guarda o webhook recebido, na íntegra
const logWebhook = (row) => req("plugpay_webhook_log", { body: row, headers: { Prefer: "return=minimal" } });

// Guarda várias linhas de log de uma vez
// PostgREST (PGRST102) exige que todas as linhas de um lote tenham as MESMAS chaves: completa com null.
const inserirLogs = (rows) => {
  const chaves = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const iguais = rows.map((r) => Object.fromEntries(chaves.map((k) => [k, r[k] === undefined ? null : r[k]])));
  return req("plugpay_api_log", { body: iguais, headers: { Prefer: "return=minimal" } });
};

// Últimas chamadas registradas
const listarLogs = (limite = 30) =>
  req("plugpay_api_log?select=*&order=criado_em.desc&limit=" + Number(limite), { method: "GET" });

// Atualiza só o status (consulta de status na PlugPay)
const atualizarStatus = (ref, status, descricao) =>
  req("rpc/plugpay_atualizar_status", {
    body: { p_ambiente: ambiente(), p_ref: ref, p_status: Number(status), p_descricao: descricao || null },
  });

// Lista transações do ambiente atual, com filtros opcionais (sem a imagem do QR, para ficar leve)
const COLUNAS = "id,criado_em,atualizado_em,metodo,referencia,serial_number,id_transacao,status,status_descricao," +
  "moeda,valor,valor_brl,referencia_externa,nota_fiscal,observacoes,descricao,cpf_cliente,nome_cliente,criado_por,editado_por,editado_em," +
  "e2e,pago_em,data_pago_plug,nome_informado,qr_copia_cola";
function listarTransacoes({ status, busca, usuario, nf, plug, de, ate, limite = 50 } = {}) {
  let q = "plugpay_transacoes?select=" + COLUNAS + "&ambiente=eq." + encodeURIComponent(ambiente()) +
    "&order=criado_em.desc&limit=" + Math.min(Number(limite) || 50, 1000);
  if (status !== undefined && status !== "" && status !== null && Number.isFinite(Number(status))) {
    q += "&status=eq." + Number(status);
  }
  const u = String(usuario || "").trim();
  if (u && /^[\w.+@-]{1,100}$/.test(u)) q += "&criado_por=eq." + encodeURIComponent(u);
  if (nf === "vazias") q += "&nota_fiscal=is.null";          // ainda sem número de nota
  else if (nf === "preenchidas") q += "&nota_fiscal=not.is.null";
  if (plug === "sem_data") q += "&data_pago_plug=is.null";     // a PlugPay ainda não repassou (ou ainda não conferido)
  else if (plug === "com_data") q += "&data_pago_plug=not.is.null";
  // Período (datas no horário de Brasília): de = início do dia, ate = fim do dia (exclusivo no dia seguinte)
  const dia = /^\d{4}-\d{2}-\d{2}$/;
  if (dia.test(String(de || ""))) q += "&criado_em=gte." + encodeURIComponent(de + "T00:00:00-03:00");
  if (dia.test(String(ate || ""))) {
    const d = new Date(ate + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
    q += "&criado_em=lt." + encodeURIComponent(d.toISOString().slice(0, 10) + "T00:00:00-03:00");
  }
  const t = String(busca || "").replace(/[^\p{L}\p{N} ._\-]/gu, "").trim().slice(0, 60);
  if (t) {
    const like = encodeURIComponent("*" + t + "*");
    q += "&or=(referencia_externa.ilike." + like + ",referencia.ilike." + like + ",serial_number.ilike." + like + ",cpf_cliente.ilike." + like + ",nome_cliente.ilike." + like + ",nota_fiscal.ilike." + like + ",observacoes.ilike." + like + ")";
  }
  return req(q, { method: "GET" });
}

// Uma transação com o QR (para reabrir a cobrança)
const buscarTransacao = (id) =>
  req("plugpay_transacoes?select=*&id=eq." + Number(id) + "&ambiente=eq." + encodeURIComponent(ambiente()) + "&limit=1",
    { method: "GET" });

// Atualiza uma transação só se ela ainda estiver na condição esperada (ex.: status=5). Devolve a linha ou null.
async function atualizarSe(id, condicao, campos) {
  const q = "plugpay_transacoes?id=eq." + Number(id) + "&ambiente=eq." + encodeURIComponent(ambiente()) + condicao;
  const r = await req(q, { method: "PATCH", body: { ...campos, atualizado_em: new Date().toISOString() },
    headers: { Prefer: "return=representation" } });
  return Array.isArray(r) && r[0] ? r[0] : null;
}

// ---- Links de pagamento ----
const criarLink = (row) =>
  req("plugpay_links", { body: row, headers: { Prefer: "return=representation" } }).then((r) => r[0]);

const buscarLink = (token) =>
  req("plugpay_links?select=*&token=eq." + encodeURIComponent(token) + "&ambiente=eq." + encodeURIComponent(ambiente()) + "&limit=1",
    { method: "GET" }).then((r) => r[0] || null);

// Atualiza o link só se a condição ainda valer (usado para "reservar" o link de forma atômica)
const atualizarLinkSe = (token, condicao, campos) =>
  req("plugpay_links?token=eq." + encodeURIComponent(token) + "&ambiente=eq." + encodeURIComponent(ambiente()) + condicao,
    { method: "PATCH", body: campos, headers: { Prefer: "return=representation" } }).then((r) => (Array.isArray(r) && r[0]) || null);

// Últimos links, já com o status do pagamento (junta pelo id da transação)
async function listarLinks(limite = 30) {
  const links = await req("plugpay_links?select=*&ambiente=eq." + encodeURIComponent(ambiente()) +
    "&order=criado_em.desc&limit=" + Math.min(Number(limite) || 30, 100), { method: "GET" });
  const ids = links.map((l) => l.id_transacao).filter(Boolean);
  let porId = {};
  if (ids.length) {
    const ts = await req("plugpay_transacoes?select=id_transacao,status,nome_cliente&ambiente=eq." + encodeURIComponent(ambiente()) +
      "&id_transacao=in.(" + ids.join(",") + ")", { method: "GET" });
    porId = Object.fromEntries(ts.map((t) => [t.id_transacao, t]));
  }
  return links.map((l) => ({ ...l, status: l.id_transacao && porId[l.id_transacao] ? porId[l.id_transacao].status : null,
    nome_cliente: l.id_transacao && porId[l.id_transacao] ? porId[l.id_transacao].nome_cliente : null }));
}

const buscarPorIdTransacao = (id) =>
  req("plugpay_transacoes?select=*&id_transacao=eq." + Number(id) + "&ambiente=eq." + encodeURIComponent(ambiente()) + "&limit=1",
    { method: "GET" }).then((r) => r[0] || null);

// E-mails que já emitiram cobranças (para o filtro por usuário)
// Transações com CPF, para padronizar nomes (leve: só o necessário)
const listarParaPadronizar = () =>
  req("plugpay_transacoes?select=id,cpf_cliente,nome_cliente,nome_informado,nome_manual_em,criado_em&ambiente=eq." + encodeURIComponent(ambiente()) +
    "&cpf_cliente=not.is.null&order=criado_em.desc&limit=5000", { method: "GET" });

async function listarUsuarios() {
  const r = await req("plugpay_transacoes?select=criado_por&criado_por=not.is.null&ambiente=eq." + encodeURIComponent(ambiente()) + "&limit=5000", { method: "GET" });
  return [...new Set(r.map((x) => x.criado_por))].sort();
}

const ambiente = () =>
  process.env.PLUGPAY_AMBIENTE ||
  (/sandbox/i.test(process.env.PLUGPAY_BASE_URL || "sandbox") ? "sandbox" : "producao");


// ---- Token da PlugPay compartilhado entre instâncias (tabela plugpay_token) ----
const tokenQ = () => "plugpay_token?ambiente=eq." + encodeURIComponent(ambiente());
async function tokenLer() {
  const r = await req(tokenQ() + "&select=token,expira_em,bloqueado_ate,lock_ate&limit=1", { method: "GET" });
  return Array.isArray(r) && r[0] ? r[0] : null;
}
const tokenGarantirLinha = () =>
  req("plugpay_token?on_conflict=ambiente", { body: { ambiente: ambiente() }, headers: { Prefer: "resolution=ignore-duplicates,return=minimal" } });
// Trava atômica: só uma instância consegue (PATCH condicional) — devolve true se ganhou
async function tokenTrava(ate) {
  const r = await req(tokenQ() + "&or=(lock_ate.is.null,lock_ate.lt." + encodeURIComponent(new Date().toISOString()) + ")",
    { method: "PATCH", body: { lock_ate: ate }, headers: { Prefer: "return=representation" } });
  return Array.isArray(r) && r.length > 0;
}
const tokenSalvar = ({ token, expira_em }) =>
  req(tokenQ(), { method: "PATCH", body: { token, expira_em, bloqueado_ate: null, lock_ate: null, atualizado_em: new Date().toISOString() }, headers: { Prefer: "return=minimal" } });
const tokenBloquear = (ate) =>
  req(tokenQ(), { method: "PATCH", body: { bloqueado_ate: ate, lock_ate: null }, headers: { Prefer: "return=minimal" } });
const tokenSoltar = () =>
  req(tokenQ(), { method: "PATCH", body: { lock_ate: null }, headers: { Prefer: "return=minimal" } });


// ---- Tentativas de gerar o Pix ----
const amb = () => "&ambiente=eq." + encodeURIComponent(ambiente());
const criarTentativa = (row) =>
  req("plugpay_tentativas", { body: { ambiente: ambiente(), ...row }, headers: { Prefer: "return=representation" } }).then((r) => (Array.isArray(r) ? r[0] : r));
const lerTentativa = (id) =>
  req("plugpay_tentativas?select=*&id=eq." + Number(id) + amb() + "&limit=1", { method: "GET" }).then((r) => r[0] || null);
const ultimaTentativaDoLink = (token) =>
  req("plugpay_tentativas?select=*&link_token=eq." + encodeURIComponent(token) + amb() + "&order=criado_em.desc&limit=1", { method: "GET" }).then((r) => r[0] || null);
// Atualiza só se a condição ainda valer (assim só uma chamada assume cada tentativa)
const atualizarTentativaSe = (id, condicao, campos) =>
  req("plugpay_tentativas?id=eq." + Number(id) + amb() + condicao,
    { method: "PATCH", body: { ...campos, atualizado_em: new Date().toISOString() }, headers: { Prefer: "return=representation" } })
    .then((r) => (Array.isArray(r) && r[0]) || null);
// Tentativas paradas: esperando além da hora, ou "gerando" com a reserva vencida (chamada que morreu)
const listarTentativasVencidas = (agoraIso, limite = 5) =>
  req("plugpay_tentativas?select=id&or=(and(estado.eq.aguardando,proxima_em.lt." + agoraIso + "),and(estado.eq.gerando,gerando_ate.lt." + agoraIso + "))" +
    amb() + "&order=proxima_em.asc.nullsfirst&limit=" + Number(limite), { method: "GET" });

module.exports = { criarTentativa, lerTentativa, ultimaTentativaDoLink, atualizarTentativaSe, listarTentativasVencidas, listarParaPadronizar, tokenLer, tokenGarantirLinha, tokenTrava, tokenSalvar, tokenBloquear, tokenSoltar, enabled, registrar, logWebhook, inserirLogs, listarLogs, atualizarStatus, listarTransacoes, buscarTransacao, atualizarSe, criarLink, buscarLink, atualizarLinkSe, listarLinks, buscarPorIdTransacao, listarUsuarios, ambiente };
