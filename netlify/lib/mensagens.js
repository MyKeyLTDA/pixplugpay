// Envia cada registro de log também para a API Joel Pires (POST /mensagens, tipo "registro").
// Falha aqui (404, fora do ar, lento) NUNCA afeta a cobrança: só vai para o console do Netlify.
//
// Variáveis (todas opcionais):
//   MENSAGENS_URL        padrão https://api.joelpires.com.br/mensagens
//   MENSAGENS_TOKEN      se a API exigir, vai em "Authorization: Bearer <token>"
//   MENSAGENS_DESLIGADO  "1" desliga o envio

const ORIGEM = "programa de cobranças MyKey";
const TIMEOUT_MS = 2500;

const url = () => process.env.MENSAGENS_URL || "https://api.joelpires.com.br/mensagens";

function corpo(linha, usuario) {
  return {
    tipo: "registro",
    origem: ORIGEM,
    criado_em: new Date().toISOString(),
    usuario: usuario || null,
    request_id: linha.request_id,
    ambiente: linha.ambiente,
    acao: linha.acao,
    rota: linha.rota || linha.endpoint,
    metodo: linha.metodo,
    status_http: linha.status_http ?? null,
    ok: linha.ok,
    duracao_ms: linha.duracao_ms,
    erro: linha.erro || null,
    request: linha.request ?? null,
    response: linha.response ?? null,
    resposta_bruta: linha.resposta_bruta ?? null,
  };
}

async function enviarRegistros(linhas, usuario) {
  if (process.env.MENSAGENS_DESLIGADO === "1" || !linhas || !linhas.length) return;
  const headers = { "Content-Type": "application/json" };
  if (process.env.MENSAGENS_TOKEN) headers.Authorization = "Bearer " + process.env.MENSAGENS_TOKEN;
  const resultados = await Promise.allSettled(linhas.map(async (l) => {
    const r = await fetch(url(), { method: "POST", headers, body: JSON.stringify(corpo(l, usuario)), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) {
      let corpo = ""; try { corpo = (await r.text()).slice(0, 200); } catch {}
      throw new Error("HTTP " + r.status + (corpo ? " — " + corpo : ""));
    }
  }));
  const falhas = resultados.filter((r) => r.status === "rejected");
  if (falhas.length) console.error("API de mensagens indisponível (" + falhas.length + "/" + linhas.length + " registros não enviados): " + falhas[0].reason.message);
}

module.exports = { enviarRegistros, corpo, ORIGEM };
