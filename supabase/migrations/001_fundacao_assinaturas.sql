-- Movix | Fase 1 - Fundação de planos e assinaturas
-- RASCUNHO DE MIGRAÇÃO: não executar antes de revisar no projeto Supabase.
-- Premissas já confirmadas na auditoria:
--   * public.planos(codigo) existe e contém free/premium.
--   * public.perfis.plano é legado/cache e não deve ser fonte de autorização.
--   * RLS está habilitado nas tabelas existentes.
-- Esta migração não altera dados existentes, não cobra usuários e não libera Premium.

begin;

create table if not exists public.assinaturas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  plano_codigo text not null references public.planos(codigo) on update restrict on delete restrict,
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired', 'refunded')),
  origem text not null check (origem in ('web', 'android_apk', 'google_play', 'administrativo')),
  gateway text not null check (gateway in ('asaas', 'google_play', 'manual')),
  gateway_customer_id text,
  gateway_subscription_id text,
  periodo_inicio timestamptz,
  periodo_fim timestamptz,
  trial_inicio timestamptz,
  trial_fim timestamptz,
  tolerancia_ate timestamptz,
  cancelar_no_fim boolean not null default false,
  cancelada_em timestamptz,
  encerrada_em timestamptz,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now(),
  constraint assinaturas_periodo_valido check (
    periodo_inicio is null or periodo_fim is null or periodo_fim > periodo_inicio
  ),
  constraint assinaturas_trial_valido check (
    trial_inicio is null or trial_fim is null or trial_fim > trial_inicio
  ),
  constraint assinaturas_tolerancia_valida check (
    tolerancia_ate is null or periodo_fim is null or tolerancia_ate >= periodo_fim
  ),
  constraint assinaturas_id_user_uk unique (id, user_id)
);

-- Um usuário não pode ter duas assinaturas simultaneamente em contratação/uso.
-- Registros encerrados continuam preservados como histórico.
create unique index if not exists assinaturas_uma_corrente_por_usuario
  on public.assinaturas (user_id)
  where status in ('trialing', 'active', 'past_due');

create index if not exists assinaturas_user_historico_idx
  on public.assinaturas (user_id, criada_em desc);

create unique index if not exists assinaturas_gateway_subscription_uidx
  on public.assinaturas (gateway, gateway_subscription_id)
  where gateway_subscription_id is not null;

create table if not exists public.pagamentos_assinatura (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  assinatura_id uuid not null references public.assinaturas(id) on delete restrict,
  gateway text not null check (gateway in ('asaas', 'google_play', 'manual')),
  gateway_payment_id text not null,
  status text not null check (status in ('created', 'pending', 'confirmed', 'overdue', 'refunded', 'chargeback', 'canceled', 'failed')),
  valor numeric(12,2) not null check (valor > 0),
  moeda char(3) not null default 'BRL' check (moeda = 'BRL'),
  vencimento_em timestamptz,
  pago_em timestamptz,
  estornado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint pagamentos_assinatura_owner_fk
    foreign key (assinatura_id, user_id) references public.assinaturas(id, user_id) on delete restrict
);

create unique index if not exists pagamentos_gateway_id_uidx
  on public.pagamentos_assinatura (gateway, gateway_payment_id);

create index if not exists pagamentos_user_historico_idx
  on public.pagamentos_assinatura (user_id, criado_em desc);

create index if not exists pagamentos_assinatura_id_idx
  on public.pagamentos_assinatura (assinatura_id);

-- Livro de eventos para idempotência de webhooks. Payload bruto fica restrito
-- ao backend; não armazenar dados de cartão ou credenciais neste campo.
create table if not exists public.eventos_pagamento (
  id uuid primary key default gen_random_uuid(),
  gateway text not null check (gateway in ('asaas', 'google_play', 'manual')),
  gateway_event_id text not null,
  tipo_evento text not null,
  pagamento_id uuid references public.pagamentos_assinatura(id) on delete restrict,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  resultado text check (resultado in ('processed', 'ignored', 'failed')),
  detalhe_erro text,
  payload jsonb,
  constraint eventos_pagamento_gateway_evento_uk unique (gateway, gateway_event_id)
);

create index if not exists eventos_pagamento_pendentes_idx
  on public.eventos_pagamento (recebido_em)
  where processado_em is null;

alter table public.assinaturas enable row level security;
alter table public.pagamentos_assinatura enable row level security;
alter table public.eventos_pagamento enable row level security;

-- O cliente autenticado só pode LER os próprios dados. Não recebe INSERT,
-- UPDATE ou DELETE: criação/alteração é feita exclusivamente pelo backend.
drop policy if exists assinaturas_select_own on public.assinaturas;
create policy assinaturas_select_own
  on public.assinaturas for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists pagamentos_assinatura_select_own on public.pagamentos_assinatura;
create policy pagamentos_assinatura_select_own
  on public.pagamentos_assinatura for select to authenticated
  using (user_id = (select auth.uid()));

-- Nenhuma policy para authenticated em eventos_pagamento: é tabela interna.

revoke all on public.assinaturas from anon, authenticated;
revoke all on public.pagamentos_assinatura from anon, authenticated;
revoke all on public.eventos_pagamento from anon, authenticated;

grant select on public.assinaturas to authenticated;
grant select on public.pagamentos_assinatura to authenticated;

grant all on public.assinaturas to service_role;
grant all on public.pagamentos_assinatura to service_role;
grant all on public.eventos_pagamento to service_role;

commit;
