# Movix — Relatório técnico da correção de confiabilidade

**Escopo respeitado:** nada foi publicado, nenhum SQL/migration foi executado, nenhum banco foi tocado, nenhum dado real foi excluído. Tudo roda em testes locais (Node + jsdom, Supabase **simulado**).

## 1. Achados do diagnóstico (Fase A)

| # | Achado | Confirmado no código entregue? |
|---|---|---|
| 1 | `sync.js` nunca consulta `MovixBackup.syncAutorizada()`; `iniciarSync()` chama `sincronizar()` no carregamento | **Sim** |
| 2 | Nenhuma operação de risco (importar backup, ativar sync, remover cópias, restaurar preventivo) chamava `protegerOperacao()`/`garantir()`; o `backup-local.js` não as intercepta | **Sim** |
| 3 | Paginação por `updated_at` + `gte` + `limit=1000`: com >1.000 registros no mesmo `updated_at` só 1.000 chegam | **Sim (reproduzido)** |
| 4 | Exclusão lógica: PATCH sem conferir linhas afetadas e remoção do snapshot incondicional | **Sim (reproduzido)** |
| 5 | Exclusão remota apagava alteração local pendente; metas locais alteradas durante o recebimento eram sobrescritas | **Sim (reproduzido)** |
| 6 | Resposta atrasada de conta anterior era aplicada; `estadoSync` global era escrito por ciclo de outra sessão | **Sim (reproduzido)** |
| 7 | Todas as 13 chaves do app já usam `motograna:`; 4 delas são do aparelho (`veiculoAtivo`, `frete`, `turnoAtual`, `turnoEncerrado`) e disparavam sync à toa; erro no observador podia quebrar `setItem` | **Sim** |
| 8 | Migração virava `concluida` mesmo com rejeitados; rejeições eram perdidas | **Sim (reproduzido)** |
| 9 | Dashboard: cálculo correto (combustível/manutenção contam 1×, via movimentação vinculada); cards são **histórico total** e "Lucro líquido" não dizia isso | Só o rótulo |
| 10 | Alerta de turno >12 h usava tempo corrido, ignorando pausas | **Sim (reproduzido)** |
| 11 | **`RESULTADO-testes.txt` do pacote anterior não é reproduzível:** a pasta `testes/` não vinha no zip principal e os testes B-1/B-5/A7/B8 exigem integração que o código entregue não tinha | **Sim** |

Bug extra descoberto pelos novos testes (pré-existente): quando uma exclusão local não era confirmada, o recebimento do **mesmo ciclo** trazia o registro de volta (ressuscitava o que o usuário apagou). Corrigido.

## 2. O que foi alterado

**`sync.js`** (principal)
- `backupAutoriza()` fail-closed (só `=== true`); checado em `sincronizar()`, `agendar()` e **a cada etapa/página** via `checar()`. Bloqueio ⇒ `aguardarBackup()` reconsulta com recuo (2 s → 30 s) e **retoma sozinho**.
- Ativação manual: `garantirAtivacaoSync()` (origem `pre_ativacao_sync`) é aguardada; falha ⇒ não ativa, nada é enviado. Aviso explícito quando o aparelho estava ligado a **outra conta**. Estado novo só é gravado depois de todas as etapas assíncronas.
- Paginação keyset `order=updated_at.asc,id.asc` + `or=(updated_at.gt.X,and(updated_at.eq.X,id.gt.Y))`, comparação de timestamps com microssegundos, janela de segurança de 10 s mantida, cursor só avança ao fim da tabela, guarda anti-travamento, página inválida aborta sem avançar. Aplicação por página é síncrona e idempotente; snapshot só muda depois de gravar.
- Exclusão lógica confirmada: `PATCH … deleted_at=is.null&id=in.(…)` com `return=representation`; faltantes são conferidos por GET; só o confirmado (ou já excluído) sai do snapshot; o resto fica pendente e é reportado. IDs vão entre aspas e codificados (ids com vírgula/aspas não alteram o filtro).
- Concorrência: alteração local pendente vence exclusão remota; exclusão local pendente não é ressuscitada; metas/remuneração alteradas durante o ciclo não são sobrescritas.
- Contas: cada ciclo pertence a uma conta (`cicloAtual`); `restFetch` revalida a identidade antes, depois de obter o token e depois da resposta (resposta atrasada é descartada); troca de usuário/logout/pausa cancelam o ciclo (`AbortController`), timers e `refazer`. Renovação de token da mesma conta não cancela nada. Erros 401/403 nunca tocam nos dados locais.
- Observador de LocalStorage: whitelist das 9 chaves de dados; instalado uma vez; falha dentro dele nunca quebra a gravação. O intervalo de 60 s continua como complemento.
- Migração: situações `concluida | parcial | falhou | pendente | ja_realizada`; rejeições persistem entre rodadas até serem resolvidas; relatório com enviados, recebidos, rejeitados, motivos, tabelas, duplicatas, data/hora e situação. **Para não depender de mudança no banco**, `parcial` é gravado como `status='iniciada'` + `resumo.situacao='parcial'`.
- `removerCopias` e `restaurarBackupPreventivo` agora pedem o snapshot independente antes de mexer nos dados.

**`script.js`**: `protegerAntes()`; `importarBackup` cria `pre_importacao` antes de alterar; alerta de turno usa tempo **efetivo** (>12 h trabalhadas) e avisa turno aberto >24 h mesmo com pausas.
**`backup-local.js`**: nova API aditiva `garantirAtivacaoSync()` (aplica os bloqueios e **não** oferece "continuar sem cópia"); comentário de cabeçalho atualizado. Nenhuma outra lógica alterada.
**`index.html`**: "Lucro líquido" → "Lucro líquido (total)" + comentário. Nenhuma mudança de layout/CSS.

## 3. Testes (`npm test`)

57 testes automatizados, 2 rodadas completas sem flutuação. Rodam os arquivos **reais** num jsdom com Supabase simulado (RLS, filtros, ordenação, `limit`, PATCH, falhas/atrasos injetáveis), e o `backup-local.js` real com IndexedDB e Web Locks simulados.

| Suíte | Antes (original) | Depois |
|---|---|---|
| `sync.teste.js` (backup/sync, paginação, exclusão, concorrência, contas, chaves, migração) | 15/36 | **36/36** |
| `backup-real.teste.js` (módulo real + sync real, duas abas) | 2/8 | **8/8** |
| `funcionalidades.teste.js` (dashboard, jornada, combustível, garagem, manutenção, objetivos, movimentações) | 10/12 | **12/12** |
| `_smoke` | — | 1/1 |

Os 2 "antes" de `funcionalidades` são exatamente o rótulo do card e o alerta de 12 h; o resto confirma que as regras financeiras já estavam corretas. `tools/verificar-movix.js` continua passando (avisa que `script.js`/`sync.js` diferem da referência — esperado; `nav.js` já diferia antes).

## 4. Limitações (honestas)

- **Não há Chromium neste ambiente**: os testes usam jsdom/fake-indexeddb/Web Locks simulado. A suíte Chromium antiga (`testes/` do zip aninhado) **não foi reexecutada**; recomendo rodá-la e fazer um teste manual em 2 aparelhos reais antes de publicar.
- O Supabase é simulado: comportamento real de RLS/PostgREST (ex.: `return=representation` exigir política de SELECT) deve ser validado em ambiente de homologação.
- Teste "ativação com snapshot falho" passa também na versão original por um artefato do jsdom (sem `URL.createObjectURL`); os demais da ativação diferenciam antes/depois.
- Exclusão cuja linha **não existe/não é visível** na nuvem fica pendente e reportada (não dá para distinguir de RLS). Pode repetir a cada rodada; solução definitiva exigiria uma RPC (abaixo).
- Duas abas do mesmo aparelho ainda mantêm arrays em memória independentes (problema anterior ao escopo; o sync não os coordena além do lock do backup).
- Km do resumo do dia: usa km dos turnos se houver, senão dos abastecimentos (nunca soma os dois). Pode omitir km quando só parte dos turnos tem km — regra de negócio mantida, sem alteração.
- A regra do alerta (12 h efetivas ou 24 h abertas) é uma decisão minha sobre intenção ambígua; fácil de ajustar.

## 5. Mudanças de banco **propostas — NÃO executadas**

Nenhuma é necessária para o funcionamento corrigido.
```sql
-- (opcional) desempenho da paginação keyset; repetir para as demais tabelas
create index concurrently if not exists movimentacoes_user_upd_id_idx on public.movimentacoes (user_id, updated_at, id);

-- (opcional) permitir o status 'parcial' (hoje fica iniciada + resumo.situacao). Risco: depende do nome real da constraint.
alter table public.migracoes drop constraint if exists migracoes_status_check;
alter table public.migracoes add constraint migracoes_status_check check (status in ('iniciada','concluida','parcial','falhou'));
```
Riscos: índice grande bloqueia escrita se criado sem `concurrently`; a constraint pode ter outro nome/valores — conferir antes.

## 6. Arquivos
Alterados: `sync.js`, `script.js`, `backup-local.js`, `index.html`, `package.json`. Novos: `testes/*` (6 arquivos). Dependências de desenvolvimento: `jsdom`, `fake-indexeddb`.
