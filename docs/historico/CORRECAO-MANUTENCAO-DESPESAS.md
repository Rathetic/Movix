# Correção: integração entre Despesas e Garagem

## Comportamento
- Ao selecionar uma despesa na categoria `Manutenção` ou `Manutenção veicular`, o formulário solicita tipo de manutenção e KM do veículo.
- A descrição complementar é opcional; se ficar vazia, é usada a descrição da despesa.
- Ao salvar, o Movix cria uma única movimentação financeira e um registro correspondente no histórico da Garagem, associados pelo mesmo ID e ao veículo ativo.
- O registro da Garagem não cria uma segunda despesa quando a origem já é o formulário financeiro: a despesa é a própria movimentação criada.
- Excluir a movimentação vinculada em Despesas também remove o registro correspondente da Garagem. Excluir pela Garagem continua removendo a despesa vinculada.
- Categorias diferentes de manutenção não criam registros na Garagem.

## Arquivos atualizados
`index.html` e `script.js` na raiz, em `www/` e em `android/app/src/main/assets/public/`.

## Verificações executadas
- `node --check script.js`: aprovado.
- Conferência de IDs HTML duplicados e presença dos novos campos nas três cópias: aprovada.
- Conferência de igualdade entre as três cópias de `script.js`: aprovada.
- `npm test`: não foi possível executar a suíte porque as dependências `jsdom` e `fake-indexeddb` não estão instaladas neste ambiente. Nenhum teste automatizado é declarado como aprovado.

## Observação sobre registros antigos
A correção não apaga nem tenta mesclar automaticamente lançamentos já existentes, pois não é possível determinar com segurança se duas despesas antigas representam a mesma manutenção. Os registros antigos duplicados devem ser conferidos manualmente.
