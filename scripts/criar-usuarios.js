// Cria (ou atualiza a senha de) usuários no Supabase Auth, já confirmados.
// Uso (a senha vem de variável, não fica gravada em arquivo):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=sb_secret_... SENHA='...' \
//   node scripts/criar-usuarios.js usuario1@exemplo.com.br usuario2@exemplo.com.br ...
const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_KEY;
const senha = process.env.SENHA;
const emails = process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean);
if (!url || !key || !senha || !emails.length) {
  console.error("Faltam SUPABASE_URL, SUPABASE_SERVICE_KEY, SENHA ou e-mails. Veja o cabeçalho do arquivo.");
  process.exit(1);
}
const H = { apikey: key, "Content-Type": "application/json", ...(key.startsWith("sb_") ? {} : { Authorization: "Bearer " + key }) };

(async () => {
  const existentes = new Map();
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (!r.ok) { console.error("Falha ao listar usuários:", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
    const us = (await r.json()).users || [];
    us.forEach((u) => u.email && existentes.set(u.email.toLowerCase(), u.id));
    if (us.length < 200) break;
  }
  for (const email of emails) {
    const id = existentes.get(email);
    const r = await fetch(`${url}/auth/v1/admin/users${id ? "/" + id : ""}`, {
      method: id ? "PUT" : "POST", headers: H,
      body: JSON.stringify({ email, password: senha, email_confirm: true }),
    });
    console.log((r.ok ? (id ? "senha atualizada " : "criado ") : "FALHOU (" + r.status + ") ") + email +
      (r.ok ? "" : " " + (await r.text()).slice(0, 200)));
  }
})();
