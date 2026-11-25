# Movix — Fase 1: fundação de planos e assinaturas

Este pacote contém um **rascunho de migração**, ainda não executado no Supabase.

## O que prepara

- `assinaturas`: estado e histórico das assinaturas, período pago, trial, tolerância, cancelamento e canal de compra.
- `pagamentos_assinatura`: cobranças vinculadas à assinatura, com identificadores do gateway e estado financeiro.
- `eventos_pagamento`: registro idempotente de eventos recebidos dos gateways, preparado para webhooks.
- RLS: usuário autenticado pode apenas consultar sua própria assinatura e seus próprios pagamentos. Escrita fica reservada ao backend (`service_role`). Eventos não ficam acessíveis ao cliente.

## O que NÃO faz

- Não altera `perfis.plano` nem `profiles.plano`.
- Não libera Premium por conta própria.
- Não integra Asaas ou Google Play ainda.
- Não configura Edge Functions, webhooks, checkout, renovação ou emissão de nota fiscal.
- Não altera limite de veículos nem arquiva veículos.
- Não executa nada no projeto Supabase.

## Decisões de arquitetura

1. A assinatura será a fonte de verdade do direito ao Premium; colunas antigas de plano no perfil ficam como legado/cache até a migração de leitura ser implementada.
2. O app não poderá criar ou alterar assinatura/pagamento diretamente. O backend validará a origem e o evento do gateway.
3. O índice parcial impede duas assinaturas correntes (`trialing`, `active`, `past_due`) para a mesma conta.
4. O histórico financeiro e de assinatura não será apagado ao cancelar ou expirar.
5. A compra na Play Store terá validação própria via Google Play Billing; a compra web/APK direto seguirá pelo Asaas.

## Revisões necessárias antes de aplicar

- Confirmar no banco o tipo exato de `planos.codigo` e a existência das linhas `free` e `premium`.
- Confirmar se `service_role` está disponível apenas no ambiente server-side.
- Validar com testes de migração em projeto de desenvolvimento antes de produção.
- Implementar as Edge Functions/API de checkout e webhook antes de permitir compras reais.
