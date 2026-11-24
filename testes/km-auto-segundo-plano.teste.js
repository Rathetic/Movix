"use strict";
/* Km automático no app Android: serviço nativo (BackgroundGeolocation) simulado, lido pelo log do aparelho. */
const test = require("node:test"); const assert = require("node:assert/strict");
const { criarApp, SEED_BASE } = require("./_app");
const novo = (seed = {}) => criarApp({ carregarSync: false, backup: null, seed: { ...SEED_BASE(), ...seed } });
const texto = (app, id) => app.w.document.getElementById(id).textContent;

function pluginFalso(app, disponivel = true) {
  const bg = { iniciado: 0, parado: 0, opcoes: null, cb: null, limpezas: [], log: [], proximoId: 1, falhaStart: false,
    async start(op, cb) { this.iniciado++; this.opcoes = op; this.cb = cb; if (this.falhaStart) throw new Error("nao instalado"); },
    async stop() { this.parado++; },
    async getLocationLog(op = {}) { return { entries: this.log.filter((x) => x.id > (op.afterId || 0)).slice(0, op.limit || 1000) }; },
    async clearLocationLog(op = {}) { this.limpezas.push(op.upToId); this.log = this.log.filter((x) => op.upToId !== undefined && x.id > op.upToId); },
    add(i, t0, extra = {}) { this.log.push({ id: this.proximoId++, latitude: -22.4 + i * 0.001, longitude: -43.6, accuracy: 5, time: t0 + i * 10000, ...extra }); } };
  app.w.Capacitor = { isNativePlatform: () => true, isPluginAvailable: (n) => disponivel && n === "BackgroundGeolocation", registerPlugin: () => bg };
  return bg;
}
const iniciarTurno = (app) => app.ev("aoClicarTurnoPrincipal()");
const km = (app) => app.json("turnoAtual.gps.m");

test("segundo plano: usa o serviço nativo (com log), não o GPS do navegador", async () => {
  const app = novo();
  try {
    let web = 0;
    Object.defineProperty(app.w.navigator, "geolocation", { value: { watchPosition() { web++; return 1; }, clearWatch() {} }, configurable: true });
    const bg = pluginFalso(app);
    iniciarTurno(app);
    await app.espera(20);
    assert.equal(bg.iniciado, 1); assert.equal(web, 0);
    assert.equal(bg.opcoes.locationLog, true);
    assert.equal(bg.opcoes.requestPermissions, true);
    assert.ok(bg.opcoes.backgroundMessage && bg.opcoes.backgroundTitle, "a notificação do serviço precisa de título e texto");
  } finally { app.fechar(); }
});

test("segundo plano: lê o log em ordem, soma os km e limpa o que leu (sem contar duas vezes)", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    const t0 = Date.now();
    for (let i = 0; i <= 10; i++) bg.add(i, t0);
    await app.ev("lerLogGps()");
    const m = km(app);
    assert.ok(m > 1100 && m < 1125, "veio " + m);
    assert.deepEqual(bg.limpezas.slice(-1), [11]);
    await app.ev("lerLogGps()"); await app.ev("lerLogGps()");
    assert.equal(km(app), m, "ler de novo não pode somar de novo");
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /GPS ativo/);
  } finally { app.fechar(); }
});

test("segundo plano: pontos de antes do turno ficam de fora", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    const inicio = app.json("turnoAtual.inicio");
    for (let i = 0; i < 6; i++) bg.add(i, inicio - 3600000);              // gravados na hora anterior
    await app.ev("lerLogGps()");
    assert.equal(km(app), 0);
    assert.ok(bg.limpezas.length >= 1, "mesmo ignorados, saem do log");
  } finally { app.fechar(); }
});

test("segundo plano: pausar lê antes os últimos pontos, depois para o serviço", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    const t0 = Date.now();
    for (let i = 0; i <= 5; i++) bg.add(i, t0);                           // ainda não lidos
    app.ev("aoClicarPausa()");
    await app.espera(50);
    assert.ok(km(app) > 500, "os pontos pendentes precisam entrar antes da pausa: " + km(app));
    assert.equal(bg.parado, 1);
    assert.equal(app.json("emPausa()"), true);
    app.ev("aoClicarPausa()"); await app.espera(30);
    assert.equal(bg.iniciado, 2, "retomar liga o serviço de novo");
  } finally { app.fechar(); }
});

test("segundo plano: encerrar lê os últimos pontos e o resumo já vem com o km", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    const t0 = Date.now();
    for (let i = 0; i <= 10; i++) bg.add(i, t0);
    app.ev("aoClicarTurnoPrincipal()");
    await app.espera(50);
    assert.equal(app.json("turnoAtual"), null);
    assert.equal(app.json("turnoEncerrado.kmAuto"), 1.1);
    assert.equal(app.w.document.getElementById("kmResumo").value, "1.1");
    assert.equal(bg.parado, 1);
  } finally { app.fechar(); }
});

test("segundo plano: voltar ao app (visibilitychange) recupera os pontos do segundo plano", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    const t0 = Date.now();
    for (let i = 0; i <= 10; i++) bg.add(i, t0);
    app.w.document.dispatchEvent(new app.w.Event("visibilitychange"));
    await app.espera(50);
    assert.ok(km(app) > 1100, "veio " + km(app));
  } finally { app.fechar(); }
});

test("segundo plano: reabrir o app com turno em andamento retoma o serviço e recupera o que ficou no log", async () => {
  const inicio = Date.now() - 1800000;
  const app = novo({ "motograna:turnoAtual": { inicio, pausas: [], gps: { m: 1000, ult: null, lacuna: false } } });
  try {
    const bg = pluginFalso(app);
    app.ev("iniciarGps()");                                               // o que iniciarExtras faz ao abrir o app
    for (let i = 0; i <= 5; i++) bg.add(i, Date.now() - 600000);
    await app.espera(60);
    assert.equal(bg.iniciado, 1);
    assert.ok(km(app) >= 1000);
    await app.ev("lerLogGps()");
    assert.ok(km(app) > 1400, "veio " + km(app));
  } finally { app.fechar(); }
});

test("segundo plano: permissão negada para o serviço e deixa o km manual", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); iniciarTurno(app); await app.espera(20);
    bg.cb(undefined, { code: "NOT_AUTHORIZED" });
    assert.equal(bg.parado, 1);
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /negada/);
  } finally { app.fechar(); }
});

test("segundo plano: se o plugin falhar ao iniciar, avisa e o turno segue normal", async () => {
  const app = novo();
  try {
    const bg = pluginFalso(app); bg.falhaStart = true;
    iniciarTurno(app); await app.espera(30);
    assert.ok(app.json("turnoAtual.inicio") > 0);
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /indisponível/);
  } finally { app.fechar(); }
});

test("segundo plano: plugin não instalado no aparelho cai no GPS comum", async () => {
  const app = novo();
  try {
    let web = 0;
    Object.defineProperty(app.w.navigator, "geolocation", { value: { watchPosition() { web++; return 1; }, clearWatch() {} }, configurable: true });
    const bg = pluginFalso(app, false);
    iniciarTurno(app);
    assert.equal(web, 1); assert.equal(bg.iniciado, 0);
  } finally { app.fechar(); }
});
