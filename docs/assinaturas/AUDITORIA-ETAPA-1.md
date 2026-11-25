# Movix — Planos e assinaturas: Etapa 1 (Auditoria)

Data: 25/11/2026. Somente leitura: nenhum SQL foi executado, nenhum código do app foi alterado, nada foi enviado ao GitHub.

## 1. O que foi realmente verificado

| Item | Resultado |
|---|---|
| Testes existentes (`npm test`, jsdom + Supabase falso) | 97 de 97 passaram (executado nesta auditoria) |
| `node tools/verificar-movix.js` | "Tudo certo" (aviso informativo: script.js, auth.js, sync.js e nav.js diferem da referência antiga) |
| Raiz x `www/` | Os 10 arquivos do app são idênticos nos dois lugares |
| Segredos no pacote | Nenhuma keystore, `.env`, `google-services.json` ou senha de assinatura encontrados. `config.js` tem só a chave publishable do Supabase e a chave gratuita do ORS (ambas públicas por desenho) |
| `applicationId` | `br.com.movixfinance.app` (inalterado) |
| Git | Há trabalho não commitado: `script.js`, `sync.js`, `index.html`, `www/*` e testes modificados; `supabase/` ainda não rastreado |

## 2. O que NÃO foi possível verificar (o repositório não contém o schema real)

O pacote não tem os SQLs das etapas 3.x nem um dump do banco. Portanto **não dá para confirmar**, só pelos arquivos:

- o tipo exato de `planos.codigo` e as linhas `free`/`premium`;
- a estrutura real de `veiculos` (colunas, FKs de `abastecimentos`, `manutencoes`, `turnos`);
- o corpo de `validar_limite_veiculos()`, se ainda não tem trigger, e as policies RLS atuais;
- quantas contas hoje têm mais de um veículo ativo.

As consultas SELECT para obter isso estão na seção 6. Não presumi nenhum resultado.

## 3. Estado atual do código

- `script.js` (linhas ~1316-1319): `PLANOS`, `PLANO_ATUAL = "free"`, `APLICAR_LIMITE_PLANO = false`. O limite só existe no cliente e está desligado, então hoje **todos** podem ter vários veículos.
- `sync.js` usa `fetch` direto na REST do Supabase (`restFetch`), não o supabase-js. Faz upsert em lote com `on_conflict=user_id,id` e `deleted_at: null` em toda linha enviada.
- `paraLinha` de veículos envia só `id, tipo, marca, modelo, ano, placa, apelido, km_atual`. Não existe campo de arquivamento em lugar nenhum.
- `auth.js` e `sync.js` não consultam plano nem assinatura.

## 4. Problemas encontrados em `001_fundacao_assinaturas.sql`

Bloqueantes (corrigir antes de executar em qualquer banco):

1. **Não distingue mensal de anual.** `plano_codigo` só pode ser `free`/`premium`. Falta uma coluna de ciclo (mensal/anual), e também o plano agendado para o fim do período (anual para mensal, Premium para Free).
2. **Teste gratuito repetível.** O índice parcial só impede duas assinaturas correntes ao mesmo tempo; nada impede um novo trial depois que o anterior acabou. Falta uma regra de um trial por conta.
3. **`canceled` ambíguo.** Se o cancelamento marcar `status = 'canceled'` enquanto o período pago ainda vale, o índice de unicidade deixa de enxergar essa assinatura e uma segunda pode ser criada (acesso duplicado). É preciso definir: cancelamento = `active` + `cancelar_no_fim = true`, e `canceled` só depois do vencimento (ou equivalente). **Decisão sua**, ver seção 5.
4. **`on delete restrict` em `auth.users`.** Impede a exclusão de conta e conflita com o direito de eliminação da LGPD. Precisa de uma política definida (por exemplo, anonimizar o histórico financeiro e manter só o necessário).
5. **`eventos_pagamento` sem vínculo com a assinatura nem com o usuário.** Só aponta para `pagamento_id`; eventos de assinatura sem pagamento ficam órfãos. Além disso o `payload` bruto pode conter dados pessoais (nome, CPF, e-mail do pagador) e precisa de minimização e prazo de retenção.

Importantes:

6. `atualizada_em`/`atualizado_em` não são atualizados automaticamente (faltam triggers).
7. Faltam colunas de conciliação: método (Pix/cartão), referência externa, `purchase_token` do Google Play.
8. Não há tabela de auditoria das mudanças de assinatura (exigida pelo item "Auditoria").
9. Não existe a função única "plano efetivo", que será a fonte de verdade para o app, para o trigger de limite e para as policies. Sem ela, nasce a "segunda lógica conflitante" que o seu texto proíbe.
10. Não há `free` como status. A solução natural é: ausência de assinatura corrente = Free. Isso precisa ficar documentado.

Pontos corretos (mantidos): FK composta `(assinatura_id, user_id)` impede pagamento de outra conta; unicidade `(gateway, gateway_payment_id)` e `(gateway, gateway_event_id)` dá idempotência; RLS só com SELECT próprio e `revoke` explícito para `anon`/`authenticated`; `eventos_pagamento` sem acesso do cliente.

## 5. Riscos de integração e decisões que dependem de você

Riscos técnicos:

- **Trigger de limite só em INSERT não basta.** O sync faz upsert com `deleted_at: null`, o que pode "reviver" um veículo excluído ou reativar um arquivado por UPDATE. O trigger precisa cobrir INSERT e UPDATE de `deleted_at` e do campo de arquivamento.
- **Campos de arquivamento protegidos.** O cliente não pode escrever `arquivado_em` e afins (trigger ou privilégio por coluna), senão desarquiva o próprio veículo.
- **Lote do sync.** Se o banco recusar um veículo por limite, o lote inteiro pode falhar e travar a sincronização de tudo. O `sync.js` precisa tratar a recusa como erro específico, sem laço de repetição e sem perder dados locais.
- **Contas existentes.** Como o limite hoje está desligado, contas Free podem já ter 2 ou mais veículos ativos. Ligar o trigger sem tratar isso quebra UPDATEs dessas contas.
- **Arquivar não pode desvincular.** Hoje, excluir veículo solta o `veiculo_id` dos turnos. Arquivar deve manter o vínculo; só a seleção de veículo ativo e os filtros mudam.
- **Rotinas por tempo** (fim do trial, fim da tolerância, auto-arquivamento após 7 dias): o direito ao Premium pode ser calculado por datas na leitura (sem cron); o auto-arquivamento precisa de agendador (pg_cron ou função agendada). Disponibilidade no seu plano do Supabase não verificada.
- **Google Play:** apps distribuídos pela Play devem vender assinatura digital pelo Play Billing; o checkout do Asaas não pode aparecer na versão da loja. O repositório não tem plugin de billing. Preparo a estrutura; a validação real depende de credenciais e conta de desenvolvedor.
- **Teste gratuito sem cartão** não impede criar várias contas com e-mails diferentes. Limitação conhecida, a documentar.

Decisões necessárias (não vou inventar regra):

1. **Contas Free que já têm vários veículos:** (a) manter todos ativos para essas contas (grandfathering), (b) abrir a janela de 7 dias para escolher um, ou (c) outra regra.
2. **Cancelamento:** confirmar o modelo `active + cancelar_no_fim` descrito no item 3.
3. **Mensal para anual "imediato" sem crédito proporcional:** depende do que o Asaas permite. Precisa ser validado na documentação/sandbox do Asaas antes de implementar; se não for possível sem crédito proporcional ou estorno, paro e peço a sua decisão.
4. **Exclusão de conta (LGPD):** o que fazer com o histórico de pagamentos.
5. **Quais recursos são Premium além de vários veículos:** o seu texto diz "conforme a definição comercial"; hoje só vários veículos está definido (suas anotações anteriores citam múltiplos contratantes e análises avançadas). Backup e sincronização continuam gratuitos.

## 6. Consultas SELECT para rodar no Supabase (somente leitura)

```sql
-- A1: tipo de planos.codigo e conteúdo da tabela
select column_name, data_type, udt_name from information_schema.columns
 where table_schema='public' and table_name='planos' order by ordinal_position;
select * from public.planos;

-- A2: estrutura de veiculos e de quem aponta para ela
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_schema='public' and table_name='veiculos' order by ordinal_position;
select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
  from pg_constraint where contype='f' and confrelid='public.veiculos'::regclass;

-- A3: função de limite e triggers existentes
select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='validar_limite_veiculos';
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid='public.veiculos'::regclass and not tgisinternal;

-- A4: policies RLS de veiculos, planos e perfis
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
 where schemaname='public' and tablename in ('veiculos','planos','perfis');

-- A5: contas com mais de um veículo ativo (impacto do limite)
select user_id, count(*) as ativos from public.veiculos
 where deleted_at is null group by user_id having count(*) > 1;

-- A6: perfis.plano e a FK para planos
select plano, count(*) from public.perfis group by plano;
```

## 7. Plano das próximas etapas (aguardando sua aprovação)

- **Etapa 2:** reescrever a migração como `001` revisada + `002` (arquivamento de veículos, função de plano efetivo, trigger de limite), em arquivos novos, sem executar nada.
- **Etapa 3:** Edge Functions (checkout Asaas, webhook Asaas, validação Google Play, iniciar trial) com testes de assinatura/idempotência. Sem credenciais, ficam preparadas e documentadas.
- **Etapa 4:** consulta de plano no app (cache local nunca libera Premium), interface de assinatura, fluxo de downgrade; `sync.js` ajustado para a recusa por limite.
- **Etapa 5:** testes. Os de SQL/RLS exigem um Postgres de teste; os de app seguem o padrão atual (jsdom). Informarei exatamente o que foi e o que não foi testado.
- **Etapa 6:** documentação completa.
