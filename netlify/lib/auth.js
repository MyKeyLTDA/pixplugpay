// Verifica o login do usuário (Supabase Auth). O navegador manda o access_token no cabeçalho
// Authorization; aqui perguntamos ao Supabase se ele é válido e de quem é.

const cache = new Map(); // token -> { email, ate }
const TTL_MS = 60 * 1000;

const url = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
// A chave pública basta para validar um token de usuário; a de serviço serve de reserva.
const chave = () => process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY || "";

const permitidos = () =>
  (process.env.AUTH_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Devolve { email, id } se o token for válido (e o e-mail estiver na lista, quando houver); senão null.
async function verificar(authorization) {
  const m = /^Bearer\s+(.+)$/i.exec(authorization || "");
  if (!m || !url() || !chave()) return null;
  const token = m[1].trim();

  const hit = cache.get(token);
  if (hit && hit.ate > Date.now()) return hit.user;

  let r;
  try {
    r = await fetch(url() + "/auth/v1/user", {
      headers: { apikey: chave(), Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(5000),
    });
  } catch { return null; }
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  if (!u || !u.id || !u.email) return null;

  const email = String(u.email).toLowerCase();
  const lista = permitidos();
  if (lista.length && !lista.includes(email)) return null;

  const user = { id: u.id, email };
  if (cache.size > 200) cache.clear();
  cache.set(token, { user, ate: Date.now() + TTL_MS });
  return user;
}

// Dados públicos que o navegador precisa para fazer login (a chave aqui é a pública/publishable)
const configPublica = () => ({ supabaseUrl: url(), supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "" });

module.exports = { verificar, configPublica };
