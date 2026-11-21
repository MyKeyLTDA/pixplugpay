// Teste local com fetch simulado (não chama PlugPay nem Supabase de verdade).
// Rodar: node tests/test.js
process.env.SUPABASE_URL = "https://x.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
process.env.WEBHOOK_TOKEN = "segredo123";
process.env.PLUGPAY_CLIENT_ID = "1";
process.env.PLUGPAY_PASSWORD = "p";
process.env.PLUGPAY_MERCHANT_DOC = "80000000-1";
process.env.PLUGPAY_BASE_URL = "https://apisandbox.plugpayapi.com";

const calls = [];
let supabaseFail = false;
global.fetch = async (url, opts) => {
  let corpo = null; try { corpo = opts.body ? JSON.parse(opts.body) : null; } catch { corpo = "(binário)"; }
  calls.push({ url, body: corpo });
  const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data });
  if (url.includes("/auth/token")) {
    global.__logins = (global.__logins || 0) + 1;
    if (global.__login429) return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "17" : null) }, text: async () => '{"message":"Too Many Requests"}' };
    await new Promise((r) => setTimeout(r, 30));
    const exp = Math.floor(Date.now() / 1000) + (global.__tokenVida || 3600);
    const jwt = "h." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".s";
    return ok({ token: jwt, refresh_token: "r" });
  }
  if (url.includes("plugpay_token")) { // tabela do token (compartilhada)
    const m = opts.method || "GET", T = (global.__tokTab = global.__tokTab || { row: null });
    if (m === "POST") { T.row = T.row || { ambiente: "sandbox", token: null, expira_em: null, bloqueado_ate: null, lock_ate: null }; return ok({}); }
    if (m === "GET") return ok(T.row ? [T.row] : []);
    const b = JSON.parse(opts.body);
    if (url.includes("lock_ate.is.null")) { // trava condicional
      if (T.row.lock_ate && Date.parse(T.row.lock_ate) > Date.now()) return ok([]);
      Object.assign(T.row, b); return ok([T.row]);
    }
    Object.assign(T.row, b); return ok({});
  }
  const taxa = (m) => (m === "PYG" ? 0.0012 : 5.1);
  if (url.includes("/transactionPix/status/")) {
    const sr = global.__statusResp;
    if (sr) return { ok: sr.ok, status: sr.status, text: async () => JSON.stringify(sr.body) };
    return ok({ status: 1, message: "ok" });
  }
  if (url.includes("/transactionPix/quote")) {
    const b = JSON.parse(opts.body);
    return ok({ message: "Cotización creada con éxito!", valorEmBRL: (b.value * taxa(b.originCurrencie)).toFixed(2) });
  }
  if (url.includes("/transactionPix/create")) {
    const b = JSON.parse(opts.body);
    if (global.__soCampo && !(global.__soCampo in b))
      return { ok: false, status: 400, text: async () => JSON.stringify({ message: "El campo CPF/CNPJ debe tener 11 ó 14 caracteres!" }) };
    if ((b.customerCPFCNPJ || b.customerCPF) === "00000000000")
      return { ok: false, status: 400, text: async () => JSON.stringify({ message: "El campo CPF/CNPJ debe tener 11 ó 14 caracteres!" }) };
    return ok({ IdTransacao: 889, qrCodeId: "00000000-aaaa-bbbb-cccc-000000000889", referenciaInterna: "ref889", qrCodeCopiaCola: "0002...",
      valueBRL: (b.value * taxa(b.originCurrencie)).toFixed(2) });
  }
  if (url.includes("api.joelpires.com.br/mensagens")) {
    global.__mensagens = (global.__mensagens || []).concat(JSON.parse(opts.body));
    if (global.__mensagens404) return { ok: false, status: 404, text: async () => "Not Found", json: async () => ({}) };
    return ok({ ok: true });
  }
  if (url.includes("/auth/v1/user")) {
    const t = (opts.headers || {}).Authorization;
    if (t === "Bearer tokbom") return ok({ id: "u1", email: "usuario1@exemplo.com.br" });
    return { ok: false, status: 401, text: async () => "{}", json: async () => ({}) };
  }
  if (url.includes("supabase.co") && url.includes("plugpay_links")) {
    const m = opts.method || "GET";
    if (m === "POST") { const row = { id: 1, ...JSON.parse(opts.body) }; return ok([row]); }
    if (m === "PATCH") {
      const b = JSON.parse(opts.body);
      if (url.includes("usado_em=is.null") && global.__linkReserva === false) return ok([]); // alguém reservou antes
      return ok([{ ...(global.__linkRow || {}), ...b }]);
    }
    return ok(global.__linkRow ? [global.__linkRow] : []);
  }
  if (global.__padroniza && url.includes("supabase.co") && url.includes("select=id,cpf_cliente,nome_cliente")) return ok(global.__padroniza);
  if (url.includes("supabase.co") && opts.method === "PATCH") return ok(global.__patch || []);
  if (url.includes("supabase.co")) {
    if (supabaseFail) return { ok: false, status: 500, text: async () => "boom" };
    if (opts.method === "GET" && url.includes("select=criado_por")) return ok([{ criado_por: "b@x" }, { criado_por: "a@x" }, { criado_por: "a@x" }]);
    if (opts.method === "GET" && global.__bancoVazio && url.includes("plugpay_transacoes")) return ok([]);
    if (opts.method === "GET" && url.includes("plugpay_transacoes?select=*"))
      return ok([{ id: 7, metodo: "PIX", referencia: "ref889", status: 5, valor_brl: 60, moeda: "PYG", valor: 68966,
        qr_copia_cola: "0002...", qr_imagem: "iVBOR..." }]);
    if (opts.method === "GET" && url.includes("plugpay_transacoes"))
      return ok([{ id: 7, metodo: "PIX", referencia: "ref889", status: 1, valor_brl: 60 }]);
    return ok(opts.method === "GET" ? [{ id: 1, request_id: "abc" }] : {});
  }
  throw new Error("URL inesperada " + url);
};

const assert = require("assert");
const pp = require("../netlify/functions/plugpay").handler;
const wh = require("../netlify/functions/plugpay-webhook").handler;

const H = { authorization: "Bearer tokbom" };

(async () => {
  let r;
  // 0) autenticação: sem login ou com token inválido = 401; config é pública
  r = await pp({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "transacoes" }) });
  assert.strictEqual(r.statusCode, 401);
  r = await pp({ httpMethod: "POST", headers: { authorization: "Bearer falso" }, body: JSON.stringify({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725" }) });
  assert.strictEqual(r.statusCode, 401);
  assert.ok(!calls.some((c) => c.url.includes("/transactionPix/create")), "não pode criar cobrança sem login");
  r = await pp({ httpMethod: "POST", headers: {}, body: JSON.stringify({ action: "config" }) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(JSON.parse(r.body).supabaseKey, "sb_publishable_x");
  assert.ok(!r.body.includes("svc"), "chave secreta nunca na config");
  console.log("ok 0: login obrigatório; config só com chave pública");

  // 0b) editar registro e links de pagamento
  const chama = (b, h = H) => pp({ httpMethod: "POST", headers: h, body: JSON.stringify(b) });
  global.__patch = [{ id: 7 }];
  r = await chama({ action: "editar", id: 7, numeroPedido: "12345", notaFiscal: "NF 998" });
  assert.strictEqual(r.statusCode, 200);
  const pe = calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop();
  assert.strictEqual(pe.body.referencia_externa, "12345");
  assert.strictEqual(pe.body.nota_fiscal, "NF 998");
  assert.strictEqual(pe.body.editado_por, "usuario1@exemplo.com.br");
  assert.strictEqual((await chama({ action: "editar", id: 7, numeroPedido: "12a" })).statusCode, 400, "pedido só número");
  assert.strictEqual((await chama({ action: "editar", id: 7 })).statusCode, 400, "nada para alterar");
  assert.strictEqual((await chama({ action: "editar", id: 7, numeroPedido: "1" }, {})).statusCode, 401, "editar exige login");
  global.__patch = null;
  console.log("ok 0b: editar pedido e nota fiscal");

  // 0b2) observações, filtros por usuário/nota e lista de usuários
  global.__patch = [{ id: 7 }];
  r = await chama({ action: "editar", id: 7, observacoes: "  cliente vai buscar\namanhã  " });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.observacoes, "cliente vai buscar amanhã");
  r = await chama({ action: "editar", id: 7, observacoes: "x".repeat(500) });
  assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.observacoes.length, 200, "observação curta");
  r = await chama({ action: "editar", id: 7, notaFiscal: "" });
  assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.nota_fiscal, null, "vazio vira null");
  global.__patch = null;
  calls.length = 0;
  await chama({ action: "transacoes", usuario: "atendente@exemplo.com.br", nf: "vazias", busca: "1234" });
  let u = decodeURIComponent(calls.find((c) => c.url.includes("plugpay_transacoes?select")).url);
  assert.ok(u.includes("criado_por=eq.atendente@exemplo.com.br") && u.includes("nota_fiscal=is.null"), u);
  assert.ok(u.includes("nota_fiscal.ilike.") && u.includes("nome_cliente.ilike."), "busca por nome e nota");
  calls.length = 0;
  await chama({ action: "transacoes", usuario: "x&status=eq.1", nf: "preenchidas" });
  u = decodeURIComponent(calls.find((c) => c.url.includes("plugpay_transacoes?select")).url);
  assert.ok(!u.includes("criado_por=") && u.includes("nota_fiscal=not.is.null"), "usuário inválido é ignorado: " + u);
  r = await chama({ action: "usuarios" });
  assert.deepStrictEqual(JSON.parse(r.body).usuarios, ["a@x", "b@x"]);
  assert.strictEqual((await chama({ action: "usuarios" }, {})).statusCode, 401);
  console.log("ok 0b2: observações, filtros por usuário e nota, lista de usuários");

  // 0c) link de pagamento: criar (logado) -> cliente abre e gera (sem login) -> segunda geração não duplica
  global.__linkRow = null;
  r = await chama({ action: "link-criar", valorBRL: 80, descricao: "Senha Kia" });
  assert.strictEqual(r.statusCode, 200);
  const tok = JSON.parse(r.body).token;
  assert.ok(/^[A-Za-z0-9_-]{30,}$/.test(tok), "token forte");
  assert.strictEqual((await chama({ action: "link-criar", valorBRL: 80, descricao: "x" })).statusCode, 400, "descrição obrigatória");
  assert.strictEqual((await chama({ action: "link-criar", valorBRL: 80, descricao: "Senha", moedaEnvio: "EUR" })).statusCode, 400);
  assert.strictEqual((await chama({ action: "link-criar", valorBRL: 80, descricao: "Senha" }, {})).statusCode, 401, "criar link exige login");
  global.__linkRow = { id: 1, token: tok, valor_brl: 80, moeda_envio: "PYG", descricao: "Senha Kia", criado_por: "usuario1@exemplo.com.br",
    expira_em: new Date(Date.now() + 3600e3).toISOString(), usado_em: null, id_transacao: null };
  r = await chama({ action: "link-info", token: tok }, {});
  assert.strictEqual(r.statusCode, 200);
  let v = JSON.parse(r.body);
  assert.strictEqual(v.estado, "aguardando"); assert.strictEqual(v.valorBRL, 80);
  assert.ok(!r.body.includes("criado_por") && !r.body.includes("80000000"), "não vaza dados internos");
  assert.strictEqual((await chama({ action: "link-info", token: "curto" }, {})).statusCode, 404);
  assert.strictEqual((await chama({ action: "link-gerar", token: tok, nome: "Ma", cpf: "52998224725" }, {})).statusCode, 400, "nome");
  assert.strictEqual((await chama({ action: "link-gerar", token: tok, nome: "Maria Silva", cpf: "11111111111" }, {})).statusCode, 400, "cpf inválido");
  calls.length = 0;
  r = await chama({ action: "link-gerar", token: tok, nome: "Maria Silva", cpf: "529.982.247-25" }, {});
  assert.strictEqual(r.statusCode, 200, r.body);
  v = JSON.parse(r.body);
  assert.strictEqual(v.estado, "gerada"); assert.strictEqual(v.qrCopiaCola, "0002...");
  // O cliente (sem login) nunca recebe id da transação, qrCodeId, referência, CPF/nome gravados nem criado_por
  assert.deepStrictEqual(Object.keys(v).sort(), ["descricao", "estado", "expirado", "qrCopiaCola", "status", "valorBRL"].sort());
  for (const proibido of ["889", "00000000-aaaa", "ref889", "IdTransacao", "qrCodeId", "referencia", "criado_por", "usuario1", "52998224725"])
    assert.ok(!r.body.includes(proibido), "resposta pública vazou: " + proibido);
  const info = await chama({ action: "link-info", token: tok }, {});
  for (const proibido of ["889", "00000000-aaaa", "ref889", "IdTransacao", "qrCodeId", "referencia", "criado_por", "usuario1", "52998224725"])
    assert.ok(!info.body.includes(proibido), "link-info vazou: " + proibido);
  const regL = calls.find((c) => c.url.includes("rpc/plugpay_registrar")).body.p;
  assert.strictEqual(regL.nome_cliente, "Maria Silva"); assert.strictEqual(regL.cpf_cliente, "52998224725");
  assert.strictEqual(regL.descricao, "Senha Kia"); assert.strictEqual(regL.criado_por, "usuario1@exemplo.com.br");
  assert.ok(calls.some((c) => c.url.includes("plugpay_links") && c.body && c.body.id_transacao === 889), "link guarda a transação");
  // reserva atômica: se o link já foi reservado por outro clique, não cria segundo Pix
  calls.length = 0;
  global.__linkReserva = false;
  r = await chama({ action: "link-gerar", token: tok, nome: "Maria Silva", cpf: "52998224725" }, {});
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!calls.some((c) => c.url.includes("/transactionPix/create")), "segundo clique não gera outro Pix");
  global.__linkReserva = true;
  // expirado
  global.__linkRow.expira_em = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual((await chama({ action: "link-gerar", token: tok, nome: "Maria Silva", cpf: "52998224725" }, {})).statusCode, 410);
  global.__linkRow = null;
  console.log("ok 0c: link de pagamento (criar, abrir, gerar uma vez, expirar)");

  // 1) criar Pix grava pendente no banco
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", originCurrencie: "USD", value: 10, customerCPF: "529.982.247-25", referenciaExterna: "pedido 1", nomeCliente: "Maria Silva" }) });
  assert.strictEqual(r.statusCode, 200);
  const reg = calls.find((c) => c.url.includes("rpc/plugpay_registrar"));
  assert.ok(reg, "não gravou no banco");
  assert.strictEqual(reg.body.p.status, 5);
  assert.strictEqual(reg.body.p.id_transacao, 889);
  assert.strictEqual(reg.body.p.referencia_externa, "pedido 1");
  assert.strictEqual(reg.body.p.cpf_cliente, "52998224725");
  assert.strictEqual(reg.body.p.nome_cliente, "Maria Silva");
  assert.strictEqual(reg.body.p.criado_por, "usuario1@exemplo.com.br");
  assert.strictEqual(reg.body.p.qr_code_id, "00000000-aaaa-bbbb-cccc-000000000889");
  console.log("ok 1: criar Pix grava pendente (e o qrCodeId)");

  // 1b) valor em reais: converte via quote e cria o Pix já na moeda aceita
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 61.37, moedaEnvio: "PYG", customerCPF: "52998224725" }) });
  assert.strictEqual(r.statusCode, 200);
  const resp = JSON.parse(r.body);
  const cr = calls.find((c) => c.url.includes("/transactionPix/create")).body;
  assert.strictEqual(cr.originCurrencie, "PYG");
  assert.ok(Number.isInteger(cr.value), "PYG deve ser inteiro");
  assert.ok(Math.abs(Number(resp.valueBRL) - 61.37) < 0.005, "valueBRL=" + resp.valueBRL);
  assert.ok(calls.filter((c) => c.url.includes("/quote")).length >= 2);
  console.log("ok 1b: R$ 61,37 -> PYG " + cr.value + " -> R$ " + resp.valueBRL);

  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 100, moedaEnvio: "USD", customerCPF: "52998224725" }) });
  const cu = calls.find((c) => c.url.includes("/transactionPix/create")).body;
  assert.strictEqual(cu.originCurrencie, "USD");
  assert.ok(Math.abs(Number(JSON.parse(r.body).valueBRL) - 100) < 0.05);
  console.log("ok 1c: R$ 100 -> USD " + cu.value);

  // moeda de envio inválida
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 10, moedaEnvio: "ARS", customerCPF: "52998224725" }) });
  assert.strictEqual(r.statusCode, 400);
  console.log("ok 1d: moeda inválida -> 400");

  // 1e) logs: recusa da PlugPay vira log com erro, sem segredos e sem CPF completo
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", originCurrencie: "USD", value: 5, customerCPF: "00000000000" }) });
  assert.strictEqual(r.statusCode, 400);
  assert.ok(r.headers["x-request-id"], "faltou x-request-id");
  assert.ok(JSON.parse(r.body)._enviado, "faltou _enviado");
  const lote = calls.find((c) => c.url.includes("plugpay_api_log"));
  assert.ok(lote, "não gravou log");
  const linhas = lote.body;
  assert.ok(linhas.length >= 2, "esperava create + resumo");
  assert.ok(linhas.every((l) => l.request_id === r.headers["x-request-id"]));
  const falha = linhas.find((l) => l.endpoint.includes("/transactionPix/create"));
  assert.strictEqual(falha.ok, false);
  assert.strictEqual(falha.status_http, 400);
  assert.ok(falha.erro.includes("CPF/CNPJ"));
  const txt = JSON.stringify(linhas);
  assert.ok(txt.includes('"customerCPF_caracteres":11'), "tamanho do CPF deveria aparecer sem máscara");
  assert.ok(!txt.includes("00000000000"), "CPF completo vazou no log");
  assert.ok(!txt.includes('"tok"') && !txt.includes('"password":"p"'), "token/senha vazou no log");
  console.log("ok 1e: log da recusa, com request_id, sem segredos nem CPF completo");

  // 1e2) CPF formatado e documento do merchant sobrescrito (diagnóstico)
  calls.length = 0;
  await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", originCurrencie: "USD", value: 5, customerCPF: "52998224725",
    cpfFormatado: true, documentMerchant: "9502983-4" }) });
  const dc = calls.find((c) => c.url.includes("/transactionPix/create")).body;
  assert.strictEqual(dc.customerCPFCNPJ, "529.982.247-25");
  assert.strictEqual(dc.customerCPF, undefined, "campo antigo não deve ser enviado");
  assert.strictEqual(dc.documentMerchant, "9502983-4");
  console.log("ok 1e2: CPF formatado e merchant sobrescrito chegam à PlugPay");

  // 1f) ação logs devolve os registros
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "logs" }) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(JSON.parse(r.body).logs[0].request_id, "abc");
  console.log("ok 1f: ação logs lista registros");

  // 1g) a cobrança criada guarda o QR (copia e cola + imagem) para reabrir depois
  calls.length = 0;
  await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", originCurrencie: "USD", value: 10, customerCPF: "52998224725" }) });
  const salvo = calls.find((c) => c.url.includes("rpc/plugpay_registrar")).body.p;
  assert.strictEqual(salvo.qr_copia_cola, "0002...");
  console.log("ok 1g: QR guardado junto com a transação");

  // 1h) listar transações com filtros (status + busca) no ambiente atual
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "transacoes", status: 5, busca: "pedido (1),x*" }) });
  assert.strictEqual(r.statusCode, 200);
  const q = calls.find((c) => c.url.includes("plugpay_transacoes?select=")).url;
  assert.ok(q.includes("ambiente=eq.sandbox") && q.includes("status=eq.5"), q);
  assert.ok(!decodeURIComponent(q.split("&or=")[1]).includes("(1)"), "busca não foi higienizada");
  console.log("ok 1h: listagem filtrada por ambiente, status e busca higienizada");

  // 1i) reabrir QR de uma transação
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "transacao-qr", id: 7 }) });
  assert.strictEqual(JSON.parse(r.body).qrCodeCopiaCola, "0002...");
  console.log("ok 1i: transacao-qr devolve o copia e cola");

  // 1j) consultar status atualiza o banco
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  const up = calls.find((c) => c.url.includes("rpc/plugpay_atualizar_status"));
  assert.ok(up, "não atualizou status no banco");
  assert.strictEqual(up.body.p_status, 1);
  assert.strictEqual(up.body.p_ref, "ref889");
  console.log("ok 1j: consulta de status atualiza o banco");

  // 2) webhook sem token -> 401
  const payload = { IdTransacao: 889, referenciaInterna: "ref889", paymentMethod: "PIX", status: 1,
    statusDescription: "APROBADO", value: 10, valueBRL: 51, currency: "USD", paidAt: "2026-08-20T13:34:21.244Z" };
  r = await wh({ httpMethod: "POST", headers: H, body: JSON.stringify(payload) });
  assert.strictEqual(r.statusCode, 401);
  console.log("ok 2: sem token -> 401");

  // 3) token errado -> 401
  r = await wh({ httpMethod: "POST", headers: { authorization: "Bearer errado" }, body: JSON.stringify(payload) });
  assert.strictEqual(r.statusCode, 401);
  console.log("ok 3: token errado -> 401");

  // 4) token certo -> 200 e grava transação + log
  calls.length = 0;
  r = await wh({ httpMethod: "POST", headers: { authorization: "Bearer segredo123" }, body: JSON.stringify(payload) });
  assert.strictEqual(r.statusCode, 200);
  const rg = calls.find((c) => c.url.includes("rpc/plugpay_registrar"));
  assert.strictEqual(rg.body.p.status, 1);
  assert.strictEqual(rg.body.p.valor_brl, 51);
  const lg = calls.find((c) => c.url.includes("plugpay_webhook_log"));
  assert.strictEqual(lg.body.processado, true);
  console.log("ok 4: token certo grava transação e log");

  // 5) falha de banco -> 500 (PlugPay reenvia) e log com erro
  supabaseFail = true; calls.length = 0;
  r = await wh({ httpMethod: "POST", headers: { authorization: "segredo123" }, body: JSON.stringify(payload) });
  assert.strictEqual(r.statusCode, 500);
  console.log("ok 5: falha de banco -> 500");
  supabaseFail = false;

  // 6) payload sem IdTransacao -> 200, só guarda log
  calls.length = 0;
  r = await wh({ httpMethod: "POST", headers: { authorization: "segredo123" }, body: JSON.stringify({ foo: 1 }) });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!calls.some((c) => c.url.includes("rpc/plugpay_registrar")));
  console.log("ok 6: sem IdTransacao não grava transação");

  // 7) sem WEBHOOK_TOKEN configurado -> nunca aceita
  delete process.env.WEBHOOK_TOKEN;
  r = await wh({ httpMethod: "POST", headers: { authorization: "" }, body: JSON.stringify(payload) });
  assert.strictEqual(r.statusCode, 401);
  console.log("ok 7: sem token configurado recusa tudo");

  console.log("\nTodos os testes passaram.");

  // 8) Tela manda customerCPFCNPJ (em vez de customerCPF): a function aceita
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 20, moedaEnvio: "PYG", customerCPFCNPJ: "52998224725" }) });
  assert.strictEqual(r.statusCode, 200);
  console.log("ok 8: tela com customerCPFCNPJ aceita");

  // 9) Produção exige customerCPF: a function tenta o outro nome e memoriza
  global.__soCampo = "customerCPF";
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 20, moedaEnvio: "PYG", customerCPF: "52998224725" }) });
  assert.strictEqual(r.statusCode, 200);
  const tent = calls.filter((c) => c.url.includes("/transactionPix/create")).map((c) => Object.keys(c.body).find((k) => k.startsWith("customerCPF")));
  assert.deepStrictEqual(tent, ["customerCPFCNPJ", "customerCPF"]);
  calls.length = 0;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({
    action: "create-pix", valorBRL: 20, moedaEnvio: "PYG", customerCPF: "52998224725" }) });
  assert.strictEqual(calls.filter((c) => c.url.includes("/transactionPix/create")).length, 1, "memorizou o campo");
  global.__soCampo = null;
  console.log("ok 9: fallback de campo do CPF + memorização");

  // 10) Status em texto e 404 de status
  global.__statusResp = { ok: true, status: 200, body: { status: "APROBADO", IdStatus: "1" } };
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  assert.strictEqual(JSON.parse(r.body).statusCodigo, 1);
  global.__statusResp = { ok: false, status: 404, body: { message: "no encontrado" } };
  global.__bancoVazio = true;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(JSON.parse(r.body).statusCodigo, 5);
  global.__bancoVazio = false;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  const sb = JSON.parse(r.body); assert.strictEqual(sb.statusCodigo, 1); assert.strictEqual(sb.origem, "banco");
  global.__statusResp = null;
  console.log("ok 10: status em texto vira código; 404 usa o status do banco (webhook) ou pendente");

  // 11) Diagnóstico de status: tenta cada identificador e devolve as respostas
  global.__statusResp = { ok: false, status: 404, body: { message: "no encontrado" } };
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "diagnostico-status", referenciaInterna: "r1", idTransacao: 25845, qrCodeId: "q1" }) });
  const dg = JSON.parse(r.body).resultados;
  assert.strictEqual(dg.length, 3); assert.strictEqual(dg[1].valor, 25845); assert.strictEqual(dg[0].http, 404);
  global.__bancoVazio = true;
  r = await pp({ httpMethod: "POST", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "r1" }) });
  assert.strictEqual(JSON.parse(r.body).resposta.message, "no encontrado");
  global.__bancoVazio = false;
  global.__statusResp = null;
  console.log("ok 11: diagnóstico de status e corpo do 404 repassado");

  // 12) logs trazem a rota completa e a resposta bruta (com tokens mascarados)
  calls.length = 0;
  global.__statusResp = { ok: true, status: 200, body: { status: "APROBADO", IdStatus: "1", token: "SEGREDO123" } };
  await pp({ httpMethod: "POST", path: "/.netlify/functions/plugpay", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  global.__statusResp = null;
  const linhasLog = calls.filter((c) => c.url.includes("plugpay_api_log")).flatMap((c) => c.body);
  const pl = linhasLog.find((l) => l.endpoint && l.endpoint.includes("/transactionPix/status/"));
  assert.strictEqual(pl.rota, "GET https://apisandbox.plugpayapi.com/v1/partners/transactionPix/status/ref889");
  assert.ok(pl.resposta_bruta.includes("APROBADO") && !pl.resposta_bruta.includes("SEGREDO123"), pl.resposta_bruta);
  const rs = linhasLog.find((l) => l.endpoint === "(tela → function)");
  assert.strictEqual(rs.rota, "POST /.netlify/functions/plugpay");
  assert.ok(rs.resposta_bruta.includes("statusCodigo"), "resumo guarda o que foi devolvido à tela");
  console.log("ok 12: logs com rota e resposta bruta");

  // 13) cópia dos logs para a API Joel Pires (POST /mensagens), e falha dela não derruba a cobrança
  global.__mensagens = []; global.__mensagens404 = true;
  r = await pp({ httpMethod: "POST", path: "/.netlify/functions/plugpay", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  assert.strictEqual(r.statusCode, 200, "API de mensagens em 404 não afeta a resposta");
  assert.ok(global.__mensagens.length >= 2, "enviou os registros");
  const m = global.__mensagens.find((x) => x.rota && x.rota.startsWith("GET https://apisandbox"));
  assert.strictEqual(m.tipo, "registro");
  assert.strictEqual(m.origem, "programa de cobranças MyKey");
  assert.strictEqual(m.usuario, "usuario1@exemplo.com.br");
  assert.ok(m.request_id && "resposta_bruta" in m && "status_http" in m);
  assert.ok(!JSON.stringify(global.__mensagens).includes("Bearer"), "sem cabeçalhos/segredos no corpo");
  global.__mensagens = []; process.env.MENSAGENS_DESLIGADO = "1";
  await pp({ httpMethod: "POST", path: "/.netlify/functions/plugpay", headers: H, body: JSON.stringify({ action: "status-pix", referenciaInterna: "ref889" }) });
  assert.strictEqual(global.__mensagens.length, 0, "MENSAGENS_DESLIGADO=1 desliga");
  delete process.env.MENSAGENS_DESLIGADO; global.__mensagens404 = false;
  console.log("ok 13: logs também enviados à API Joel Pires");
  // 14) token: pedido uma vez, reaproveitado, renovação única e 429 respeitado
  {
    const tk = require("../netlify/lib/token");
    const login = () => calls.filter((c) => c.url.includes("/auth/token")).length;
    const novo = () => { tk._reset(); global.__tokTab = null; global.__logins = 0; global.__login429 = false; global.__tokenVida = 3600; calls.length = 0; };

    // a) várias operações e consultas de status seguidas = 1 login só
    novo();
    for (let i = 0; i < 3; i++) await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    for (let i = 0; i < 3; i++) await chama({ action: "status-pix", referencia: "ref889", id: 7 });
    assert.strictEqual(login(), 1, "deve haver 1 login, houve " + login());
    // b) outra instância (memória zerada) reaproveita o token do banco
    tk._reset();
    await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    assert.strictEqual(login(), 1, "token do banco deve ser reaproveitado");
    console.log("ok 14a/b: 1 login para várias operações; reaproveitado entre instâncias");

    // c) 10 requisições simultâneas em instância fria = 1 login
    novo();
    await Promise.all(Array.from({ length: 10 }, () => chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" })));
    assert.strictEqual(login(), 1, "renovações simultâneas: " + login());
    console.log("ok 14c: 10 pedidos simultâneos, 1 login");

    // d) duas instâncias simultâneas (memória separada, mesmo banco) = 1 login
    novo();
    const [a, b] = await Promise.all([tk.obter(async () => { global.__logins++; await new Promise((r) => setTimeout(r, 50)); return { token: "T1", expiraEm: Date.now() + 3600e3 }; }),
      (async () => { await new Promise((r) => setTimeout(r, 5)); const outra = { ...tk }; return tk.obter(async () => { global.__logins++; return { token: "T2", expiraEm: Date.now() + 3600e3 }; }); })()]);
    assert.strictEqual(a, b, "mesmo token para todos");
    assert.strictEqual(global.__logins, 1);
    console.log("ok 14d: trava evita login duplicado");

    // e) token com folga (90 s) é reaproveitado; perto do vencimento (<60 s) é renovado
    novo(); global.__tokenVida = 90;
    await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    assert.strictEqual(login(), 1, "com folga não renova: " + login());
    novo(); global.__tokenVida = 30;
    await chama({ action: "status-pix", referencia: "ref889", id: 7 });
    await chama({ action: "status-pix", referencia: "ref889", id: 7 });
    assert.ok(login() >= 2, "vencimento próximo renova: " + login());
    console.log("ok 14e: renova só perto do vencimento");

    // f) 429 no login: devolve 429 + Retry-After (não 502) e não insiste enquanto bloqueado
    novo(); global.__login429 = true;
    r = await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    assert.strictEqual(r.statusCode, 429);
    assert.strictEqual(r.headers["Retry-After"], "17");
    r = await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    assert.strictEqual(r.statusCode, 429);
    assert.strictEqual(login(), 1, "durante o bloqueio não pode tentar de novo: " + login());
    global.__login429 = false;
    console.log("ok 14f: 429 respeitado (Retry-After), sem 502 e sem insistir");

    // g) 429 numa rota de negócio: sobe 429, sem novo login
    novo(); tk._reset();
    const antes = global.fetch;
    global.fetch = async (u, o) => (u.includes("/transactionPix/create")
      ? { ok: false, status: 429, headers: { get: () => "9" }, text: async () => "{}" } : antes(u, o));
    r = await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    global.fetch = antes;
    assert.strictEqual(r.statusCode, 429);
    assert.strictEqual(r.headers["Retry-After"], "9");
    assert.strictEqual(login(), 1);
    console.log("ok 14g: 429 de rota repassado como 429");
  }

  // 15) erro "CPF no está registrado" aparece como veio (não é mascarado pela tentativa com outro campo)
  {
    const antes = global.fetch; global.__n422 = 0;
    global.fetch = async (u, o) => {
      if (u.includes("/transactionPix/create")) { global.__n422++;
        const b = JSON.parse(o.body);
        const msg = "customerCPFCNPJ" in b ? "El CPF o CNPJ que has introducido no está registrado!" : "El campo CPF/CNPJ debe tener 11 ó 14 caracteres!";
        return { ok: false, status: "customerCPFCNPJ" in b ? 422 : 400, text: async () => JSON.stringify({ message: msg }) }; }
      return antes(u, o);
    };
    r = await chama({ action: "create-pix", valorBRL: 10, customerCPF: "52998224725", nomeCliente: "Fulano" });
    global.fetch = antes;
    const e = JSON.parse(r.body);
    assert.ok(/não está registrado/.test(e.message) && /no está registrado/.test(e.message), e.message);
    assert.ok(global.__n422 <= 2, "no máx. uma troca de campo");
    console.log("ok 15: erro real da PlugPay preservado");
  }


  // 17) editar nome do cliente e filtrar por período
  {
    global.__patch = [{ id: 7 }];
    r = await chama({ action: "editar", id: 7, nomeCliente: "  maria   da  SILVA " });
    assert.strictEqual(r.statusCode, 200);
    const pn = calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop();
    assert.strictEqual(pn.body.nome_cliente, "maria da SILVA");
    assert.strictEqual(pn.body.editado_por, "usuario1@exemplo.com.br");
    assert.strictEqual((await chama({ action: "editar", id: 7, nomeCliente: "Jo" })).statusCode, 400, "nome curto");
    calls.length = 0;
    await chama({ action: "transacoes", de: "2026-11-19", ate: "2026-11-20", limite: 50 });
    const lt = calls.find((c) => c.url.includes("plugpay_transacoes?select=")).url;
    assert.ok(lt.includes("criado_em=gte." + encodeURIComponent("2026-11-19T00:00:00-03:00")), lt);
    assert.ok(lt.includes("criado_em=lt." + encodeURIComponent("2026-11-21T00:00:00-03:00")), "até = fim do dia 20");
    calls.length = 0;
    await chama({ action: "transacoes", de: "2026-11-19'; drop", ate: "x" });
    assert.ok(!calls.find((c) => c.url.includes("plugpay_transacoes?select=")).url.includes("criado_em="), "data inválida ignorada");
    console.log("ok 17: nome editável (normalizado, mín. 3 letras) e filtro por período");
  }

  // 18) nota fiscal aceita texto; data_pago_plug (editar + filtro)
  {
    global.__patch = [{ id: 7 }];
    r = await chama({ action: "editar", id: 7, notaFiscal: "Não Efetivado" });
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.nota_fiscal, "Não Efetivado");
    r = await chama({ action: "editar", id: 7, dataPagoPlug: "2026-11-20" });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.data_pago_plug, "2026-11-20");
    for (const ruim of ["2026-02-30", "20/11/2026", "abc", "2026-13-01"])
      assert.strictEqual((await chama({ action: "editar", id: 7, dataPagoPlug: ruim })).statusCode, 400, ruim);
    await chama({ action: "editar", id: 7, dataPagoPlug: "" });
    assert.strictEqual(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.data_pago_plug, null, "vazio limpa a data");
    calls.length = 0; await chama({ action: "transacoes", plug: "sem_data" });
    assert.ok(calls.find((c) => c.url.includes("plugpay_transacoes?select=")).url.includes("data_pago_plug=is.null"));
    calls.length = 0; await chama({ action: "transacoes", plug: "com_data" });
    assert.ok(calls.find((c) => c.url.includes("plugpay_transacoes?select=")).url.includes("data_pago_plug=not.is.null"));
    assert.ok(require("../netlify/lib/supabase").listarTransacoes.toString().length > 0);
    console.log("ok 18: nota fiscal com texto; data_pago_plug validada, limpável e filtrável");
  }

  // 19) padronizar nomes por CPF (exemplo do Thiago) — prévia, aplicação em lote e segurança
  {
    const n = require("../netlify/lib/nomes");
    const mk = (cpf, ns, ini = 1) => ns.map((nome, i) => ({ id: ini + i, cpf_cliente: cpf, nome_cliente: nome, nome_informado: null, criado_em: "2026-11-" + String(10 + i).padStart(2, "0") }));
    const exemplo = mk("11964729637", ["Thiago Ribeiro silva", "Thiago Silva", "Thiago Ribeiro Silva", "Forte TI", "66777123000199 Thiago Ribeiro Silva"]);
    let gs = n.propor(exemplo);
    assert.strictEqual(gs.length, 1);
    assert.strictEqual(gs[0].nome, "Thiago Ribeiro Silva");
    assert.deepStrictEqual(gs[0].alteracoes.map((a) => a.id), [1, 2, 4, 5], "o que já está certo (id 3) não muda");
    assert.ok(gs[0].alteracoes.length && !("confianca" in gs[0]), "sem etapa de conferência");
    // CPF com nomes sem relação: mesmo assim vira UM nome (o de pessoa, não o de empresa)
    gs = n.propor(mk("52998224725", ["Maria Souza", "Forte Ltda"], 10));
    assert.strictEqual(gs[0].nome, "Maria Souza"); assert.deepStrictEqual(gs[0].alteracoes.map((a) => a.id), [11]);
    gs = n.propor(mk("52998224725", ["Maria Souza", "Joao Pedro Lima"], 10)); // sem pista: o mais recente
    assert.strictEqual(gs[0].nome, "Joao Pedro Lima");
    // nomes sem CPF e cobranças de CPFs diferentes não se misturam
    assert.strictEqual(n.propor([{ id: 1, cpf_cliente: null, nome_cliente: "x y" }, ...mk("11111111111", ["Ana Lima"], 20), ...mk("22222222222", ["Bia Dias"], 30)]).length, 0);
    assert.strictEqual(n.capitalizar(n.limpar("JOSE DA SILVA 123")), "Jose da Silva");

    // manual vence: a correção feita por uma pessoa vira o nome do CPF e se espalha
    const manual = mk("11964729637", ["Thiago R. Silva", "THIAGO RIBEIRO", "Forte TI"], 40);
    manual[0].nome_manual_em = "2026-11-20T10:00:00Z"; manual[0].nome_cliente = "Thiago Ribeiro Silva";
    gs = n.propor(manual);
    assert.strictEqual(gs[0].nome, "Thiago Ribeiro Silva"); assert.strictEqual(gs[0].origem, "manual");
    assert.deepStrictEqual(gs[0].alteracoes.map((a) => a.id), [41, 42]);

    // rotina automática (função agendada): grava só "alta", preserva o nome digitado, registra no log, é idempotente
    global.__padroniza = [...exemplo, ...mk("52998224725", ["Maria Souza", "Forte Ltda"], 10)];
    global.__patch = [{ id: 1 }];
    const rotina = require("../netlify/functions/padronizar-nomes").handler;
    calls.length = 0;
    r = await rotina({});
    let d = JSON.parse(r.body);
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(d.aplicadas, 5); assert.strictEqual(d.restantes, 0);
    const gravs = calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.") && c.body);
    assert.strictEqual(gravs.length, 5, "4 do Thiago + 1 da Maria");
    assert.ok(gravs.every((g) => g.body.editado_por === "rotina automática"));
    assert.ok(gravs.filter((g) => !/id=eq\.11\b/.test(g.url)).every((g) => g.body.nome_cliente === "Thiago Ribeiro Silva"));
    assert.ok(gravs.some((g) => /id=eq\.11\b/.test(g.url) && g.body.nome_cliente === "Maria Souza"), "empresa vira o nome da pessoa");
    assert.ok(gravs.every((g) => !("nome_manual_em" in g.body)), "a rotina não se passa por correção manual");
    assert.ok(gravs.some((g) => g.body.nome_informado === "Forte TI"), "guarda o que o cliente digitou");
    assert.ok(calls.some((c) => c.url.includes("plugpay_api_log") && JSON.stringify(c.body).includes("rotina-nomes")), "auditoria no log");
    r = await rotina({}); assert.ok(JSON.parse(r.body).ignorado, "repetição colada é ignorada");
    global.__padroniza = [{ id: 1, cpf_cliente: "11964729637", nome_cliente: "Thiago Ribeiro Silva", criado_em: "2026-11-10" }];
    require("../netlify/lib/padronizar").executar && calls.splice(0);
    const out = await require("../netlify/lib/padronizar").executar();
    assert.strictEqual(out.resumo.aplicadas, 0); assert.ok(!calls.some((c) => c.url.includes("plugpay_transacoes?id=eq.")), "nada a fazer = nada gravado");
    // editar nome à mão marca nome_manual_em
    global.__patch = [{ id: 7 }];
    await chama({ action: "editar", id: 7, nomeCliente: "Fulano de Tal" });
    assert.ok(calls.filter((c) => c.url.includes("plugpay_transacoes?id=eq.7")).pop().body.nome_manual_em, "marca correção manual");
    assert.strictEqual((await chama({ action: "nomes-padronizar" })).statusCode, 400, "não existe mais ação manual");
    global.__padroniza = null; global.__patch = null;
    console.log("ok 19: rotina automática de nomes por CPF (regra, correção manual vence, auditoria, idempotente)");
  }

  // 16) lote de logs com chaves diferentes é igualado (evita PGRST102)
  {
    const antes = global.fetch; let enviado = null;
    global.fetch = async (u, o) => { if (u.includes("plugpay_api_log") && o.method === "POST") enviado = JSON.parse(o.body); return antes(u, o); };
    await require("../netlify/lib/supabase").inserirLogs([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
    global.fetch = antes;
    assert.deepStrictEqual(enviado.map((x) => Object.keys(x).sort().join()), ["a,b,c", "a,b,c"]);
    console.log("ok 16: lote de logs com as mesmas chaves");
  }

})().catch((e) => { console.error("FALHOU:", e.message); process.exit(1); });
