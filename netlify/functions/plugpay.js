// Intermediário entre a tela e a API da PlugPay.
// Credenciais ficam só aqui (variáveis de ambiente do Netlify), nunca no navegador.

const crypto = require("crypto");
const db = require("../lib/supabase");
const auth = require("../lib/auth");
const mensagens = require("../lib/mensagens");
const { sanitizar, mascararBruto } = require("../lib/log");

let campoCPF = process.env.PLUGPAY_CPF_FIELD || "customerCPFCNPJ";
const BASE = (process.env.PLUGPAY_BASE_URL || "https://apisandbox.plugpayapi.com").replace(/\/$/, "");

// Cache do token na memória da função (vale enquanto a instância estiver "quente")
const tk = require("../lib/token"); // token único, reaproveitado até perto do vencimento

// Contexto da requisição atual (cada invocação roda uma por vez)
let ctx = { id: "-", acao: null, usuario: null, logs: [] };

// 429/503 da PlugPay seguem como são (com Retry-After); o resto continua 502
function respostaDeErro(e) {
  if (e && (e.status === 429 || e.status === 503)) {
    const r = json(e.status, { error: e.message, retryAfter: e.retryAfter });
    r.headers["Retry-After"] = String(e.retryAfter || 5);
    return r;
  }
  return json(502, { error: e.message });
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function addLog(l) {
  const linha = {
    request_id: ctx.id,
    acao: ctx.acao,
    ambiente: db.ambiente(),
    ...l,
  };
  ctx.logs.push(linha);
  console.log(JSON.stringify({ plugpay: linha })); // aparece em Netlify > Functions > Logs
}

// Guarda a cobrança como "pendente" assim que é criada. Falha de banco não derruba a cobrança.
async function guardarCobranca(metodo, pedido, resposta) {
  if (!db.enabled() || !resposta || !resposta.IdTransacao) return;
  try {
    await db.registrar({
      ambiente: db.ambiente(),
      id_transacao: resposta.IdTransacao,
      metodo,
      referencia: resposta.referenciaInterna || resposta.serialNumber,
      serial_number: resposta.serialNumber,
      status: 5,
      status_descricao: "PENDIENTE DE PAGO",
      moeda: pedido.moeda,
      valor: pedido.valor,
      valor_brl: resposta.valueBRL,
      documento_merchant: pedido.documentMerchant,
      referencia_externa: pedido.referenciaExterna || null,
      cpf_cliente: pedido.cpfCliente || null,
      nome_cliente: pedido.nomeCliente || null,
      criado_por: pedido.criadoPor || ctx.usuario || null,
      descricao: pedido.descricao || null,
      qr_copia_cola: resposta.qrCodeCopiaCola || null,
      qr_imagem: resposta.qrCodeStringImage || resposta.qrImageUrl || null,
      qr_code_id: resposta.qrCodeId || null, // vem de volta como referenciaInterna no aviso de pagamento
    });
  } catch (e) {
    console.error("Falha ao gravar cobrança:", e.message);
  }
}

const DESCRICAO_STATUS = { 5: "PENDIENTE DE PAGO", 1: "APROBADO", 3: "RECHAZADO", 6: "CANCELADO", 9: "REVERSADO" };

// A PlugPay às vezes manda o status em texto ("APROBADO", IdStatus "1"): converte para 1/3/5/6/9
const TEXTO_STATUS = [
  [/APROB|APPROV|PAGO|PAID|CONFIRM/, 1],
  [/RECHAZ|REJECT|RECUS|DENEG/, 3],
  [/CANCEL/, 6],
  [/REVERS|REVERT|REFUND|ESTORN|DEVUEL/, 9],
  [/PEND|WAIT|AGUARD/, 5],
];
function lerStatus(o) {
  for (const c of [o?.IdStatus, o?.idStatus, o?.status, o?.transaction?.status, o?.data?.status, o?.statusDescription]) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (DESCRICAO_STATUS[n]) return n;
    const t = String(c).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    for (const [re, v] of TEXTO_STATUS) if (re.test(t)) return v;
  }
  return null;
}
// Resposta de consulta de status para a tela: sempre com statusCodigo; 404 vira "ainda pendente"
async function respostaStatus(r, ref) {
  if (r.status === 404) {
    const doBanco = await statusDoBanco(ref);
    if (doBanco !== null) return json(200, { statusCodigo: doBanco, origem: "banco" });
    return json(200, { statusCodigo: 5, naoEncontrado: true, resposta: r.data });
  }
  if (!r.ok) return json(r.status, r.data);
  return json(200, { ...r.data, statusCodigo: lerStatus(r.data) });
}

// Se a PlugPay não acha a cobrança na consulta (404), o banco pode já ter o status gravado pelo
// webhook: devolve esse status em vez de "pendente".
async function statusDoBanco(ref) {
  if (!db.enabled() || !ref) return null;
  try {
    const [t = null] = await db.listarTransacoes({ busca: ref, limite: 1 });
    return t && DESCRICAO_STATUS[t.status] ? t.status : null;
  } catch (e) { return null; }
}

// Depois de consultar o status na PlugPay, reflete no banco (falha de banco não derruba a consulta)
async function sincronizarStatus(ref, dados) {
  const st = lerStatus(dados);
  if (!db.enabled() || !ref || !DESCRICAO_STATUS[st]) return;
  try { await db.atualizarStatus(ref, st, DESCRICAO_STATUS[st]); }
  catch (e) { console.error("Falha ao atualizar status:", e.message); }
}

// Chamada HTTP à PlugPay, sempre registrada no log
async function pp(path, { method = "GET", body, token, timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs), // evita ficar pendurado até o Netlify derrubar a function
    });
    text = await res.text();
  } catch (e) {
    addLog({ endpoint: path, rota: method + " " + BASE + path, metodo: method, ok: false, duracao_ms: Date.now() - t0,
      request: sanitizar(body), erro: "Falha de rede: " + e.message });
    throw e;
  }
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  addLog({
    endpoint: path, rota: method + " " + BASE + path, metodo: method, status_http: res.status, ok: res.ok,
    duracao_ms: Date.now() - t0, request: sanitizar(body), response: sanitizar(data),
    resposta_bruta: mascararBruto(text),
    erro: res.ok ? null : String(data.message || data.error || text).slice(0, 300),
  });
  return { ok: res.ok, status: res.status, data, retryAfter: lerRetryAfter(res) };
}

// Retry-After em segundos (aceita número ou data HTTP)
function lerRetryAfter(res) {
  const h = res.headers && res.headers.get && res.headers.get("retry-after");
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(h);
  return t ? Math.max(1, (t - Date.now()) / 1000) : null;
}

// Pede o token à PlugPay. Só é chamada pelo módulo do token, quando realmente precisa renovar.
async function login() {
  const r = await pp("/v1/partners/auth/token", {
    method: "POST",
    body: { client_id: process.env.PLUGPAY_CLIENT_ID, password: process.env.PLUGPAY_PASSWORD },
  });
  if (r.status === 429) throw new tk.LimiteError(r.retryAfter);
  if (!r.ok || !r.data.token) throw new Error("Falha na autenticação PlugPay (" + r.status + ")");
  return { token: r.data.token, expiraEm: tk.calcularExpiracao(r.data, r.data.token), data: r.data };
}

// Chama a PlugPay com o token guardado. Só renova o token se a PlugPay o recusar (401), uma vez.
// 429: não repete e não vira 502 — sobe como LimiteError (o handler responde 429 + Retry-After).
async function call(path, opts = {}) {
  let token = await tk.obter(login);
  let r = await pp(path, { ...opts, token });
  if (r.status === 401) {
    token = await tk.obter(login, { rejeitado: token });
    r = await pp(path, { ...opts, token });
  }
  if (r.status === 429) throw new tk.LimiteError(r.retryAfter);
  return r;
}

// ---- Conversão BRL -> PYG/USD usando a rota de cotação da PlugPay ----
// POST /v1/partners/transactionPix/quote { originCurrencie, value, documentMerchant }
function extrairBRL(d) {
  const cand = [d?.valueBRL, d?.valorEmBRL, d?.valueBrl, d?.valor_brl, d?.data?.valueBRL, d?.quote?.valueBRL];
  for (const c of cand) {
    const n = Number(String(c ?? "").replace(",", "."));
    if (n > 0) return n;
  }
  return null;
}

async function cotar(moeda, valor, merchant) {
  const r = await call("/v1/partners/transactionPix/quote", {
    method: "POST",
    body: { originCurrencie: moeda, value: valor, documentMerchant: merchant },
  });
  if (!r.ok) throw new Error("Cotação recusada pela PlugPay: " + (r.data.message || r.data.error || r.status));
  const brl = extrairBRL(r.data);
  if (!brl) throw new Error("Resposta de cotação sem valor em reais: " + JSON.stringify(r.data).slice(0, 200));
  return brl;
}

async function converterBRL(alvo, moeda, merchant) {
  const casas = moeda === "PYG" ? 0 : 2;
  const passo = Math.pow(10, -casas);
  const arred = (x) => Number(x.toFixed(casas));
  const memo = new Map(); // não consulta duas vezes o mesmo valor
  const cotarM = async (v) => {
    if (!memo.has(v)) memo.set(v, await cotar(moeda, v, merchant));
    return memo.get(v);
  };

  const ref = moeda === "PYG" ? 100000 : 100;
  const taxa = (await cotarM(ref)) / ref; // reais por unidade da moeda

  let v = arred(alvo / taxa);
  let brl = await cotarM(v);
  let melhor = { value: v, valueBRL: brl };

  for (let i = 0; i < 3 && Math.abs(melhor.valueBRL - alvo) >= 0.005; i++) {
    let nv = arred(v + (alvo - brl) / taxa);
    if (nv === v) nv = arred(v + (alvo > brl ? passo : -passo));
    if (!(nv > 0) || memo.has(nv)) break;
    v = nv;
    brl = await cotarM(v);
    if (Math.abs(brl - alvo) < Math.abs(melhor.valueBRL - alvo)) melhor = { value: v, valueBRL: brl };
  }
  return { moeda, value: melhor.value, valueBRL: melhor.valueBRL, alvoBRL: alvo, taxa };
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

// Cria o Pix na PlugPay (converte de reais, tenta os dois nomes do campo CPF). Devolve { erro } ou { r, moeda, value, conversao, cpf }.
async function emitirPix(req, merchant) {
  // A tela pode mandar customerCPF ou customerCPFCNPJ: aceitamos os dois
  const cpf = onlyDigits(req.customerCPF || req.customerCPFCNPJ);
  if (cpf.length !== 11) return { erro: { status: 400, body: { error: "CPF deve ter 11 dígitos" } } };
  if (!merchant) return { erro: { status: 400, body: { error: "documentMerchant não informado" } } };
  // Diagnóstico: permite testar o CPF formatado (14 caracteres) em vez de só dígitos (11)
  const cpfEnviado = req.cpfFormatado ? cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : cpf;
  let moeda = req.originCurrencie || "USD";
  let value = Number(req.value);
  let conversao = null;
  if (req.valorBRL !== undefined) {
    // Valor pedido em reais: converte para PYG/USD antes de enviar
    const alvo = Number(req.valorBRL);
    moeda = req.moedaEnvio || "PYG";
    if (!(alvo > 0)) return { erro: { status: 400, body: { error: "Valor inválido" } } };
    if (!["PYG", "USD"].includes(moeda)) return { erro: { status: 400, body: { error: "Moeda de envio deve ser PYG ou USD" } } };
    conversao = await converterBRL(alvo, moeda, merchant);
    value = conversao.value;
  }
  if (!(value > 0)) return { erro: { status: 400, body: { error: "Valor inválido" } } };
  // O nome do campo do CPF difere entre o guia (customerCPF) e a API real (customerCPFCNPJ),
  // e pode variar entre sandbox e produção. Tenta o configurado e, se a PlugPay recusar por
  // causa do documento, tenta o outro nome uma vez. O que funcionar fica memorizado.
  const campos = [campoCPF, campoCPF === "customerCPFCNPJ" ? "customerCPF" : "customerCPFCNPJ"];
  let r, usado, primeira = null;
  for (const campo of campos) {
    usado = campo;
    r = await call("/v1/partners/transactionPix/create", {
      method: "POST",
      body: { originCurrencie: moeda, value, [campo]: cpfEnviado, documentMerchant: merchant },
    });
    if (!primeira) primeira = r;
    // Só troca o nome do campo quando a PlugPay diz que o CAMPO não chegou (tamanho/formato).
    // Erro sobre o CPF em si (ex.: "no está registrado") é resposta real: não mascarar com outra tentativa.
    if (r.ok || !/11 ó 14|caracteres/i.test(JSON.stringify(r.data || {}))) break;
  }
  // Se a 2ª tentativa só trouxe o erro de campo, vale a resposta da 1ª (a mais fiel ao problema real)
  if (!r.ok && primeira !== r && /11 ó 14|caracteres/i.test(JSON.stringify(r.data || {})) && !/11 ó 14|caracteres/i.test(JSON.stringify(primeira.data || {}))) {
    r = primeira; usado = campos[0];
  }
  if (r.ok) campoCPF = usado;
  if (!r.ok) {
    const dados = { ...r.data };
    if (/no est[aá] registrado/i.test(String(dados.message || ""))) {
      dados.message = "A PlugPay recusou: esse CPF não está registrado na base deles (o CPF é válido, mas a PlugPay não o reconhece). " +
        "Tente outro CPF do pagador ou peça à PlugPay a regra. | PlugPay: " + dados.message;
    }
    return { erro: { status: r.status, body: { ...dados, _enviado: { originCurrencie: moeda, value, campo_cpf: usado, tentados: campos, customerCPF_caracteres: cpfEnviado.length, documentMerchant: merchant } } } };
  }
  return { r, moeda, value, conversao, cpf };
}

// Confere os dígitos verificadores do CPF
function cpfValido(c) {
  c = onlyDigits(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += +c[i] * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== +c[t]) return false;
  }
  return true;
}

const TOKEN_OK = /^[A-Za-z0-9_-]{20,64}$/;
const LINK_VALIDADE_MIN = () => Number(process.env.LINK_VALIDADE_MIN) || 24 * 60;

// O que o cliente pode ver de um link: nunca CPF, nome de outros, documento do merchant etc.
async function visaoDoLink(link) {
  const base = { descricao: link.descricao, valorBRL: Number(link.valor_brl), expirado: new Date(link.expira_em) < new Date() };
  let idTransacao = link.id_transacao;
  if (!idTransacao && db.enabled()) {
    // Tentativas feitas pelo servidor: a página só acompanha o estado (não precisa fazer nada para elas andarem)
    const j = await db.ultimaTentativaDoLink(link.token).catch(() => null);
    if (j && (j.estado === "aguardando" || j.estado === "gerando")) return { ...base, ...viewTentando(j) };
    if (j && j.estado === "falhou" && !link.usado_em) return { ...base, estado: "falhou", de: TENTATIVAS_MAX };
    if (j && j.estado === "ok" && j.id_transacao) idTransacao = j.id_transacao;
  }
  if (!idTransacao) return { ...base, estado: "aguardando" };
  const t = await db.buscarPorIdTransacao(idTransacao);
  return { ...base, estado: "gerada", status: t ? t.status : 5, qrCopiaCola: t ? t.qr_copia_cola : null, valorBRL: t && t.valor_brl ? Number(t.valor_brl) : base.valorBRL };
}

// O que mostrar enquanto as tentativas correm: qual tentativa vem a seguir e quantos segundos faltam
function viewTentando(j) {
  const aguardando = j.estado === "aguardando";
  return { estado: "tentando", tentativa: Number(j.tentativa || 0) + (aguardando ? 1 : 0), de: TENTATIVAS_MAX,
    segundos: aguardando ? Math.max(0, Math.ceil((new Date(j.proxima_em) - Date.now()) / 1000)) : 0 };
}

const LINK_ERRO_GENERICO = "Não foi possível gerar o Pix agora. Tente de novo em instantes ou fale com o atendente.";

// Ações públicas (o cliente abre o link sem login). O token é a única credencial e vale para um único Pix.
async function tratarLinkPublico(req, merchant) {
  if (!db.enabled()) return json(503, { error: LINK_ERRO_GENERICO });
  const token = String(req.token || "");
  if (!TOKEN_OK.test(token)) return json(404, { error: "Link inválido." });
  const link = await db.buscarLink(token);
  if (!link) return json(404, { error: "Link inválido." });

  if (req.action === "link-info") return json(200, await visaoDoLink(link));

  // link-gerar
  const nome = String(req.nome || "").trim().slice(0, 100);
  if (nome.length < 3) return json(400, { error: "Informe seu nome completo." });
  if (!cpfValido(req.cpf)) return json(400, { error: "CPF inválido." });
  if (link.id_transacao) return json(200, await visaoDoLink(link)); // já gerado: mostra o mesmo Pix
  if (new Date(link.expira_em) < new Date()) return json(410, { error: "Este link expirou. Peça um novo ao atendente." });

  // Reserva o link de forma atômica: dois cliques ao mesmo tempo não geram dois Pix
  const reservado = await db.atualizarLinkSe(token, "&usado_em=is.null", { usado_em: new Date().toISOString() });
  if (!reservado) {
    const atual = await db.buscarLink(token);
    return json(200, await visaoDoLink(atual || link));
  }
  let job;
  try {
    job = await db.criarTentativa({ tipo: "link", link_token: token, usuario: "cliente (link)", tentativa: 1, estado: "gerando",
      gerando_ate: new Date(Date.now() + LEASE_MS).toISOString(),
      pedido: { cpf: onlyDigits(req.cpf), nome, valorBRL: Number(link.valor_brl), moedaEnvio: link.moeda_envio, descricao: link.descricao, criadoPor: link.criado_por } });
  } catch (err) {
    await db.atualizarLinkSe(token, "", { usado_em: null }).catch(() => {});
    console.error("link-gerar:", err.message);
    return json(502, { error: LINK_ERRO_GENERICO });
  }
  const r = await finalizarTentativa(job, 1, await tentarGerar(job, merchant));
  if (r.tipo === "ok") return json(200, { ...base_vazio(), estado: "gerada", status: 5, qrCopiaCola: r.resultado.qrCodeCopiaCola || null, valorBRL: Number(r.resultado.valueBRL) || Number(link.valor_brl), descricao: link.descricao });
  if (r.tipo === "tentando") return json(200, { ...base_vazio(), descricao: link.descricao, valorBRL: Number(link.valor_brl), ...viewTentando(r.job) });
  if (r.tipo === "falhou") return json(200, { ...base_vazio(), descricao: link.descricao, valorBRL: Number(link.valor_brl), estado: "falhou", de: TENTATIVAS_MAX });
  return r.fatal.pronta || json(502, { error: LINK_ERRO_GENERICO });
}

// ---------------------------------------------------------------------------------------------
// Tentativas de gerar o Pix: até 3, 30 s entre elas. O servidor anda sozinho: cada tentativa roda numa
// chamada própria (função em segundo plano, com a varredura de 1 min como rede de segurança).
// Quem usa a tela só acompanha o estado.
const TENTATIVAS_MAX = 3;
const ESPERA_MS = () => (Number(process.env.TENTATIVA_ESPERA_SEG) || 30) * 1000;
const LEASE_MS = 90 * 1000;

// Vale nova tentativa: falha do servidor da PlugPay e o "CPF não registrado" (o suporte deles só manda tentar de novo)
const retentavel = (erro) => erro.status >= 500 || (erro.status === 422 && /registrado/i.test(String((erro.body && erro.body.message) || "")));

// Uma tentativa. Devolve { ok: resultado } | { retentar: true, motivo } | { fatal: { status, body } }
async function tentarGerar(job, merchant) {
  const p = job.pedido || {};
  ctx.usuario = ctx.usuario || job.usuario;
  try {
    const e = await emitirPix(job.tipo === "link"
      ? { customerCPF: p.cpf, valorBRL: p.valorBRL, moedaEnvio: p.moedaEnvio }
      : p.req, merchant);
    if (e.erro) {
      console.error("tentativa", job.id, "recusada:", JSON.stringify(e.erro.body).slice(0, 300));
      if (retentavel(e.erro)) return { retentar: true, motivo: String((e.erro.body && e.erro.body.message) || "").slice(0, 300) };
      return { fatal: job.tipo === "link" ? { status: 502, body: { error: LINK_ERRO_GENERICO } } : e.erro };
    }
    // Anota já o Pix que a PlugPay criou: se algo falhar daqui em diante e vier outra tentativa, este será cancelado
    const idNovo = e.r.data && e.r.data.IdTransacao;
    if (idNovo) {
      job.transacoes = [...(job.transacoes || []), idNovo];
      await db.atualizarTentativaSe(job.id, "", { transacoes: job.transacoes }).catch(() => {});
    }
    await guardarCobranca("PIX", job.tipo === "link"
      ? { moeda: e.moeda, valor: e.value, documentMerchant: merchant, cpfCliente: e.cpf, nomeCliente: p.nome, descricao: p.descricao, criadoPor: p.criadoPor }
      : { moeda: e.moeda, valor: e.value, documentMerchant: merchant, referenciaExterna: p.req.referenciaExterna, cpfCliente: e.cpf,
          nomeCliente: String(p.req.nomeCliente || "").trim().slice(0, 100) || null, criadoPor: job.usuario }, e.r.data);
    return { ok: { ...e.r.data, conversao: e.conversao }, idNovo };
  } catch (err) {
    console.error("tentativa", job.id, ":", err.message);
    if (err && (err.status === 429 || err.status === 503)) { // limite da PlugPay: respeita o Retry-After e devolve como antes (não é caso de repetir já)
      const pronta = respostaDeErro(err);
      if (job.tipo === "link") pronta.body = JSON.stringify({ error: "Muitas solicitações no momento. Aguarde alguns segundos e tente de novo." });
      return { fatal: { status: err.status, body: { error: err.message }, pronta } };
    }
    return { retentar: true, motivo: String(err.message || "").slice(0, 300) }; // rede, token ou limite: também vale tentar de novo
  }
}

// Depois de uma tentativa: conclui, agenda a próxima ou desiste na 3ª.
// Devolve { tipo: "ok" | "tentando" | "falhou" | "fatal", ... } para quem está esperando a resposta.
async function finalizarTentativa(job, numero, r) {
  const limpar = { pedido: null, proxima_em: null, gerando_ate: null };
  if (r.ok) {
    const idFinal = r.idNovo || null;
    await db.atualizarTentativaSe(job.id, "", { ...limpar, estado: "ok", tentativa: numero, id_transacao: idFinal, resultado: job.tipo === "atendente" ? r.ok : null, ultimo_erro: null });
    if (job.tipo === "link" && idFinal) await db.atualizarLinkSe(job.link_token, "", { id_transacao: idFinal }).catch((err) => console.error("link:", err.message));
    await cancelarSubstituidas(job, idFinal);
    return { tipo: "ok", resultado: r.ok };
  }
  const desistir = async (erro) => {
    await db.atualizarTentativaSe(job.id, "", { ...limpar, estado: "falhou", tentativa: numero, ultimo_erro: erro });
    if (job.tipo === "link") await db.atualizarLinkSe(job.link_token, "", { usado_em: null }).catch(() => {}); // libera para "Tentar de novo"
  };
  if (r.fatal) { await desistir(String((r.fatal.body && (r.fatal.body.message || r.fatal.body.error)) || "").slice(0, 300)); return { tipo: "fatal", fatal: r.fatal }; }
  if (numero >= TENTATIVAS_MAX) { await desistir(r.motivo || null); return { tipo: "falhou", ultimoErro: r.motivo || null }; }
  const proxima = new Date(Date.now() + ESPERA_MS()).toISOString();
  const novo = await db.atualizarTentativaSe(job.id, "", { tentativa: numero, estado: "aguardando", proxima_em: proxima, gerando_ate: null, ultimo_erro: r.motivo || null });
  await despachar(job.id);
  return { tipo: "tentando", job: novo || { ...job, tentativa: numero, estado: "aguardando", proxima_em: proxima } };
}

// Um Pix que a PlugPay criou numa tentativa anterior e foi substituído: fica cancelado para nós.
// Só pedimos o cancelamento à PlugPay se houver rota configurada (PLUGPAY_CANCEL_PATH); senão é só local.
async function cancelarSubstituidas(job, idFinal) {
  for (const id of (job.transacoes || []).filter((x) => x && x !== idFinal)) {
    let naPlug = false;
    if (process.env.PLUGPAY_CANCEL_PATH) {
      try { naPlug = (await call(process.env.PLUGPAY_CANCEL_PATH, { method: "POST", body: { IdTransacao: id } })).ok; } catch (e) { console.error("cancelar na PlugPay:", e.message); }
    }
    try {
      const t = await db.buscarPorIdTransacao(id);
      if (t && t.status === 5) {
        await db.atualizarSe(t.id, "", { status: 6, status_descricao: "CANCELADO",
          observacoes: ((t.observacoes ? t.observacoes + " | " : "") + "Substituído por nova tentativa" + (naPlug ? "" : " (cancelado só aqui; a PlugPay não foi avisada)")).slice(0, 300) });
      }
    } catch (e) { console.error("cancelar localmente:", e.message); }
  }
}

const segredoInterno = () => crypto.createHash("sha256").update("tentativa:" + (process.env.SUPABASE_SERVICE_KEY || process.env.PLUGPAY_PASSWORD || "")).digest("hex");

// Chama a função em segundo plano que espera os 30 s e executa a próxima tentativa (em outra chamada)
async function despachar(id) {
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");
  if (!base) return;
  try {
    await fetch(base + "/.netlify/functions/plugpay-tentativa-background", {
      method: "POST", headers: { "Content-Type": "application/json", "x-interno": segredoInterno() }, body: JSON.stringify({ id }),
    });
  } catch (e) { console.error("despachar tentativa:", e.message); } // a varredura de 1 min cobre
}

// Executa a próxima tentativa de um job, se já for a hora. Seguro para ser chamado por várias origens ao mesmo tempo.
async function processarTentativa(id) {
  ctx = { id: crypto.randomBytes(4).toString("hex"), acao: "tentativa", usuario: null, logs: [] };
  try {
    const job = await db.lerTentativa(id);
    if (!job || !(job.estado === "aguardando" || job.estado === "gerando")) return { estado: job && job.estado };
    ctx.usuario = job.usuario;
    const numero = Number(job.tentativa || 0) + 1;
    const agora = new Date().toISOString();
    if (numero > TENTATIVAS_MAX) { // a chamada da última tentativa morreu
      if (job.estado === "gerando" && new Date(job.gerando_ate) > new Date()) return { estado: "gerando" };
      return finalizarTentativa(job, TENTATIVAS_MAX, { retentar: true, motivo: job.ultimo_erro });
    }
    const cond = "&tentativa=eq." + Number(job.tentativa || 0) +
      "&or=(and(estado.eq.aguardando,proxima_em.lte." + agora + "),and(estado.eq.gerando,gerando_ate.lt." + agora + "))";
    const meu = await db.atualizarTentativaSe(id, cond, { tentativa: numero, estado: "gerando", gerando_ate: new Date(Date.now() + LEASE_MS).toISOString() });
    if (!meu) return { estado: job.estado }; // ainda não é a hora, ou outra chamada já pegou
    return await finalizarTentativa(meu, numero, await tentarGerar(meu, process.env.PLUGPAY_MERCHANT_DOC));
  } finally {
    if (db.enabled() && ctx.logs.length) { try { await db.inserirLogs(ctx.logs); } catch (e) { console.error("Falha ao gravar log:", e.message); } }
  }
}

// Função em segundo plano: espera até a hora marcada (no máximo ~1 min) e executa a tentativa
async function processarTentativaAgendada(id) {
  const job = await db.lerTentativa(id);
  if (!job || job.estado !== "aguardando") return;
  const falta = Math.min(new Date(job.proxima_em) - Date.now(), 65000);
  if (falta > 0) await new Promise((r) => setTimeout(r, falta + 200));
  return processarTentativa(id);
}

// Varredura (a cada minuto): pega tentativas paradas, como rede de segurança
async function varrerTentativas(orcamentoMs = 20000) {
  const t0 = Date.now(); const feitas = [];
  const vencidas = await db.listarTentativasVencidas(new Date(Date.now() - 8000).toISOString(), 5);
  for (const v of vencidas) {
    if (Date.now() - t0 > orcamentoMs) break;
    await processarTentativa(v.id); feitas.push(v.id);
  }
  return feitas;
}

const base_vazio = () => ({ expirado: false });

async function tratar(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  let req;
  try { req = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "JSON inválido" }); }
  ctx.acao = req.action;

  // Dados públicos para a tela de login (nenhum segredo aqui)
  if (req.action === "config") {
    const c = auth.configPublica();
    if (!c.supabaseUrl || !c.supabaseKey) return json(500, { error: "SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY não configurados no Netlify" });
    return json(200, { ...c, adminWhatsapp: onlyDigits(process.env.ADMIN_WHATSAPP) || null });
  }

  // Ações do cliente com link de pagamento: sem login, protegidas pelo token do link
  if (req.action === "link-info" || req.action === "link-gerar") {
    if (req.action === "link-gerar") ctx.usuario = "cliente (link)";
    return tratarLinkPublico(req, process.env.PLUGPAY_MERCHANT_DOC);
  }

  // Todo o resto exige usuário logado (Supabase Auth)
  const usuario = await auth.verificar(event.headers.authorization || event.headers.Authorization);
  if (!usuario) return json(401, { error: "Sessão inválida ou expirada. Entre novamente." });
  ctx.usuario = usuario.email;
  if (!process.env.PLUGPAY_CLIENT_ID || !process.env.PLUGPAY_PASSWORD) {
    return json(500, { error: "Credenciais PlugPay não configuradas no Netlify" });
  }

  const merchant = req.documentMerchant || process.env.PLUGPAY_MERCHANT_DOC;

  switch (req.action) {
    case "logs": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado: logs só no painel do Netlify" });
      return json(200, { logs: await db.listarLogs(req.limite || 30) });
    }

    case "create-pix": {
      if (!db.enabled()) { // sem banco não há onde guardar as tentativas: comportamento simples
        const e = await emitirPix(req, merchant);
        if (e.erro) return json(e.erro.status, e.erro.body);
        await guardarCobranca("PIX", { moeda: e.moeda, valor: e.value, documentMerchant: merchant, referenciaExterna: req.referenciaExterna, cpfCliente: e.cpf,
          nomeCliente: String(req.nomeCliente || "").trim().slice(0, 100) || null }, e.r.data);
        return json(200, { ...e.r.data, conversao: e.conversao });
      }
      const { action, ...pedidoReq } = req;
      const job = await db.criarTentativa({ tipo: "atendente", usuario: ctx.usuario, tentativa: 1, estado: "gerando",
        gerando_ate: new Date(Date.now() + LEASE_MS).toISOString(), pedido: { req: { ...pedidoReq, documentMerchant: merchant } } });
      const r = await finalizarTentativa(job, 1, await tentarGerar(job, merchant));
      if (r.tipo === "ok") return json(200, r.resultado);
      if (r.tipo === "fatal") return r.fatal.pronta || json(r.fatal.status, r.fatal.body);
      if (r.tipo === "tentando") return json(202, { ...viewTentando(r.job), job: job.id });
      return json(200, { estado: "falhou", de: TENTATIVAS_MAX, ultimoErro: r.ultimoErro, job: job.id });
    }

    // A tela do atendente acompanha as tentativas (só leitura; quem as executa é o servidor)
    case "tentativa-status": {
      const j = await db.lerTentativa(req.job);
      if (!j || j.tipo !== "atendente") return json(404, { error: "Tentativa não encontrada." });
      if (j.estado === "ok") return json(200, { estado: "ok", resultado: j.resultado });
      if (j.estado === "falhou") return json(200, { estado: "falhou", de: TENTATIVAS_MAX, ultimoErro: j.ultimo_erro });
      return json(200, viewTentando(j));
    }

    case "link-criar": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      const valor = Number(req.valorBRL);
      const moeda = req.moedaEnvio || "PYG";
      const descricao = String(req.descricao || "").trim().slice(0, 200);
      if (!(valor > 0) || valor > 1000000) return json(400, { error: "Valor inválido" });
      if (!["PYG", "USD"].includes(moeda)) return json(400, { error: "Moeda de envio deve ser PYG ou USD" });
      if (descricao.length < 3) return json(400, { error: "Informe a descrição." });
      const link = await db.criarLink({
        token: crypto.randomBytes(24).toString("base64url"), ambiente: db.ambiente(), valor_brl: valor, moeda_envio: moeda,
        descricao, criado_por: usuario.email, expira_em: new Date(Date.now() + LINK_VALIDADE_MIN() * 60000).toISOString(),
      });
      return json(200, { token: link.token, expira_em: link.expira_em });
    }

    case "link-listar": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      const links = await db.listarLinks(req.limite || 30);
      const livres = links.filter((l) => !l.id_transacao && !l.usado_em).map((l) => l.token);
      const falhas = await db.falhasDeLinks(livres).catch(() => []);
      for (const l of links) { // a 1ª da lista é a mais recente
        const f = falhas.find((x) => x.link_token === l.token);
        if (f && !l.usado_em && !l.id_transacao) l.falha = { erro: f.ultimo_erro || "erro sem detalhe", em: f.atualizado_em };
      }
      return json(200, { links });
    }

    // Anexa/corrige o número do pedido e a nota fiscal depois da venda
    case "editar": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      const campos = {};
      if (req.numeroPedido !== undefined) {
        const n = String(req.numeroPedido).trim();
        if (n && !/^\d{1,20}$/.test(n)) return json(400, { error: "O número do pedido deve conter só números." });
        campos.referencia_externa = n || null;
      }
      if (req.notaFiscal !== undefined) {
        // Número ou texto livre (ex.: "Não efetivado"): só tira caracteres de controle e limita o tamanho
        const nf = String(req.notaFiscal).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
        campos.nota_fiscal = nf || null;
      }
      if (req.dataPagoPlug !== undefined) {
        const d = String(req.dataPagoPlug || "").trim();
        if (d) {
          const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + "T12:00:00Z")) && new Date(d + "T12:00:00Z").toISOString().slice(0, 10) === d;
          if (!ok) return json(400, { error: "Data inválida." });
        }
        campos.data_pago_plug = d || null;
      }
      if (req.nomeCliente !== undefined) {
        const nome = String(req.nomeCliente).replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
        if (nome.length < 3) return json(400, { error: "Informe o nome completo do cliente (mínimo 3 letras)." });
        campos.nome_cliente = nome;
        campos.nome_manual_em = new Date().toISOString(); // correção feita por uma pessoa: a rotina automática passa a respeitá-la
      }
      if (req.observacoes !== undefined) {
        const ob = String(req.observacoes).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
        campos.observacoes = ob || null;
      }
      if (!Object.keys(campos).length) return json(400, { error: "Nada para alterar." });
      const t = await db.atualizarSe(req.id, "", { ...campos, editado_por: usuario.email, editado_em: new Date().toISOString() });
      if (!t) return json(404, { error: "Transação não encontrada." });
      return json(200, { ok: true });
    }

    case "usuarios": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      return json(200, { usuarios: await db.listarUsuarios() });
    }

    case "transacoes": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      return json(200, { transacoes: await db.listarTransacoes({ status: req.status, busca: req.busca, usuario: req.usuario, nf: req.nf, plug: req.plug, de: req.de, ate: req.ate, limite: req.limite }) });
    }

    case "transacao-qr": {
      if (!db.enabled()) return json(503, { error: "Supabase não configurado" });
      const [t] = await db.buscarTransacao(req.id);
      if (!t) return json(404, { error: "Transação não encontrada" });
      return json(200, {
        metodo: t.metodo, referencia: t.referencia, serial_number: t.serial_number, status: t.status,
        valor_brl: t.valor_brl, moeda: t.moeda, valor: t.valor,
        qrCodeCopiaCola: t.qr_copia_cola, qrImagem: t.qr_imagem,
      });
    }

    // Diagnóstico: testa a consulta de status com cada identificador possível e mostra o que a PlugPay responde
    case "diagnostico-status": {
      const candidatos = [
        ["referenciaInterna", req.referenciaInterna],
        ["idTransacao", req.idTransacao],
        ["qrCodeId", req.qrCodeId],
      ].filter(([, v]) => v !== undefined && v !== null && v !== "");
      const resultados = [];
      for (const [nome, valor] of candidatos) {
        try {
          const r = await call("/v1/partners/transactionPix/status/" + encodeURIComponent(valor), { timeoutMs: 3000 });
          resultados.push({ identificador: nome, valor, http: r.status, ok: r.ok, statusCodigo: r.ok ? lerStatus(r.data) : null, resposta: r.data });
        } catch (e) {
          resultados.push({ identificador: nome, valor, erro: String(e.message || e) });
        }
      }
      return json(200, { resultados });
    }

    case "status-pix": {
      const r = await call("/v1/partners/transactionPix/status/" + encodeURIComponent(req.referenciaInterna));
      if (r.ok) await sincronizarStatus(req.referenciaInterna, r.data);
      return respostaStatus(r, req.referenciaInterna);
    }

    case "create-qr-py": {
      const value = Number(req.value);
      if (!Number.isInteger(value) || value <= 0) {
        return json(400, { error: "QR Paraguay exige valor inteiro positivo em guaranis" });
      }
      if (!merchant) return json(400, { error: "documentMerchant não informado" });
      const r = await call("/v1/partners/qr-paraguay/create", {
        method: "POST",
        body: { documentMerchant: merchant, originCurrencie: "PYG", value },
      });
      if (r.ok) {
        await guardarCobranca("QR_PARAGUAY", {
          moeda: "PYG", valor: value, documentMerchant: merchant, referenciaExterna: req.referenciaExterna,
        }, r.data);
      }
      return json(r.ok ? 200 : r.status, r.data);
    }

    case "status-qr-py": {
      const r = await call("/v1/partners/qr-paraguay/status/" + encodeURIComponent(req.serialNumber));
      if (r.ok) await sincronizarStatus(req.serialNumber, r.data);
      return respostaStatus(r, req.serialNumber);
    }

    default:
      return json(400, { error: "Ação desconhecida" });
  }
}

exports.processarTentativa = (...a) => processarTentativa(...a);
exports.processarTentativaAgendada = (...a) => processarTentativaAgendada(...a);
exports.varrerTentativas = (...a) => varrerTentativas(...a);
exports.segredoInterno = () => segredoInterno();

exports.handler = async (event) => {
  ctx = { id: crypto.randomBytes(4).toString("hex"), acao: null, usuario: null, logs: [] };
  const t0 = Date.now();
  let resp;
  try {
    resp = await tratar(event);
  } catch (e) {
    resp = respostaDeErro(e);
  }

  // Resumo da requisição inteira (o que a tela pediu e o que devolvemos)
  if (ctx.acao && ctx.usuario && !["logs", "transacoes", "transacao-qr", "config", "link-info", "link-listar", "usuarios", "tentativa-status"].includes(ctx.acao)) {
    let corpo; try { corpo = JSON.parse(resp.body); } catch { corpo = null; }
    let pedido; try { pedido = JSON.parse(event.body || "{}"); } catch { pedido = null; }
    addLog({
      endpoint: "(tela → function)", rota: (event.httpMethod || "POST") + " " + (event.path || "/.netlify/functions/plugpay"),
      metodo: "POST", status_http: resp.statusCode, resposta_bruta: mascararBruto(resp.body),
      ok: resp.statusCode < 400, duracao_ms: Date.now() - t0,
      request: sanitizar(pedido && { ...pedido, _usuario: ctx.usuario }), response: sanitizar(corpo),
      erro: resp.statusCode < 400 ? null : String((corpo && (corpo.error || corpo.message)) || "").slice(0, 300),
    });
    if (db.enabled()) {
      try { await db.inserirLogs(ctx.logs); } catch (e) { console.error("Falha ao gravar log:", e.message); }
    }
    // Cópia para a API Joel Pires (não derruba nada se falhar)
    try { await mensagens.enviarRegistros(ctx.logs, ctx.usuario); } catch (e) { console.error("Falha ao enviar registros:", e.message); }
  }

  resp.headers["x-request-id"] = ctx.id;
  return resp;
};
