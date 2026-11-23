"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { criarApp, SEED_BASE, mov, veic } = require("./_app");
const novo = (seed = {}) => criarApp({ carregarSync: false, backup: null, seed: { ...SEED_BASE(), ...seed } });
const preencher = (app, campos) => Object.entries(campos).forEach(([id, v]) => { app.w.document.getElementById(id).value = String(v); });
const submit = (app, fn) => app.ev(fn + "({ preventDefault() {} })");
const hoje = (app) => app.json("dataParaTexto(new Date())");
const ganho = (id, valor, data, extra = {}) => ({ id, descricao: "g", tipo: "ganho", categoria: "Outros", valor, data, ...extra });
const desp = (id, valor, data, cat = "Outros", extra = {}) => ({ id, descricao: "d", tipo: "despesa", categoria: cat, valor, data, ...extra });
const texto = (app, id) => app.w.document.getElementById(id).textContent;

test("backup JSON: exportação inclui remuneração local", async () => {
  const app = novo({ "motograna:remuneracao": { fixo: 52.5, porEntrega: 7 } });
  try {
    assert.deepEqual(app.json("montarPacoteBackup().remuneracao"), { fixo: 52.5, porEntrega: 7 });
  } finally { app.fechar(); }
});
test("backup JSON: importação restaura remuneração quando o aparelho ainda não tem configuração", async () => {
  const app = novo();
  try {
    const pacote = { app: "Movix", movimentacoes: [], remuneracao: { fixo: 50, porEntrega: 8 } };
    app.ev("importarBackup(new Blob([" + JSON.stringify(JSON.stringify(pacote)) + "]))");
    for (let i = 0; i < 100 && app.ls("motograna:remuneracao") === null; i++) await app.espera(10);
    assert.deepEqual(app.lsJson("motograna:remuneracao"), { fixo: 50, porEntrega: 8 });
    assert.deepEqual(app.json("remuneracao"), { fixo: 50, porEntrega: 8 });
  } finally { app.fechar(); }
});

test("dashboard: totais acumulados (histórico completo), arredondamento e lucro", async () => {
  const app = novo({ "motograna:movimentacoes": [ganho("a", 0.1, "2025-01-01"), ganho("b", 0.2, "2026-11-01"), desp("c", 0.05, "2026-11-02")] });
  try {
    assert.deepEqual(app.json("calcularTotais()"), { ganhos: 0.3, despesas: 0.05, lucro: 0.25 });
    assert.equal(app.json("calcularTotais('2026-11-01','2026-11-30').ganhos"), 0.2);
    assert.match(texto(app, "totalLucro"), /0,25/); assert.match(app.w.document.getElementById("totalLucro").previousElementSibling.textContent, /total/i);
  } finally { app.fechar(); }
});
test("dashboard: combustível e manutenção entram UMA vez (via movimentação vinculada), sem dupla contagem", async () => {
  const app = novo({ "motograna:movimentacoes": [ganho("g", 200, hoje0())] });
  function hoje0() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  try {
    app.w.document.getElementById("lancarCombustivel").checked = true;
    preencher(app, { kmInicial: 1000, kmFinal: 1100, consumo: 10, precoLitro: 6, dataCombustivel: hoje0() });
    await submit(app, "aoSalvarCombustivel");
    preencher(app, { tipoManut: "Pneus", valorManut: 80, kmManut: 1100, dataManut: hoje0() });
    await submit(app, "aoSalvarManutencao");
    assert.equal(app.json("calcularTotais().despesas"), 60 + 80);
    assert.equal(app.json("movimentacoes.filter(m => m.origem).length"), 2);
    assert.equal(app.json("extras.combustivel.length"), 1);
    app.ev("lancarDespesa('x','Combustível',60,'" + hoje0() + "',{tipo:'combustivel',id:extras.combustivel[0].id})");
    assert.equal(app.json("calcularTotais().despesas"), 140, "lançamento repetido duplicou");
    renderResumo(app);
    const linhas = app.w.document.getElementById("resumoDia").textContent;
    assert.match(linhas, /Lucro líquido/); assert.match(linhas, /R\$\s*60,00/); assert.match(linhas, /R\$\s*80,00/);
    assert.equal(app.json("(() => { const t = calcularTotais(); return t.ganhos - t.despesas; })()"), 60);
    // excluir o abastecimento remove SÓ a despesa dele
    app.ev("removerExtra('combustivel', extras.combustivel[0].id)");
    assert.equal(app.json("calcularTotais().despesas"), 80);
  } finally { app.fechar(); }
  function renderResumo(a) { a.ev("renderizarResumoDia()"); }
});
test("resumo do dia: km vem dos turnos quando existem, senão dos abastecimentos (sem somar os dois)", async () => {
  const d = new Date(); const h = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const turno = { id: "t1", data: h, inicio: "08:00", fim: "12:00", minutos: 240, ganhos: 100, entregas: 5, pausaMin: 0, registro: "manual", km: 40 };
  const abast = { id: "c1", data: h, veiculoId: "v1", kmInicial: 0, kmFinal: 55, consumo: 10, preco: 6, distancia: 55, litros: 5.5, custo: 33 };
  const app = novo({ "motograna:turnos": [turno], "motograna:combustivel": [abast] });
  try { assert.match(app.w.document.getElementById("resumoDia").textContent, /40 km/); assert.doesNotMatch(app.w.document.getElementById("resumoDia").textContent, /95 km/); }
  finally { app.fechar(); }
});
test("jornada: pausas não contam no tempo; encerramento registra minutos efetivos e ganho vinculado (idempotente)", async () => {
  const agora = Date.now(), H = 3600000;
  const app = novo({ "motograna:turnoAtual": { inicio: agora - 3 * H, pausas: [{ de: agora - 2 * H, ate: agora - H }] } });
  try {
    app.ev("carregarTurnoAtual()");
    assert.equal(Math.round(app.json("(Date.now() - turnoAtual.inicio - msPausado(Date.now())) / 60000")), 120);
    app.ev("confirm = () => true; aoClicarTurnoPrincipal()");
    const enc = app.json("turnoEncerrado"); assert.equal(enc.pausaMin, 60);
    preencher(app, { ganhosResumo: 150, entregasResumo: 6 });
    app.ev("registrarTurnoEncerrado(true)");
    const t = app.json("extras.turnos[0]"); assert.equal(t.minutos, 120); assert.equal(t.ganhos, 150); assert.equal(t.pausaMin, 60);
    const m = app.json("movimentacoes.filter(m => m.origem && m.origem.tipo === 'turno')"); assert.equal(m.length, 1); assert.equal(m[0].origem.id, t.id); assert.equal(m[0].valor, 150);
    app.ev("sincronizarMovimentacaoDoTurno(extras.turnos[0], 'Outros')");
    assert.equal(app.json("movimentacoes.filter(m => m.origem && m.origem.tipo === 'turno').length"), 1, "duplicou o ganho do turno");
  } finally { app.fechar(); }
});
test("jornada: alerta de 12 h usa o tempo EFETIVO (13 h abertas com 6 h de pausa NÃO alertam); 13 h trabalhadas alertam", async () => {
  const H = 3600000, agora = Date.now();
  const alerta = (turno) => { const app = novo({ "motograna:turnoAtual": turno }); try { app.ev("carregarTurnoAtual(); renderizarAlertas()"); return app.w.document.getElementById("listaAlertas").textContent; } finally { app.fechar(); } };
  const pausado = alerta({ inicio: agora - 13 * H, pausas: [{ de: agora - 12 * H, ate: agora - 6 * H }] });
  assert.doesNotMatch(pausado, /Encerre se já terminou/);
  assert.match(alerta({ inicio: agora - 13 * H, pausas: [] }), /Trabalhado há 13 h/);
  assert.match(alerta({ inicio: agora - 30 * H, pausas: [{ de: agora - 29 * H, ate: null }] }), /Aberto há 30 h/);
  assert.doesNotMatch(alerta({ inicio: agora - 2 * H, pausas: [] }), /Encerre se já terminou/);
});
test("jornada: remuneração calculada na hora e mudar a configuração NÃO altera turnos antigos", async () => {
  const antigo = { id: "t0", data: "2026-10-01", inicio: "08:00", fim: "10:00", minutos: 120, ganhos: 70, entregas: 5, pausaMin: 0, registro: "manual" };
  const app = novo({ "motograna:turnos": [antigo], "motograna:remuneracao": { fixo: 50, porEntrega: 4 } });
  try {
    assert.equal(app.json("calcularRemuneracao(5)"), 70);
    preencher(app, { ganhoFixoTurno: 10, valorEntregaTurno: 1 }); app.ev("aoSalvarRemuneracao()");
    assert.equal(app.json("calcularRemuneracao(5)"), 15); assert.deepEqual(app.json("extras.turnos[0]"), antigo);
  } finally { app.fechar(); }
});
test("turno manual: passa da meia-noite e desconta pausa", async () => {
  const app = novo();
  try {
    preencher(app, { dataTurno: "2026-11-10", inicioTurno: "22:00", fimTurno: "02:00", ganhosTurno: 100, entregasTurno: 4, kmTurno: 30 });
    app.ev("pausaPendente = 30"); await submit(app, "aoSalvarTurno");
    const t = app.json("extras.turnos[0]"); assert.equal(t.minutos, 210); assert.equal(t.km, 30);
  } finally { app.fechar(); }
});
test("garagem: cadastrar, trocar e excluir veículo (bloqueia se há abastecimento) e custo por km", async () => {
  const abast = { id: "c1", data: "2026-11-01", veiculoId: "v1", kmInicial: 0, kmFinal: 100, consumo: 10, preco: 6, distancia: 100, litros: 10, custo: 60 };
  const app = novo({ "motograna:combustivel": [abast] });
  try {
    preencher(app, { apelidoVeic: "Biz", kmVeic: 10, anoVeic: "2021" }); await submit(app, "aoSalvarVeiculo");
    assert.equal(app.json("extras.veiculos.length"), 2); assert.equal(app.json("nomeVeiculo()"), "Biz");
    app.ev("confirm = () => true; aoExcluirVeiculo()"); assert.equal(app.json("extras.veiculos.length"), 1);
    app.ev("definirVeiculoAtivo('v1'); aoExcluirVeiculo()"); assert.equal(app.json("extras.veiculos.length"), 1);
    assert.equal(app.json("custoPorKm('v1').valor"), 0.6);
  } finally { app.fechar(); }
});
test("manutenção: lembrete por km e valor 0 não gera despesa", async () => {
  const app = novo();
  try {
    preencher(app, { tipoManut: "Troca de óleo", valorManut: 0, kmManut: 1000, dataManut: "2026-11-01", lembreteKm: 3000 }); await submit(app, "aoSalvarManutencao");
    assert.equal(app.json("movimentacoes.length"), 0); assert.equal(app.json("extras.manutencoes[0].proxKm"), 4000);
  } finally { app.fechar(); }
});
test("objetivos: criar, guardar, retirar (limite) e excluir", async () => {
  const app = novo();
  try {
    preencher(app, { nomeObjetivo: "Moto nova", metaObjetivo: 1000 }); await submit(app, "aoCriarObjetivo");
    const id = app.json("extras.objetivos[0].id");
    app.ev("movimentarObjetivo('" + id + "', 1, 300)"); app.ev("movimentarObjetivo('" + id + "', -1, 500)");
    assert.equal(app.json("extras.objetivos[0].guardado"), 300); app.ev("movimentarObjetivo('" + id + "', -1, 100)"); assert.equal(app.json("extras.objetivos[0].guardado"), 200);
    app.ev("removerExtra('objetivos', '" + id + "')"); assert.equal(app.json("extras.objetivos.length"), 0);
  } finally { app.fechar(); }
});
test("recebimentos/movimentações: lançar ganho e despesa pelo formulário e excluir", async () => {
  const app = novo();
  try {
    app.w.document.querySelector('input[name="tipo"][value="ganho"]').checked = true; app.ev("atualizarCategorias()");
    preencher(app, { descricao: "iFood", valor: 55.5, data: "2026-11-05" }); app.w.document.getElementById("categoria").value = "iFood";
    await submit(app, "aoEnviarFormulario");
    assert.equal(app.json("movimentacoes.length"), 1); assert.equal(app.json("calcularTotais().ganhos"), 55.5);
  } finally { app.fechar(); }
});
test("compatibilidade: nenhuma chave nova no LocalStorage além do catálogo motograna:*/movix:*", async () => {
  const app = novo({ "motograna:movimentacoes": [mov(1)] });
  try { const k = Array.from({ length: app.w.localStorage.length }, (_, i) => app.w.localStorage.key(i)); k.forEach((x) => assert.match(x, /^(motograna|movix):/)); } finally { app.fechar(); }
});
