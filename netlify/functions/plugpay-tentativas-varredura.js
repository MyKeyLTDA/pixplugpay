// Rede de segurança (a cada minuto): executa tentativas de gerar Pix que ficaram paradas
// (função em segundo plano que não chegou a rodar, ou chamada que morreu no meio).
const db = require("../lib/supabase");

exports.handler = async () => {
  if (!db.enabled()) return { statusCode: 503, body: "Supabase não configurado" };
  const { varrerTentativas } = require("./plugpay");
  try {
    const feitas = await varrerTentativas();
    return { statusCode: 200, body: JSON.stringify({ feitas }) };
  } catch (e) {
    console.error("varredura de tentativas:", e.message);
    return { statusCode: 500, body: "erro" };
  }
};
