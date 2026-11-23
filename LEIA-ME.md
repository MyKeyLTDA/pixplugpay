# Tela de cobrança Pix + webhook PlugPay (salva no Supabase)

## Arquivos
- `index.html` — tela (Pix e QR Paraguay: QR + copia e cola + status a cada 5 s)
- `netlify/functions/plugpay.js` — cria cobrança, consulta status e grava a cobrança como "pendente" no banco
- `netlify/functions/plugpay-webhook.js` — **API que recebe os retornos da PlugPay e grava no Supabase**
- `netlify/lib/supabase.js` — acesso ao Supabase
- `netlify/lib/log.js` — limpa dados sensíveis antes de gravar os logs
- `supabase/schema.sql` — tabelas `plugpay_transacoes` e `plugpay_webhook_log` + função de gravação idempotente
- `tests/test.js` — teste local (`node tests/test.js`)

## 1) Banco (Supabase)
Rode `supabase/schema.sql` em *SQL Editor > New query > Run*. Pode rodar de novo a cada versão nova: ele só acrescenta o que falta (nesta versão: colunas do QR e a função de atualizar status).

**Chaves:** a tela de login usa a chave **publishable** (pública, pode ir no navegador). O banco continua só com a **secret**.

**Qual chave usar nas tabelas:** no Netlify vai a chave **secret** (`sb_secret_...`) ou, nos projetos antigos, a **service_role**. A chave **publishable** (ou `anon`) não funciona aqui, porque as tabelas têm RLS ligado e sem políticas, e ela nunca deve ir no `index.html` junto com a secret.

## 2) Variáveis no Netlify
| Variável | Valor |
|---|---|
| `PLUGPAY_BASE_URL` | `https://apisandbox.plugpayapi.com` (teste) ou `https://api.plugpayapi.com` (produção) |
| `PLUGPAY_CLIENT_ID` / `PLUGPAY_PASSWORD` | Client Id e Pass da API |
| `PLUGPAY_MERCHANT_DOC` | Documento do merchant, igual ao cadastrado na PlugPay |
| `SUPABASE_PUBLISHABLE_KEY` | chave **publishable** (`sb_publishable_...`) ou **anon**. Pública: a tela usa para o login |
| `AUTH_EMAILS` | (opcional) e-mails autorizados, separados por vírgula. Reforço: mesmo que alguém crie conta, só esses entram |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | chave **secret** (`sb_secret_...`) ou **service_role**. Nunca no front-end |
| `WEBHOOK_TOKEN` | Token que a PlugPay vai enviar no webhook (você define e informa a eles) |
| `WEBHOOK_AUTH_HEADER` | (opcional) nome do header em que a PlugPay manda o token. Padrão: `authorization` |
| `PLUGPAY_AMBIENTE` | (opcional) `sandbox` ou `producao`. Padrão: deduzido da URL base |

## 2b) Login dos usuários (Supabase Auth)
1. Supabase > *Authentication > Sign In / Providers* > Email: **desligue "Allow new users to sign up"** (ninguém se cadastra sozinho).
2. Crie os usuários (senha por variável, não fica em arquivo):
   `SUPABASE_URL=... SUPABASE_SERVICE_KEY=sb_secret_... SENHA='a-senha' node scripts/criar-usuarios.js usuario1@exemplo.com.br usuario2@exemplo.com.br usuario3@exemplo.com.br usuario4@exemplo.com.br usuario5@exemplo.com.br`
   (ou *Authentication > Users > Add user*, marcando *Auto Confirm User*).
3. A tela pede e-mail e senha; a function só atende quem manda um login válido. Para trocar a senha de alguém, rode o script de novo com a nova `SENHA`.

## Links de pagamento
0. No formulário Pix, a opção **"Quem preenche o nome e o CPF?"** define o caminho: *Eu preencho agora* (gera o Pix na hora) ou *O cliente preenche* (gera um link).
1. No modo cliente, o atendente preenche **valor** e **descrição** e clica em *Gerar link* (o link é copiado e aparece no painel da direita).
2. O cliente abre o link (`/pagar/<código>`), preenche **nome e CPF** e recebe o Pix (QR + copia e cola). A página confirma o pagamento sozinha.
3. O atendente vê o pagamento aprovado no histórico e, depois da venda, preenche direto na tabela (ícone ✎ ao lado do valor) o **nº do pedido**, o **nº da nota fiscal** e uma **observação** curta. Não há anexo de arquivo: só os números.
Cada link gera **um único Pix** e expira em 24 h (`LINK_VALIDADE_MIN` no Netlify muda isso, em minutos). Depois de usado, reabrir o link mostra o mesmo Pix.

## Filtros e exportação
Em *Transações* dá para filtrar por **status**, **usuário** e **nota fiscal** (todas / sem nota / com nota) e buscar por nome, CPF, pedido ou nota. **CSV**, **Excel (.xlsx)** e **PDF** usam esses mesmos filtros (até 1000 linhas). As bibliotecas ficam em `vendor/`.

## Logs também na API Joel Pires
Cada registro de log é enviado também por `POST https://api.joelpires.com.br/mensagens` com `tipo: "registro"` e `origem: "programa de cobranças MyKey"`. Se a rota não existir (404), cai só no console do Netlify e nada mais é afetado. Variáveis opcionais: `MENSAGENS_URL`, `MENSAGENS_TOKEN` (vai em `Authorization: Bearer`) e `MENSAGENS_DESLIGADO=1`. Corpo enviado (JSON): `tipo`, `origem`, `criado_em`, `usuario`, `request_id`, `ambiente`, `acao`, `rota`, `metodo`, `status_http`, `ok`, `duracao_ms`, `erro`, `request`, `response`, `resposta_bruta`.

## 3) O que informar à PlugPay
- **URL de retorno (webhook):** `https://SEU-SITE.netlify.app/.netlify/functions/plugpay-webhook`
- **Token:** o mesmo valor de `WEBHOOK_TOKEN`. Pergunte em qual header eles enviam; se não for `Authorization`, ajuste `WEBHOOK_AUTH_HEADER`.

## Como funciona
1. Ao gerar o Pix na tela, a cobrança já é gravada em `plugpay_transacoes` com status 5 (pendente).
2. A PlugPay avisa pelo webhook; a function valida o token, atualiza a transação e guarda o payload em `plugpay_webhook_log`.
3. Webhook repetido não duplica nada. Um status final (aprovado, rejeitado, cancelado, estornado) nunca volta para pendente.
4. Se o banco falhar, a function responde 500 e a PlugPay reenvia.

## Consultas úteis
```sql
select id_transacao, criado_em, metodo, moeda, valor, valor_brl, status_descricao, referencia_externa
from plugpay_transacoes order by criado_em desc limit 50;

select recebido_em, id_transacao, processado, erro from plugpay_webhook_log
where processado = false order by recebido_em desc;
```

## Painel de transações
Na tela, o painel **Transações** lista as cobranças salvas no Supabase (do ambiente atual): data, pedido/observação, tipo, valor enviado, valor em R$ e status. Filtra por status e busca por pedido ou referência, e mostra quantas estão aprovadas e a soma em R$.
- **Abrir QR:** reabre o QR e o copia e cola da cobrança, sem chamar a PlugPay (o QR é guardado ao criar).
- **Verificar / Verificar pendentes:** consulta o status na PlugPay e atualiza o banco. O webhook faz isso sozinho quando estiver configurado.
- O status também é atualizado enquanto a tela de um Pix recém-criado consulta o pagamento a cada 5 s.

## Logs
Cada chamada gera log em dois lugares:
- **Netlify:** *Logs > Functions > plugpay* (linhas JSON começando com `{"plugpay":...}`).
- **Supabase:** tabela `plugpay_api_log`, e na própria tela, no painel **"Registro de chamadas (logs)"** (clique numa linha para ver o enviado e a resposta).

Cada linha registra: ação, rota, HTTP, tempo em ms, o que foi enviado, a resposta e um **código** (`request_id`). Quando a tela mostra um erro, ela traz `| log: <código>`. Senhas, tokens, a chave de acesso e o CPF completo (só os 2 últimos dígitos) nunca são gravados.

```sql
select criado_em, acao, endpoint, status_http, erro from plugpay_api_log where request_id = 'CODIGO';
-- limpeza (rode de vez em quando): apaga logs com mais de 30 dias
delete from plugpay_api_log where criado_em < now() - interval '30 days';
```

## Conversão de reais
O estabelecimento não aceita BRL como moeda de origem. Por isso a tela pede o valor em **reais** e a function converte antes de criar o Pix:
1. Chama `POST /v1/partners/transactionPix/quote` com uma quantia de referência para achar a cotação.
2. Calcula quanto enviar em PYG (inteiro) ou USD (centavos) para chegar no valor em reais pedido.
3. Confere no `quote`, ajusta até 3 vezes e só então chama `transactionPix/create`.
PYG é mais preciso (1 guarani vale uma fração de centavo de real); em USD o valor final pode variar alguns centavos de real.

## Diferenças entre o guia v2.3 e a API real (confirmadas no sandbox)
- Criar Pix: o CPF vai no campo **`customerCPFCNPJ`** (o guia diz `customerCPF`, que é recusado).
- Cotação (`transactionPix/quote`) responde `valorEmBRL`, `valorEmUSD` e `exchangeRate`.

## Pendência
- O guia não mostra a resposta do `quote`. O código procura o valor em reais nos campos `valueBRL`, `valorEmBRL`, `valueBrl`, `valor_brl`. Se a resposta vier com outro nome, a tela mostra o erro com o trecho da resposta; ajuste `extrairBRL` em `plugpay.js`.

## Token da PlugPay (uma vez, reaproveitado)

A function **não pede token a cada operação**. O token é pedido uma vez, guardado com o vencimento (memória + tabela `plugpay_token` no Supabase, compartilhada entre as instâncias do Netlify) e reaproveitado por criação de Pix, cotação e consultas de status.

- Renova só quando faltam menos de 60 s para vencer (vencimento lido de `expires_in`/`expires_at` ou do `exp` do JWT; sem informação, 10 min).
- Só uma renovação por vez: promessa única na instância e trava no banco entre instâncias; quem perde a trava espera o token novo (até 6 s).
- Se a PlugPay devolver 401, renova uma única vez e repete a chamada.
- **429**: respeita o `Retry-After` (30 s se não vier), grava `bloqueado_ate` e não tenta de novo enquanto durar. A tela recebe **429 + Retry-After**, nunca 502.
- **Rode `supabase/schema.sql` de novo** (cria a tabela `plugpay_token`). Sem a tabela o programa continua funcionando, mas cada instância pede o seu próprio token.

## Padronização automática de nomes (por CPF)

Uma função agendada (`netlify/functions/padronizar-nomes.js`, a cada 10 minutos, configurada em `netlify.toml`) deixa o mesmo nome completo em todas as cobranças do mesmo CPF. Não há botão: roda sozinha.

- Limpa o nome (tira números/CNPJ e pontuação, ajusta maiúsculas e "da/de/dos").
- "Thiago Silva" conta como parte de "Thiago Ribeiro Silva"; vale o nome que cobre mais cobranças do CPF (empate: o mais completo, depois o mais recente).
- Mesmo CPF = mesmo nome de pessoa física: **sempre aplica**, sem etapa de conferência. Entre nomes sem relação, prefere o que não parece de empresa (LTDA, ME, Chaveiro...), depois o que cobre mais cobranças, o mais completo e o mais recente.
- **Correção manual vence:** quando alguém edita o nome na tabela, essa correção (a mais recente) vira o nome do CPF e é espalhada para as demais cobranças dele.
- O nome que o cliente digitou fica em `nome_informado` (aparece ao passar o mouse sobre o nome e na exportação).
- Cada execução que altera algo grava uma linha `rotina-nomes` no painel de logs, com o de/para (CPF mascarado). Se nada mudou, não grava nada.
- Funções agendadas só rodam no deploy publicado do Netlify. Para rodar agora: abra `/.netlify/functions/padronizar-nomes` (no máximo uma vez por minuto).
- Rode o `supabase/schema.sql` antes de publicar (colunas `nome_informado` e `nome_manual_em`).

## Tentativas ao gerar o Pix (link do cliente e tela do atendente)

Quando a PlugPay responde "CPF não registrado" (ou falha do lado dela), o **servidor** tenta de novo: no máximo **3 tentativas** no total, **30 segundos** entre elas, cada uma numa **chamada separada** do servidor. Não depende de a página ficar aberta.

- **Quem faz o quê:** a 1ª tentativa roda na chamada do clique. Se falhar, o estado fica na tabela `plugpay_tentativas` e o servidor dispara a função em segundo plano `plugpay-tentativa-background`, que espera os 30 s e executa a próxima tentativa; ao falhar, dispara a seguinte. A função agendada `plugpay-tentativas-varredura` (a cada minuto) pega qualquer tentativa que tenha ficado parada. Cada tentativa é reivindicada de forma atômica: nunca duas ao mesmo tempo.
- **A página só escuta:** o cliente (`link-info`) e o atendente (`tentativa-status`) apenas leem o estado a cada poucos segundos. Se fechar a página e reabrir o link, vê o resultado (QR, ou "tente de novo").
- **Cliente:** vê "Tentativa 2 de 3" com contagem regressiva; na 3ª falha, "Tente de novo ou chame o atendimento" com **Tentar de novo** (nova rodada) e **Chamar atendimento** (`wa.me/5535999018000`).
- **Atendente:** mesma contagem; na 3ª falha vê a resposta da PlugPay e **Tentar de novo** / **Chamar administrador** (defina `ADMIN_WHATSAPP`, só dígitos com DDI; sem ela o botão não aparece e fica a mensagem).
- **Só falha da PlugPay e "CPF não registrado" repetem.** Pedido inválido volta direto. 429/503 continuam respeitando o `Retry-After` e não entram nas tentativas.
- **Pix criado e resposta perdida:** todo Pix que a PlugPay criou numa tentativa é anotado. Quando uma tentativa dá certo, os Pix **anteriores** desse mesmo pedido ficam **cancelados** (status 6 + observação "Substituído por nova tentativa"). Se `PLUGPAY_CANCEL_PATH` estiver definida (rota de cancelamento da PlugPay, POST com `{IdTransacao}`), o cancelamento também é pedido a ela; sem ela, é cancelado **só aqui** e a observação diz isso.
- **Privacidade:** nome e CPF das tentativas ficam só em `plugpay_tentativas.pedido` e são apagados quando termina (sucesso ou falha).
- **Variáveis opcionais:** `TENTATIVA_ESPERA_SEG` (padrão 30), `ADMIN_WHATSAPP`, `PLUGPAY_CANCEL_PATH`.
- Antes de publicar, rode `supabase/schema.sql` (só acrescenta; cria `plugpay_tentativas`). As colunas `tentativa*`/`pendente_*` que a versão anterior pôs em `plugpay_links` não são mais usadas e podem ser apagadas depois.
