"use strict";
/* Vínculo do turno com o veículo: grava ao iniciar, sobrevive a recarregar/sincronizar e não deixa referência solta. */
const test = require("node:test"); const assert = require("node:assert/strict");
const { SupabaseFake } = require("./_supabase_fake");
const { criarApp, appLogado, SEED_BASE, veic } = require("./_app");
const V1 = () => veic("v1"), V2 = () => veic("v2", { apelido: "Moto 2" });
const novo = (seed = {}) => criarApp({ carregarSync: false, backup: null, seed: { ...SEED_BASE(), "motograna:veiculos": [V1(), V2()], ...seed } });
const preencher = (app, campos) => Object.entries(campos).forEach(([id, v]) => { app.w.document.getElementById(id).value = String(v); });
const submit = (app, fn) => app.ev(fn + "({ preventDefault() {} })");
const turno = (id, veiculoId, extra = {}) => ({ id, data: "2026-11-10", inicio: "08:00", fim: "12:00", minutos: 240, ganhos: 100, entregas: 5, pausaMin: 0, registro: "manual", veiculoId, ...extra });
const principal = (app) => app.ev("aoClicarTurnoPrincipal()");
function registrar(app) {
  preencher(app, { ganhosResumo: 80, entregasResumo: 4 });
  app.ev("registrarTurnoEncerrado(false)");
}

test("vínculo: o turno guarda o veículo ativo ao iniciar e o mantém mesmo se o veículo ativo mudar no meio", async () => {
  const app = novo();
  try {
    app.ev("definirVeiculoAtivo('v1')");
    principal(app);                                                        // inicia
    assert.equal(app.json("turnoAtual.veiculoId"), "v1");
    app.ev("definirVeiculoAtivo('v2')");                                   // troca de veículo no meio do turno
    principal(app);                                                        // encerra
    assert.equal(app.json("turnoEncerrado.veiculoId"), "v1");
    registrar(app);
    assert.equal(app.json("extras.turnos.length"), 1);
    assert.equal(app.json("extras.turnos[0].veiculoId"), "v1", "o turno é do veículo com que começou");
  } finally { app.fechar(); }
});

test("vínculo: sobrevive a recarregar o app (turno em andamento e turno aguardando o resumo)", async () => {
  const app = novo();
  try {
    app.ev("definirVeiculoAtivo('v2')"); principal(app);
    app.ev("carregarTurnoAtual()");
    assert.equal(app.json("turnoAtual.veiculoId"), "v2");
    app.ev("definirVeiculoAtivo('v1')"); principal(app);
    app.ev("carregarTurnoEncerrado()");
    assert.equal(app.json("turnoEncerrado.veiculoId"), "v2");
    registrar(app);
    assert.equal(app.json("extras.turnos[0].veiculoId"), "v2");
  } finally { app.fechar(); }
});

test("vínculo: turno em andamento criado antes da atualização (sem veiculoId) cai no veículo ativo ao registrar", async () => {
  const app = novo({ "motograna:turnoAtual": { inicio: Date.now() - 3600000, pausas: [] } });
  try {
    app.ev("definirVeiculoAtivo('v2')");
    principal(app); registrar(app);
    assert.equal(app.json("extras.turnos[0].veiculoId"), "v2");
  } finally { app.fechar(); }
});

test("vínculo: lançamento manual usa o veículo ativo", async () => {
  const app = novo();
  try {
    app.ev("definirVeiculoAtivo('v2')");
    preencher(app, { dataTurno: "2026-11-10", inicioTurno: "08:00", fimTurno: "12:00", ganhosTurno: 100, entregasTurno: 5 });
    app.ev("pausaPendente = 0"); await submit(app, "aoSalvarTurno");
    assert.equal(app.json("extras.turnos[0].veiculoId"), "v2");
  } finally { app.fechar(); }
});

test("vínculo: excluir um veículo preserva os turnos e só solta o vínculo (e avisa quantos)", async () => {
  const app = novo({ "motograna:turnos": [turno("t1", "v2"), turno("t2", "v2"), turno("t3", "v1")] });
  try {
    app.ev("definirVeiculoAtivo('v2')");
    app.ev("var __msg = ''; confirm = (m) => { __msg = m; return true; }; aoExcluirVeiculo()");
    assert.deepEqual(app.json("extras.veiculos.map((v) => v.id)"), ["v1"]);
    assert.equal(app.json("extras.turnos.length"), 3, "nenhum turno pode sumir");
    assert.deepEqual(app.json("extras.turnos.map((t) => t.veiculoId)"), [null, null, "v1"]);
    assert.match(app.json("__msg"), /2 turno\(s\)/);
    assert.deepEqual(JSON.parse(app.w.localStorage.getItem("motograna:turnos")).map((t) => t.veiculoId), [null, null, "v1"], "e o vínculo solto é gravado");
  } finally { app.fechar(); }
});

test("vínculo: não exclui o veículo de um turno em andamento nem de um turno aguardando o resumo", async () => {
  const app = novo();
  try {
    app.ev("definirVeiculoAtivo('v2')"); principal(app);
    app.ev("confirm = () => true; aoExcluirVeiculo()");
    assert.equal(app.json("extras.veiculos.length"), 2, "turno em andamento");
    principal(app);                                                        // encerrou, falta o resumo
    app.ev("aoExcluirVeiculo()");
    assert.equal(app.json("extras.veiculos.length"), 2, "turno aguardando o resumo");
    registrar(app);
    app.ev("aoExcluirVeiculo()");
    assert.equal(app.json("extras.veiculos.length"), 1, "depois de registrar, pode excluir");
    assert.equal(app.json("extras.turnos[0].veiculoId"), null);
  } finally { app.fechar(); }
});

test("vínculo: importar backup — o veículo padrão vazio sai e seus turnos ficam sem veículo; turno de veículo ausente também", async () => {
  const app = criarApp({ carregarSync: false, backup: null, seed: { ...SEED_BASE(), "motograna:veiculos": [veic("v1", { marca: "", kmAtual: 0 })], "motograna:turnos": [turno("t1", "v1")] } });
  try {
    const pacote = { app: "Movix", movimentacoes: [], veiculos: [veic("vX", { apelido: "CG" })], turnos: [turno("t2", "vX"), turno("t3", "fantasma")] };
    app.ev("importarExtras(" + JSON.stringify(pacote) + ")");
    assert.deepEqual(app.json("extras.veiculos.map((v) => v.id)"), ["vX"], "o padrão vazio dá lugar ao do backup");
    const por = (id) => app.json("extras.turnos.find((t) => t.id === '" + id + "').veiculoId");
    assert.equal(por("t1"), null, "turno do padrão que saiu");
    assert.equal(por("t2"), "vX", "turno importado com veículo que veio no backup");
    assert.equal(por("t3"), null, "turno importado de veículo que não veio");
  } finally { app.fechar(); }
});

test("vínculo: backup importado sem veículo nos turnos (versões antigas) continua válido", async () => {
  const app = novo();
  try {
    const antigo = turno("t9", undefined); delete antigo.veiculoId;
    app.ev("importarExtras(" + JSON.stringify({ app: "Movix", movimentacoes: [], turnos: [antigo] }) + ")");
    assert.equal(app.json("extras.turnos.length"), 1);
  } finally { app.fechar(); }
});

test("sync: o veículo do turno sobe como veiculo_id e volta como veiculoId em outro aparelho; id estranho vira nulo", async () => {
  const srv = new SupabaseFake();
  const A = appLogado(srv, "u1", { seed: { "motograna:veiculos": [V1(), V2()], "motograna:turnos": [turno("t1", "v2"), turno("t2", null), turno("t3", 123)] } });
  const B = appLogado(srv, "u1", { seed: { "motograna:veiculos": [], "motograna:turnos": [] } });
  try {
    await A.ocioso(); await A.sincronizarAgora();
    const linhas = srv.linhas("turnos", "u1");
    assert.equal(linhas.length, 3);
    const porId = Object.fromEntries(linhas.map((l) => [l.id, l.veiculo_id]));
    assert.deepEqual(porId, { t1: "v2", t2: null, t3: null });
    await B.ocioso(); await B.sincronizarAgora();
    const recebidos = Object.fromEntries(B.json("extras.turnos").map((t) => [t.id, t.veiculoId]));
    assert.deepEqual(recebidos, { t1: "v2", t2: null, t3: null });
    assert.ok(B.json("extras.veiculos.some((v) => v.id === 'v2')"), "o veículo chegou junto");
  } finally { A.fechar(); B.fechar(); }
});

test("sync: excluir o veículo solta o vínculo dos turnos também na nuvem e no outro aparelho", async () => {
  const srv = new SupabaseFake();
  const A = appLogado(srv, "u1", { seed: { "motograna:veiculos": [V1(), V2()], "motograna:turnos": [turno("t1", "v2"), turno("t2", "v1")] } });
  const B = appLogado(srv, "u1", { seed: { "motograna:veiculos": [], "motograna:turnos": [] } });
  try {
    await A.ocioso(); await A.sincronizarAgora(); await B.ocioso(); await B.sincronizarAgora();
    A.ev("definirVeiculoAtivo('v2'); confirm = () => true; aoExcluirVeiculo()");
    await A.sincronizarAgora();
    const nuvem = Object.fromEntries(srv.linhas("turnos", "u1").map((l) => [l.id, l.veiculo_id]));
    assert.deepEqual(nuvem, { t1: null, t2: "v1" });
    assert.ok(srv.linhas("veiculos", "u1").find((l) => l.id === "v2").deleted_at, "o veículo foi excluído (lógico) na nuvem");
    await B.sincronizarAgora();
    assert.deepEqual(Object.fromEntries(B.json("extras.turnos").map((t) => [t.id, t.veiculoId])), { t1: null, t2: "v1" });
    assert.equal(B.json("extras.turnos.length"), 2, "nenhum turno some no outro aparelho");
    assert.equal(B.json("extras.veiculos.some((v) => v.id === 'v2')"), false);
  } finally { A.fechar(); B.fechar(); }
});

test("histórico: identifica o veículo de cada jornada e sinaliza jornadas sem vínculo", async () => {
  const app = novo({ "motograna:turnos": [turno("t1", "v2"), turno("t2", null)] });
  try {
    app.ev("renderizarTurnos()");
    const linhas = app.w.document.getElementById("listaTurnos").textContent;
    assert.match(linhas, /Moto 2/);
    assert.match(linhas, /Sem veículo associado/);
  } finally { app.fechar(); }
});
