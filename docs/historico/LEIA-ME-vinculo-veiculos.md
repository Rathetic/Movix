# Movix – vínculo dos turnos com os veículos (revisado e completado)

## O que a sua correção já fazia (e está certo)
- O turno guarda o veículo ativo **ao iniciar** (`turnoAtual.veiculoId`) e o mantém até o registro, mesmo que você troque
  de veículo no meio do turno.
- Passa por turno encerrado → resumo → turno registrado, e também pelo lançamento manual.
- O `sync.js` envia `veiculo_id` e recebe de volta `veiculoId` (antes enviava sempre nulo).
- Turno em andamento criado antes da atualização (sem veículo) cai no veículo ativo ao registrar.

## O que estava faltando (corrigido neste pacote)
1. **Excluir veículo deixava turnos apontando para um veículo que não existe mais.** Agora os turnos **continuam salvos**
   (nada some do histórico) e só perdem o vínculo (`veiculoId = null`); a confirmação avisa quantos turnos são. Isso é gravado
   e sincronizado, então a nuvem e o outro aparelho recebem o vínculo solto.
2. **Excluir o veículo de um turno em andamento (ou aguardando o resumo)** deixaria o turno sem destino. Agora é bloqueado
   com a mensagem "Encerre e registre o turno deste veículo antes de excluí-lo."
3. **Importar backup:** com o vínculo, quase todo turno aponta para o veículo padrão "Minha moto". Quando o padrão vazio sai
   para dar lugar aos veículos do backup, os turnos dele ficam sem veículo; turnos importados de um veículo que não veio no
   backup também. Backups antigos (sem `veiculoId`) continuam válidos.
4. **Sync:** só envia `veiculo_id` se for um texto não vazio (valor estranho vira nulo em vez de quebrar o envio).
5. **O `www/` (app Android) estava desatualizado:** só a raiz tinha a correção. Agora `www/script.js` e `www/sync.js`
   são idênticos aos da raiz.

## Histórico visual
- O histórico agora identifica o veículo associado a cada jornada. Jornadas sem vínculo aparecem como “Sem veículo associado”.

## Como ficou o comportamento
- Turnos antigos (sem veículo) **continuam sem veículo**; não atribuí a nenhum por suposição.
- O vínculo é guardado e sincronizado; **a tela ainda não mostra o veículo em cada turno** (posso adicionar se quiser).

## Arquivos (copiar por cima, preservando as pastas)
    script.js, sync.js                  -> raiz do projeto
    www/script.js, www/sync.js          -> pasta www/
    testes/turno-veiculo.teste.js       -> 10 testes novos

## Aplicar
    npm test                            # 97 testes (96 anteriores + 1 teste de histórico)
    npx cap sync android
O projeto Android foi preparado para `versionCode 2` e `versionName 1.1.0`. Depois gere o APK de novo. Para o site, commit e push.

## No git, faça commit só do que mudou de verdade
    git add script.js sync.js www/script.js www/sync.js testes/turno-veiculo.teste.js
O `git status` mostra outros arquivos como modificados (.gitignore, gradlew.bat, organizar-imagens.sh, file_paths.xml,
testes/sync.teste.js): são só diferenças de fim de linha (LF/CRLF), sem mudança de conteúdo. Não precisa commitá-los.

## Confira no Supabase (uma vez)
A coluna `turnos.veiculo_id` precisa existir, aceitar nulo e ser do mesmo tipo de `abastecimentos.veiculo_id`
(o app já enviava `veiculo_id: null`, então a coluna existe). Se ela tiver chave estrangeira para `veiculos`, está tudo certo:
os veículos são enviados antes dos turnos, e a exclusão de veículo é lógica (`deleted_at`).

## Testes
- Linha de base enviada: 96/96 testes aprovados.
- Novo teste focado de histórico: 11/11 testes da suíte `turno-veiculo.teste.js` aprovados após a alteração (inclui o novo caso visual).
- Contagem atual esperada: 97 testes. A execução completa combinada não terminou neste ambiente; as demais suítes foram verificadas separadamente onde possível.
- Chromium, conforme `testes/RESULTADO-testes.txt`: módulo 47/47 e integração 87/87 aprovados. Esses são resultados registrados no pacote, não reexecutados nesta sessão.
