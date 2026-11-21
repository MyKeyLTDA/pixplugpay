// Registro de chamadas: Netlify (console) + Supabase (tabela plugpay_api_log).
// Nunca grava senha, token, chave de acesso nem CPF completo.

const SEGREDOS = /password|senha|token|authorization|client_id|x-access-key|secret/i;
const DOCS = /(cpf|cnpj)$/i; // só campos que TERMINAM em cpf/cnpj (customerCPF), não customerCPF_digitos
const IMAGENS = /image|qrcodestringimage/i;

function mascararDoc(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return v;
  return "*".repeat(Math.max(d.length - 2, 0)) + d.slice(-2) + ` (${d.length} dígitos)`;
}

function sanitizar(x, chave = "", prof = 0) {
  if (prof > 6) return "[profundo demais]";
  if (SEGREDOS.test(chave)) return "***";
  if (DOCS.test(chave) && typeof x !== "object") return mascararDoc(x);
  if (IMAGENS.test(chave) && typeof x === "string" && x.length > 200) return "[imagem omitida]";
  if (Array.isArray(x)) return x.slice(0, 20).map((i) => sanitizar(i, chave, prof + 1));
  if (x && typeof x === "object") {
    const o = {};
    for (const k of Object.keys(x)) o[k] = sanitizar(x[k], k, prof + 1);
    return o;
  }
  if (typeof x === "string" && x.length > 1500) return x.slice(0, 1500) + "…";
  return x;
}

// Resposta bruta: o texto exatamente como veio, só com tokens/senhas mascarados e cortado em 8000 caracteres.
const SEGREDO_NO_TEXTO = /("(?:access_?token|refresh_?token|token|password|pass|senha|authorization|secret|client_?id)"\s*:\s*")[^"]*(")/gi;
function mascararBruto(texto, limite = 8000) {
  if (texto === null || texto === undefined) return null;
  const t = String(texto).replace(SEGREDO_NO_TEXTO, "$1***$2");
  return t.length > limite ? t.slice(0, limite) + "… [cortado, " + t.length + " caracteres]" : t;
}

module.exports = { sanitizar, mascararBruto };
