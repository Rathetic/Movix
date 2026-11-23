# Movix – checklist de regressão (etapa 0)

Roda ANTES de começar uma etapa (estado de referência) e DEPOIS dela. Marque só o que passou.
Teste em dois tamanhos: celular (≤ 700 px) e computador (≥ 900 px). Dica: faça tudo com dados de teste ou com um backup exportado antes.

## A. Automático (1 minuto)
- [ ] `node tools/verificar-movix.js` termina com "Tudo certo." (nenhuma FALHA)

## B. Abertura e Lobby
- [ ] Sem login e com config.js preenchido: aparece o Lobby (logo, 3 cards de exemplo, Entrar, Criar conta, "Usar sem conta")
- [ ] "Entrar na minha conta" abre só o formulário de login, com "← Voltar"; Voltar do navegador volta ao Lobby
- [ ] "Criar minha conta" abre o formulário com abas Entrar / Criar conta (campos nome e confirmar senha aparecem só em Criar)
- [ ] "Usar sem conta" abre o app completo; recarregar a página continua no app
- [ ] Com login ativo: abre direto no app, sem Lobby
- [ ] Sair da conta leva de volta ao Lobby

## C. Dashboard e movimentações
- [ ] Os 3 cards (lucro, ganhos, despesas) mostram os mesmos valores de antes
- [ ] Registrar um ganho e uma despesa: toast, cards e relatório atualizam; campos limpam
- [ ] Histórico: excluir pede confirmação e remove
- [ ] Relatório Hoje / Semana / Mês com os mesmos números
- [ ] Meta semanal e meta mensal: salvar, barra de progresso, apagar (campo vazio)
- [ ] Central de alertas, Resumo de hoje e Desempenho preenchidos
- [ ] Palavra de incentivo: "Outra frase" troca o texto

## D. Gráficos
- [ ] As 4 abas (Ganhos x Despesas, Lucro, Evolução, Despesas por categoria) trocam o gráfico
- [ ] Filtros Período e Agrupar redesenham
- [ ] Toque/mouse nas barras mostra o balão de valores; ao sair, o balão some
- [ ] Girar o celular / redimensionar a janela redesenha sem cortar

## E. Combustível, Frete, Garagem
- [ ] Combustível: resultado em tempo real, "Salvar cálculo", lança despesa se marcado, histórico com exclusão
- [ ] Frete: abas "Pelo mapa" / "Distância manual"; busca de endereço com sugestões; cálculo; "Copiar orçamento" e "Enviar no WhatsApp" (a mensagem mantém os emojis)
- [ ] Garagem: trocar veículo, cadastrar (menu "Cadastrar novo veículo"), excluir, custo por km, lembretes, registrar manutenção (entra em despesas se houver valor)

## F. Jornada
- [ ] Iniciar turno: cronômetro anda a cada segundo; botão vira "Encerrar turno"; aparece "Pausar"
- [ ] Pausar / Retomar: o tempo pausado não conta
- [ ] Encerrar: abre o resumo (ganhos, entregas, km, categoria); "Registrar e lançar ganhos", "Registrar sem lançar", "Preencher no formulário", "Decidir depois"
- [ ] Remuneração por turno: salvar fixo e valor por entrega; ganhos são calculados ao digitar entregas
- [ ] Registro manual de turno e "Usar os ganhos já registrados nesta data"
- [ ] Lista de turnos: "Lançar ganho" e exclusão

## G. Cofrinho e Recordes
- [ ] Criar objetivo, guardar e retirar valor, excluir; barra de progresso
- [ ] Os 6 recordes continuam aparecendo com os mesmos valores

## H. Conta, sincronização e backup (só olhar; não executar migração nova)
- [ ] Conta logada: resumo, status da sincronização, botões coerentes com o estado (ativar / sincronizar agora / pausar)
- [ ] Exportar backup baixa o .json; Importar aceita o mesmo arquivo
- [ ] Recuperação de senha (link do e-mail) abre o formulário "Nova senha"

## I. Navegação e visual
- [ ] Menu: cada item leva à seção certa; o item ativo destaca ao rolar
- [ ] Celular: barra de abas embaixo, toast acima dela
- [ ] Nenhuma rolagem horizontal da página inteira
- [ ] Navegação por teclado: Tab mostra o foco em botões, links e campos
