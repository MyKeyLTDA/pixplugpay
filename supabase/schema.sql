-- Rode este arquivo no Supabase: SQL Editor > New query > Run.
-- Seguro para rodar mais de uma vez (também atualiza as tabelas já criadas).

create table if not exists public.plugpay_transacoes (
  id                  bigint generated always as identity primary key,
  ambiente            text        not null default 'sandbox',   -- sandbox | producao
  id_transacao        bigint      not null,                     -- IdTransacao da PlugPay
  metodo              text,                                     -- PIX | QR_PARAGUAY | ...
  referencia          text,                                     -- referenciaInterna (Pix) ou serialNumber (QR PY)
  serial_number       text,
  status              smallint,                                 -- 5 pendente, 1 aprovado, 3 rejeitado, 6 cancelado, 9 estornado
  status_descricao    text,
  moeda               text,                                     -- moeda enviada à PlugPay (PYG, USD...)
  valor               numeric(18,2),                            -- valor nessa moeda
  valor_brl           numeric(18,2),                            -- valor cobrado em reais
  documento_merchant  text,
  codigo_transacao    text,
  e2e                 text,
  pago_em             timestamptz,
  referencia_externa  text,                                     -- número do pedido no Bling
  cpf_cliente         text,                                     -- CPF digitado na cobrança (só dígitos)
  nome_cliente        text,                                     -- nome do cliente digitado na cobrança
  criado_por          text,                                     -- e-mail de quem emitiu a cobrança
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  unique (ambiente, id_transacao)
);

-- Para quem já tinha a tabela criada antes desta versão:
alter table public.plugpay_transacoes add column if not exists cpf_cliente text;
alter table public.plugpay_transacoes add column if not exists nome_cliente text;
alter table public.plugpay_transacoes add column if not exists criado_por text;
-- qrCodeId devolvido na criação do Pix: é o que a PlugPay manda como referenciaInterna no aviso de pagamento
alter table public.plugpay_transacoes add column if not exists qr_code_id text;
-- Data em que a PlugPay repassou o valor (preenchida à mão pelo financeiro, conferindo um a um)
alter table public.plugpay_transacoes add column if not exists data_pago_plug date;
-- Nome como o cliente digitou, guardado quando a padronização de nomes (por CPF) o substitui
alter table public.plugpay_transacoes add column if not exists nome_informado text;
-- Quando uma pessoa corrigiu o nome à mão (a rotina automática de padronização respeita e espalha essa correção)
alter table public.plugpay_transacoes add column if not exists nome_manual_em timestamptz;
alter table public.plugpay_transacoes add column if not exists descricao text;       -- descrição digitada pelo atendente (link de pagamento)
alter table public.plugpay_transacoes add column if not exists nota_fiscal text;     -- nota fiscal / documento, anexado depois
alter table public.plugpay_transacoes add column if not exists observacoes text;      -- observação curta, editável
alter table public.plugpay_transacoes add column if not exists editado_por text;
alter table public.plugpay_transacoes add column if not exists editado_em timestamptz;

-- Token da PlugPay compartilhado entre as instâncias da function (evita pedir um token novo a cada operação)
create table if not exists public.plugpay_token (
  ambiente      text primary key,
  token         text,
  expira_em     timestamptz,
  bloqueado_ate timestamptz,     -- preenchido quando a PlugPay respondeu 429
  lock_ate      timestamptz,     -- trava curta: só uma instância renova por vez
  atualizado_em timestamptz default now()
);
alter table public.plugpay_token enable row level security;  -- sem policies: só a chave de serviço (servidor) acessa

-- Links de pagamento: o atendente gera, o cliente abre, preenche nome e CPF e recebe o Pix.
create table if not exists public.plugpay_links (
  id            bigint generated always as identity primary key,
  token         text        not null unique,                  -- vai na URL; difícil de adivinhar
  ambiente      text        not null default 'sandbox',
  valor_brl     numeric(18,2) not null,
  moeda_envio   text        not null default 'PYG',           -- PYG | USD
  descricao     text,
  criado_por    text,
  criado_em     timestamptz not null default now(),
  expira_em     timestamptz not null,
  usado_em      timestamptz,                                  -- preenchido quando o cliente gera a cobrança
  id_transacao  bigint                                        -- IdTransacao da PlugPay, depois de gerada
);
create index if not exists plugpay_links_criado_idx on public.plugpay_links (criado_em desc);
-- Retentativas ao gerar o Pix (feitas pelo servidor, uma por chamada, com 30 s entre elas)
alter table public.plugpay_links add column if not exists tentativa            smallint not null default 0;
alter table public.plugpay_links add column if not exists tentativa_estado     text;        -- null | aguardando | gerando
alter table public.plugpay_links add column if not exists proxima_tentativa_em timestamptz;
alter table public.plugpay_links add column if not exists gerando_ate          timestamptz; -- reserva curta: se a chamada morrer, outra assume
alter table public.plugpay_links add column if not exists pendente_nome        text;        -- só enquanto as tentativas correm; apagado depois
alter table public.plugpay_links add column if not exists pendente_cpf         text;
alter table public.plugpay_links enable row level security;

-- Guarda o QR para poder reabrir a cobrança sem chamar a PlugPay de novo
alter table public.plugpay_transacoes add column if not exists qr_copia_cola text;
alter table public.plugpay_transacoes add column if not exists qr_imagem     text;  -- base64 PNG ou URL

create index if not exists plugpay_transacoes_ref_idx    on public.plugpay_transacoes (referencia);
create index if not exists plugpay_transacoes_status_idx on public.plugpay_transacoes (status);
create index if not exists plugpay_transacoes_criado_idx on public.plugpay_transacoes (criado_em desc);

-- Todo webhook recebido, na íntegra (auditoria e reprocessamento)
create table if not exists public.plugpay_webhook_log (
  id           bigint generated always as identity primary key,
  recebido_em  timestamptz not null default now(),
  ambiente     text,
  id_transacao bigint,
  status       smallint,
  payload      jsonb,
  processado   boolean not null default false,
  erro         text
);

-- Log de cada chamada da tela/function e de cada chamada à PlugPay (sem senhas nem CPF completo)
create table if not exists public.plugpay_api_log (
  id          bigint generated always as identity primary key,
  criado_em   timestamptz not null default now(),
  request_id  text,
  ambiente    text,
  acao        text,
  endpoint    text,
  metodo      text,
  status_http smallint,
  ok          boolean,
  duracao_ms  integer,
  request     jsonb,
  response    jsonb,
  erro        text
);
-- Rota completa e resposta exatamente como recebida (só tokens/senhas mascarados)
alter table public.plugpay_api_log add column if not exists rota           text;
alter table public.plugpay_api_log add column if not exists resposta_bruta text;
create index if not exists plugpay_api_log_criado_idx on public.plugpay_api_log (criado_em desc);
create index if not exists plugpay_api_log_req_idx    on public.plugpay_api_log (request_id);

-- RLS ligado e sem políticas: a chave publishable/anon NÃO lê nem grava nada.
-- Só a chave secret/service_role (usada nas Netlify Functions) acessa.
alter table public.plugpay_transacoes  enable row level security;
alter table public.plugpay_webhook_log enable row level security;
alter table public.plugpay_api_log     enable row level security;

-- Grava/atualiza uma transação de forma idempotente.
-- Regra: um status final (1, 3, 6, 9) nunca volta para "pendente" (5),
-- mesmo que um webhook antigo chegue atrasado.
create or replace function public.plugpay_registrar(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.plugpay_transacoes (
    ambiente, id_transacao, metodo, referencia, serial_number, status, status_descricao,
    moeda, valor, valor_brl, documento_merchant, codigo_transacao, e2e, pago_em, referencia_externa,
    cpf_cliente, nome_cliente, criado_por, descricao, qr_copia_cola, qr_imagem, qr_code_id
  ) values (
    coalesce(p->>'ambiente', 'sandbox'),
    (p->>'id_transacao')::bigint,
    p->>'metodo',
    p->>'referencia',
    p->>'serial_number',
    nullif(p->>'status', '')::smallint,
    p->>'status_descricao',
    p->>'moeda',
    nullif(p->>'valor', '')::numeric,
    nullif(p->>'valor_brl', '')::numeric,
    p->>'documento_merchant',
    p->>'codigo_transacao',
    p->>'e2e',
    nullif(p->>'pago_em', '')::timestamptz,
    p->>'referencia_externa',
    p->>'cpf_cliente',
    p->>'nome_cliente',
    p->>'criado_por',
    p->>'descricao',
    p->>'qr_copia_cola',
    p->>'qr_imagem',
    p->>'qr_code_id'
  )
  on conflict (ambiente, id_transacao) do update set
    metodo             = coalesce(excluded.metodo,             plugpay_transacoes.metodo),
    referencia         = coalesce(excluded.referencia,         plugpay_transacoes.referencia),
    serial_number      = coalesce(excluded.serial_number,      plugpay_transacoes.serial_number),
    moeda              = coalesce(excluded.moeda,              plugpay_transacoes.moeda),
    valor              = coalesce(excluded.valor,              plugpay_transacoes.valor),
    valor_brl          = coalesce(excluded.valor_brl,          plugpay_transacoes.valor_brl),
    documento_merchant = coalesce(excluded.documento_merchant, plugpay_transacoes.documento_merchant),
    codigo_transacao   = coalesce(excluded.codigo_transacao,   plugpay_transacoes.codigo_transacao),
    e2e                = coalesce(excluded.e2e,                plugpay_transacoes.e2e),
    pago_em            = coalesce(excluded.pago_em,            plugpay_transacoes.pago_em),
    referencia_externa = coalesce(plugpay_transacoes.referencia_externa, excluded.referencia_externa),
    cpf_cliente        = coalesce(plugpay_transacoes.cpf_cliente, excluded.cpf_cliente),
    nome_cliente       = coalesce(plugpay_transacoes.nome_cliente, excluded.nome_cliente),
    criado_por         = coalesce(plugpay_transacoes.criado_por, excluded.criado_por),
    descricao          = coalesce(plugpay_transacoes.descricao, excluded.descricao),
    qr_copia_cola      = coalesce(plugpay_transacoes.qr_copia_cola,      excluded.qr_copia_cola),
    qr_imagem          = coalesce(plugpay_transacoes.qr_imagem,          excluded.qr_imagem),
    qr_code_id         = coalesce(plugpay_transacoes.qr_code_id,         excluded.qr_code_id),
    status = case
      when plugpay_transacoes.status = 9 then plugpay_transacoes.status  -- reembolso concluído: aviso repetido não reabre
      when plugpay_transacoes.status in (1, 3, 6, 9) and excluded.status = 5 then plugpay_transacoes.status
      else coalesce(excluded.status, plugpay_transacoes.status)
    end,
    status_descricao = case
      when plugpay_transacoes.status = 9 then plugpay_transacoes.status_descricao
      when plugpay_transacoes.status in (1, 3, 6, 9) and excluded.status = 5 then plugpay_transacoes.status_descricao
      else coalesce(excluded.status_descricao, plugpay_transacoes.status_descricao)
    end,
    atualizado_em = now();
end;
$$;

-- Atualiza só o status, procurando pela referência (usada ao consultar o status na PlugPay).
-- Mesma regra: status final não volta para pendente.
create or replace function public.plugpay_atualizar_status(
  p_ambiente text, p_ref text, p_status smallint, p_descricao text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.plugpay_transacoes t set
    status = case when t.status = 9 or (t.status in (1, 3, 6) and p_status = 5) then t.status else p_status end,
    status_descricao = case when t.status = 9 or (t.status in (1, 3, 6) and p_status = 5) then t.status_descricao
                            else coalesce(p_descricao, t.status_descricao) end,
    atualizado_em = now()
  where t.ambiente = p_ambiente
    and (t.referencia = p_ref or t.serial_number = p_ref)
    and t.status is distinct from p_status;
end;
$$;

revoke all on function public.plugpay_registrar(jsonb) from public, anon, authenticated;
grant execute on function public.plugpay_registrar(jsonb) to service_role;
revoke all on function public.plugpay_atualizar_status(text, text, smallint, text) from public, anon, authenticated;
grant execute on function public.plugpay_atualizar_status(text, text, smallint, text) to service_role;
