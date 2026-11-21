// Rotina automática: deixa o mesmo nome completo em todas as cobranças do mesmo CPF.
// Chamada de tempos em tempos pela função agendada (netlify/functions/padronizar-nomes.js).
// Mesmo CPF = mesmo nome (ver nomes.js): aplica sempre, sem etapa de conferência.
const db = require("./supabase");
const nomes = require("./nomes");

const USUARIO = "rotina automática";

async function executar({ orcamentoMs = 20000, maxAlteracoes = 500 } = {}) {
  const t0 = Date.now();
  const linhas = await db.listarParaPadronizar();
  const porId = new Map(linhas.map((l) => [l.id, l]));
  const grupos = nomes.propor(linhas);
  const pendentes = grupos.flatMap((g) => g.alteracoes.map((a) => ({ ...a, cpf: g.cpf, origem: g.origem || "regra" })));

  const feitas = [];
  let falhas = 0;
  for (const a of pendentes.slice(0, maxAlteracoes)) {
    if (Date.now() - t0 > orcamentoMs) break; // continua na próxima execução
    const antes = porId.get(a.id) || {};
    const campos = { nome_cliente: a.para, editado_por: USUARIO, editado_em: new Date().toISOString() };
    if (!antes.nome_informado) campos.nome_informado = a.de || null; // guarda o que o cliente digitou
    try {
      const ok = await db.atualizarSe(a.id, "", campos);
      if (ok) feitas.push({ id: a.id, cpf: "*********" + String(a.cpf).slice(-2), de: a.de, para: a.para, origem: a.origem });
    } catch (e) { falhas++; console.error("padronizar-nomes:", a.id, e.message); }
  }

  const resumo = { analisadas: linhas.length, grupos_com_mudanca: grupos.length, aplicadas: feitas.length, restantes: pendentes.length - feitas.length - falhas, falhas, duracao_ms: Date.now() - t0 };
  if (feitas.length || falhas) {
    // registro para auditoria (aparece no painel de logs)
    try {
      await db.inserirLogs([{
        ambiente: db.ambiente(), request_id: "rotina-" + Date.now().toString(36), acao: "rotina-nomes", endpoint: "(rotina agendada)",
        rota: "padronizar-nomes", metodo: "CRON", ok: falhas === 0, duracao_ms: resumo.duracao_ms,
        request: { usuario: USUARIO }, response: { ...resumo, alteracoes: feitas.slice(0, 100) },
        resposta_bruta: JSON.stringify({ ...resumo, alteracoes: feitas.slice(0, 100) }).slice(0, 8000),
        erro: falhas ? falhas + " falha(s)" : null,
      }]);
    } catch (e) { console.error("padronizar-nomes (log):", e.message); }
  }
  return { resumo, alteracoes: feitas };
}

module.exports = { executar, USUARIO };
