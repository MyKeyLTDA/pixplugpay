// Padronização de nomes por CPF (sem IA, só regras): mesmo CPF = mesmo nome de pessoa física.
// Para cada CPF escolhe UM nome completo e troca os demais por ele. Funciona assim:
//   1. limpa cada nome digitado: tira números/CNPJ, pontuação, espaços repetidos e ajusta maiúsculas;
//   2. "Thiago Silva" é considerado parte de "Thiago Ribeiro Silva" (todas as palavras estão nele);
//   3. escolhe, nesta ordem: nome que não parece de empresa (LTDA, ME, EIRELI...) -> o que "cobre" mais
//      cobranças do CPF -> o mais completo -> o mais recente;
//   4. uma correção feita à mão por uma pessoa (nome_manual_em) vence qualquer regra.
// Sempre aplica: não existe "conferir à mão" (se alguém discordar, corrige na tabela e a correção vale).
const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e", "di", "du", "del", "van", "von"]);

const semAcento = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");

// Remove tokens com número (CNPJ/CPF/códigos), pontuação e símbolos; mantém letras, acentos, apóstrofo e hífen
function limpar(nome) {
  const t = String(nome || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[^\p{L}\p{N}'’\- ]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/u.test(w) && /\p{L}/u.test(w) && w !== "-");
  return t;
}

function capitalizar(palavras) {
  return palavras.map((w, i) => {
    const baixo = w.toLowerCase();
    if (i > 0 && PARTICULAS.has(semAcento(baixo))) return baixo;
    if (w.length <= 3 && w === w.toUpperCase() && !PARTICULAS.has(semAcento(baixo))) return w; // "TI", "JR"
    return baixo.replace(/(^|[-'’])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  }).join(" ");
}

// palavras que contam para comparar (sem acento, minúsculas, sem partículas)
const chave = (palavras) => palavras.map((w) => semAcento(w).toLowerCase()).filter((w) => !PARTICULAS.has(w));
const contido = (a, b) => a.length > 0 && a.every((w) => b.includes(w));
// Marcas de nome de empresa: CPF é pessoa física, então estes nomes só valem se não houver outro
const EMPRESA = new Set(["ltda", "me", "mei", "epp", "eireli", "sa", "s", "cia", "comercio", "comercial", "servicos", "servico", "ltda-me", "chaveiro", "chaveiros", "auto", "autos", "center", "automotivo", "automotiva", "eletronica", "eletronicos", "distribuidora", "industria", "empresa"]);
const pareceEmpresa = (k) => k.some((w) => EMPRESA.has(w));
const acentos = (s) => (String(s).match(/[^\u0000-\u007f]/g) || []).length;

// linhas: [{ id, nome_cliente, criado_em, ... }] do MESMO cpf -> { nome, alteracoes[] } ou null
function padronizarGrupo(linhas) {
  // Correção feita por uma pessoa (nome_manual_em) vence qualquer regra: a mais recente vira o nome do CPF
  // e é espalhada para as demais cobranças do mesmo CPF.
  const manuais = linhas.filter((l) => l.nome_manual_em && String(l.nome_cliente || "").trim().length >= 3)
    .sort((a, b) => String(b.nome_manual_em).localeCompare(String(a.nome_manual_em)));
  if (manuais.length) {
    const nome = String(manuais[0].nome_cliente).trim();
    return {
      nome, origem: "manual", apoio: manuais.length, total: linhas.length,
      alteracoes: linhas.filter((l) => (l.nome_cliente || "") !== nome).map((l) => ({ id: l.id, de: l.nome_cliente || "", para: nome })),
    };
  }
  const itens = linhas.map((l) => {
    const palavras = limpar(l.nome_cliente);
    return { l, palavras, k: chave(palavras) };
  });
  const validos = itens.filter((i) => i.k.length > 0);
  if (!validos.length) return null;

  // candidatos: um por nome distinto (pela chave); entre variantes do mesmo nome, a mais acentuada e mais recente
  const porChave = new Map();
  for (const i of validos) {
    const id = i.k.join(" ");
    const atual = porChave.get(id);
    const melhor = !atual || acentos(i.palavras.join(" ")) > acentos(atual.palavras.join(" ")) ||
      (acentos(i.palavras.join(" ")) === acentos(atual.palavras.join(" ")) && String(i.l.criado_em) > String(atual.l.criado_em));
    if (melhor) porChave.set(id, i);
  }
  let candidatos = [...porChave.values()].map((c) => ({
    c, apoio: validos.filter((i) => contido(i.k, c.k)).length, tokens: c.k.length, empresa: pareceEmpresa(c.k),
  }));
  const comNomeCompleto = candidatos.filter((x) => x.tokens >= 2);
  if (comNomeCompleto.length) candidatos = comNomeCompleto;
  candidatos.sort((a, b) => (a.empresa - b.empresa) || b.apoio - a.apoio || b.tokens - a.tokens || String(b.c.l.criado_em).localeCompare(String(a.c.l.criado_em)));
  const escolhido = candidatos[0];
  const nome = capitalizar(escolhido.c.palavras);
  if (nome.length < 3) return null;

  const total = itens.length;
  const alteracoes = linhas
    .filter((l) => (l.nome_cliente || "") !== nome)
    .map((l) => ({ id: l.id, de: l.nome_cliente || "", para: nome }));
  return { nome, apoio: escolhido.apoio, total, alteracoes };
}

// todas as transações (com cpf) -> lista de grupos com pelo menos uma alteração
function propor(transacoes) {
  const porCpf = new Map();
  for (const t of transacoes) {
    const cpf = String(t.cpf_cliente || "").replace(/\D/g, "");
    if (cpf.length !== 11) continue;
    if (!porCpf.has(cpf)) porCpf.set(cpf, []);
    porCpf.get(cpf).push(t);
  }
  const grupos = [];
  for (const [cpf, linhas] of porCpf) {
    const g = padronizarGrupo(linhas);
    if (g && g.alteracoes.length) grupos.push({ cpf, ...g });
  }
  grupos.sort((a, b) => b.alteracoes.length - a.alteracoes.length);
  return grupos;
}

module.exports = { propor, padronizarGrupo, limpar, capitalizar };
