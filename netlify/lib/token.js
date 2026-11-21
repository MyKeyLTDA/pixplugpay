// Token da PlugPay: pedido UMA vez, guardado com o vencimento e reaproveitado por todas as chamadas.
//  - memória da instância (rápido) + tabela plugpay_token no Supabase (compartilhada entre instâncias da function)
//  - renova só perto do vencimento (margem de 60 s)
//  - uma renovação por vez: dentro da instância (promessa única) e entre instâncias (trava no banco)
//  - 429 da PlugPay: guarda o "bloqueado até" e devolve 429 + Retry-After, nunca vira 502
const db = require("./supabase");

const MARGEM_MS = 60 * 1000;          // renova quando faltar menos que isso
const TTL_PADRAO_MS = 10 * 60 * 1000; // se a PlugPay não informar o vencimento
const TRAVA_MS = 15 * 1000;           // tempo máximo que uma instância "segura" a renovação
const ESPERA_MAX_MS = 6000;           // quanto esperar outra instância renovar
const BLOQUEIO_PADRAO_S = 30;         // 429 sem Retry-After

class LimiteError extends Error {
  constructor(retryAfterSeg) {
    super("A PlugPay limitou as requisições (429). Tente novamente em alguns segundos.");
    this.name = "LimiteError";
    this.status = 429;
    this.retryAfter = Math.max(1, Math.ceil(Number(retryAfterSeg) || BLOQUEIO_PADRAO_S));
  }
}

let mem = { token: null, exp: 0, bloqueadoAte: 0 };
let voo = null; // renovação em andamento nesta instância

const agora = () => Date.now();
const valido = (token, exp) => !!token && exp - agora() > MARGEM_MS;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function expDoJwt(t) {
  try {
    const p = JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString());
    return p.exp ? p.exp * 1000 : null;
  } catch { return null; }
}

// Vencimento: campo da resposta (expires_in/expires_at) > "exp" do JWT > TTL padrão
function calcularExpiracao(data, token) {
  const ei = Number(data && (data.expires_in ?? data.expiresIn));
  if (ei > 0) return agora() + ei * 1000;
  const ea = data && (data.expires_at ?? data.expiresAt);
  if (ea) { const t = typeof ea === "number" ? (ea < 1e12 ? ea * 1000 : ea) : Date.parse(ea); if (t > agora()) return t; }
  return expDoJwt(token) || agora() + TTL_PADRAO_MS;
}

const lembrar = (token, exp) => { mem.token = token; mem.exp = exp; return token; };

async function lerLinha() {
  if (!db.enabled()) return null;
  try { return await db.tokenLer(); } catch (e) { console.error("token (ler):", e.message); return null; }
}

// loginFn() -> { token, expiraEm(ms), data }  ; deve lançar LimiteError em 429
async function renovar(loginFn, rejeitado) {
  const linha = await lerLinha();
  if (linha) {
    const exp = linha.expira_em ? Date.parse(linha.expira_em) : 0;
    if (linha.token !== rejeitado && valido(linha.token, exp)) return lembrar(linha.token, exp); // outra instância já renovou
    const bl = linha.bloqueado_ate ? Date.parse(linha.bloqueado_ate) : 0;
    if (bl > agora()) { mem.bloqueadoAte = bl; throw new LimiteError((bl - agora()) / 1000); }
  }
  if (mem.bloqueadoAte > agora()) throw new LimiteError((mem.bloqueadoAte - agora()) / 1000);

  let comTrava = false;
  if (linha !== null || db.enabled()) {
    try { await db.tokenGarantirLinha(); comTrava = await db.tokenTrava(new Date(agora() + TRAVA_MS).toISOString()); }
    catch (e) { console.error("token (trava):", e.message); comTrava = true; } // banco indisponível: segue só com a trava local
  } else comTrava = true;

  if (!comTrava) { // outra instância está renovando: esperar o resultado em vez de pedir outro token
    const limite = agora() + ESPERA_MAX_MS;
    while (agora() < limite) {
      await dormir(400);
      const l = await lerLinha();
      if (!l) break;
      const exp = l.expira_em ? Date.parse(l.expira_em) : 0;
      if (l.token !== rejeitado && valido(l.token, exp)) return lembrar(l.token, exp);
      const bl = l.bloqueado_ate ? Date.parse(l.bloqueado_ate) : 0;
      if (bl > agora()) { mem.bloqueadoAte = bl; throw new LimiteError((bl - agora()) / 1000); }
    }
    const e = new Error("Renovação do token da PlugPay em andamento. Tente novamente em instantes.");
    e.status = 503; e.retryAfter = 2;
    throw e;
  }

  try {
    const r = await loginFn();
    lembrar(r.token, r.expiraEm);
    mem.bloqueadoAte = 0;
    if (db.enabled()) await db.tokenSalvar({ token: r.token, expira_em: new Date(r.expiraEm).toISOString() }).catch((e) => console.error("token (salvar):", e.message));
    return r.token;
  } catch (e) {
    if (e instanceof LimiteError) {
      mem.bloqueadoAte = agora() + e.retryAfter * 1000;
      if (db.enabled()) await db.tokenBloquear(new Date(mem.bloqueadoAte).toISOString()).catch(() => {});
    } else if (db.enabled()) await db.tokenSoltar().catch(() => {});
    throw e;
  }
}

// Devolve um token válido. `rejeitado`: token que a PlugPay recusou (401) — só então se força a renovação.
async function obter(loginFn, { rejeitado = null } = {}) {
  if (rejeitado && mem.token === rejeitado) mem = { ...mem, token: null, exp: 0 };
  if (!rejeitado && valido(mem.token, mem.exp)) return mem.token;
  if (!voo) voo = renovar(loginFn, rejeitado).finally(() => { voo = null; });
  return voo;
}

const _reset = () => { mem = { token: null, exp: 0, bloqueadoAte: 0 }; voo = null; };

module.exports = { obter, calcularExpiracao, LimiteError, _reset };
