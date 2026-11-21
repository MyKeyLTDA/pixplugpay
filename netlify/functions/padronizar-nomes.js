// Função agendada (ver netlify.toml): padroniza os nomes por CPF automaticamente.
// É segura de repetir: se nada mudou desde a última vez, não grava nada.
const { executar } = require("../lib/padronizar");
const db = require("../lib/supabase");

let ultima = 0; // evita execuções coladas se alguém abrir o endereço da função

exports.handler = async () => {
  if (!db.enabled()) return { statusCode: 503, body: "Supabase não configurado" };
  if (Date.now() - ultima < 60 * 1000) return { statusCode: 200, body: JSON.stringify({ ignorado: "executou há menos de 1 minuto" }) };
  ultima = Date.now();
  try {
    const { resumo } = await executar();
    console.log("padronizar-nomes:", JSON.stringify(resumo));
    return { statusCode: 200, body: JSON.stringify(resumo) };
  } catch (e) {
    console.error("padronizar-nomes falhou:", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
