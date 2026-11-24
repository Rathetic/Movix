"use strict";
/* Km automático pelo GPS: o app REAL (script.js) num jsdom, com um navigator.geolocation simulado. */
const test = require("node:test"); const assert = require("node:assert/strict");
const { criarApp, SEED_BASE } = require("./_app");
const novo = (seed = {}) => criarApp({ carregarSync: false, backup: null, seed: { ...SEED_BASE(), ...seed } });
const texto = (app, id) => app.w.document.getElementById(id).textContent;
const valor = (app, id) => app.w.document.getElementById(id).value;

function geoFalso(app) {
  const g = { ativos: 0, limpos: 0, ok: null, err: null, opcoes: null,
    watchPosition(ok, err, opcoes) { this.ativos++; this.ok = ok; this.err = err; this.opcoes = opcoes; return 7; },
    clearWatch() { this.limpos++; } };
  Object.defineProperty(app.w.navigator, "geolocation", { value: g, configurable: true });
  return g;
}
// 0,001° de latitude ≈ 111,2 m
const ponto = (i, t0, extra = {}) => ({ lat: -22.4 + i * 0.001, lon: -43.6, prec: 5, t: t0 + i * 10000, ...extra });
const reg = (app, p) => app.ev("registrarPontoGps(" + JSON.stringify(p) + ")");
const iniciarTurno = (app) => app.ev("aoClicarTurnoPrincipal()");
const encerrarTurno = (app) => app.ev("aoClicarTurnoPrincipal()");

test("km auto: iniciar turno liga o GPS, soma o trajeto e encerrar já preenche o km do resumo", async () => {
  const app = novo();
  try {
    const geo = geoFalso(app);
    iniciarTurno(app);
    assert.equal(geo.ativos, 1);
    assert.equal(geo.opcoes.enableHighAccuracy, true);
    const t0 = Date.now();
    for (let i = 0; i <= 10; i++) geo.ok({ coords: { latitude: ponto(i, t0).lat, longitude: ponto(i, t0).lon, accuracy: 5 }, timestamp: ponto(i, t0).t });
    const m = app.json("turnoAtual.gps.m");
    assert.ok(m > 1100 && m < 1125, "esperava ~1,11 km, veio " + m);
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /1,1 km/);
    assert.match(texto(app, "kmTurnoAoVivo"), /GPS ativo/);
    encerrarTurno(app);
    assert.equal(geo.limpos, 1, "encerrar deve parar o GPS");
    assert.equal(app.json("turnoAtual"), null);
    assert.equal(app.json("turnoEncerrado.kmAuto"), 1.1);
    assert.equal(valor(app, "kmResumo"), "1.1");
    assert.match(texto(app, "notaEncerramento"), /Km medido pelo GPS: 1,1 km/);
    // registrar o turno grava o km
    app.w.document.getElementById("ganhosResumo").value = "50";
    app.w.document.getElementById("entregasResumo").value = "5";
    app.ev("registrarTurnoEncerrado(false)");
    assert.equal(app.json("extras.turnos[extras.turnos.length-1].km"), 1.1);
  } finally { app.fechar(); }
});

test("km auto: ignora sinal ruim, GPS parado (ruído) e salto impossível", async () => {
  const app = novo();
  try {
    geoFalso(app); iniciarTurno(app);
    const t0 = Date.now();
    reg(app, ponto(0, t0));
    reg(app, { ...ponto(1, t0), prec: 80 });                              // precisão ruim
    assert.equal(app.json("turnoAtual.gps.m"), 0);
    for (let i = 1; i <= 8; i++) reg(app, { lat: -22.4 + (i % 2) * 0.00003, lon: -43.6, prec: 10, t: t0 + i * 5000 });   // ~3 m de ruído parado
    assert.equal(app.json("turnoAtual.gps.m"), 0, "parado não pode somar km");
    reg(app, { lat: -21.5, lon: -43.6, prec: 5, t: t0 + 60000 });          // ~100 km em 20 s
    assert.equal(app.json("turnoAtual.gps.m"), 0, "salto falso ignorado");
    reg(app, ponto(2, t0, { t: t0 + 70000 }));                             // volta ao normal (~220 m em 10 s)
    assert.ok(app.json("turnoAtual.gps.m") > 200 && app.json("turnoAtual.gps.m") < 240);
  } finally { app.fechar(); }
});

test("km auto: pausa não conta; ao retomar o primeiro ponto só marca a partida", async () => {
  const app = novo();
  try {
    const geo = geoFalso(app); iniciarTurno(app);
    const t0 = Date.now();
    reg(app, ponto(0, t0)); reg(app, ponto(1, t0));
    const antes = app.json("turnoAtual.gps.m");
    assert.ok(antes > 100);
    app.ev("aoClicarPausa()");
    assert.equal(geo.limpos, 1, "pausar para o GPS");
    reg(app, ponto(5, t0));                                                // chegou ponto durante a pausa: ignorado
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /GPS em pausa/);
    app.ev("aoClicarPausa()");
    assert.equal(geo.ativos, 2, "retomar liga o GPS de novo");
    reg(app, ponto(20, t0, { t: t0 + 300000 }));                           // 2 km depois, no fim da pausa: só vira ponto de partida
    assert.equal(app.json("turnoAtual.gps.m"), antes);
    reg(app, ponto(21, t0, { t: t0 + 310000 }));
    assert.ok(app.json("turnoAtual.gps.m") > antes + 100);
  } finally { app.fechar(); }
});

test("km auto: lacuna longa (app em segundo plano) soma a reta e avisa que o km pode estar menor", async () => {
  const app = novo();
  try {
    geoFalso(app); iniciarTurno(app);
    const t0 = Date.now();
    reg(app, ponto(0, t0));
    reg(app, { lat: -22.4 + 0.045, lon: -43.6, prec: 8, t: t0 + 600000 });   // ~5 km em 10 min sem pontos
    const m = app.json("turnoAtual.gps.m");
    assert.ok(m > 4900 && m < 5100, "veio " + m);
    assert.equal(app.json("turnoAtual.gps.lacuna"), true);
    encerrarTurno(app);
    assert.equal(app.json("turnoEncerrado.kmLacuna"), true);
    assert.match(texto(app, "notaEncerramento"), /pode estar menor que o real/);
  } finally { app.fechar(); }
});

test("km auto: parado por muito tempo (sem pontos) NÃO gera aviso de lacuna", async () => {
  const app = novo();
  try {
    geoFalso(app); iniciarTurno(app);
    const t0 = Date.now();
    reg(app, ponto(0, t0));
    reg(app, { lat: -22.4 + 0.00002, lon: -43.6, prec: 8, t: t0 + 900000 });
    assert.equal(app.json("turnoAtual.gps.lacuna"), false);
  } finally { app.fechar(); }
});

test("km auto: permissão negada avisa, para o GPS e o km continua manual", async () => {
  const app = novo();
  try {
    const geo = geoFalso(app); iniciarTurno(app);
    geo.err({ code: 1 });
    assert.equal(geo.limpos, 1);
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /negada/);
    encerrarTurno(app);
    assert.equal(app.json("turnoEncerrado.kmAuto"), undefined);
    assert.equal(valor(app, "kmResumo"), "");
  } finally { app.fechar(); }
});

test("km auto: aparelho sem GPS não quebra nada (turno funciona como antes)", async () => {
  const app = novo();
  try {
    Object.defineProperty(app.w.navigator, "geolocation", { value: undefined, configurable: true });
    iniciarTurno(app);
    assert.ok(app.json("turnoAtual.inicio") > 0);
    app.ev("renderizarTurnoAtual()");
    assert.match(texto(app, "kmTurnoAoVivo"), /indisponível/);
    encerrarTurno(app);
    assert.equal(valor(app, "kmResumo"), "");
  } finally { app.fechar(); }
});

test("km auto: o total sobrevive a recarregar o app (turnoAtual salvo) e o turno encerrado guarda o km", async () => {
  const inicio = Date.now() - 3600000;
  const app = novo({ "motograna:turnoAtual": { inicio, pausas: [], gps: { m: 2500, ult: null, lacuna: false } } });
  try {
    assert.equal(app.json("turnoAtual.gps.m"), 2500);
    encerrarTurno(app);
    assert.equal(app.json("turnoEncerrado.kmAuto"), 2.5);
    const guardado = app.lsJson("motograna:turnoEncerrado");
    assert.equal(guardado.kmAuto, 2.5);
    app.ev("carregarTurnoEncerrado()");                                    // recarregar não pode perder o km
    assert.equal(app.json("turnoEncerrado.kmAuto"), 2.5);
  } finally { app.fechar(); }
});

test("km auto: turno antigo salvo SEM o bloco gps continua funcionando", async () => {
  const app = novo({ "motograna:turnoAtual": { inicio: Date.now() - 600000, pausas: [] } });
  try {
    assert.equal(app.json("turnoAtual.gps.m"), 0);
    encerrarTurno(app);
    assert.equal(app.json("turnoEncerrado.kmAuto"), undefined);
  } finally { app.fechar(); }
});

test("km auto: não guarda o trajeto, só o total e o último ponto", async () => {
  const app = novo();
  try {
    geoFalso(app); iniciarTurno(app);
    const t0 = Date.now();
    for (let i = 0; i <= 5; i++) reg(app, ponto(i, t0));
    app.ev("salvarTurnoAtual()");
    const salvo = app.lsJson("motograna:turnoAtual");
    assert.deepEqual(Object.keys(salvo.gps).sort(), ["lacuna", "m", "ult"]);
    assert.ok(JSON.stringify(salvo).length < 400, "o turno salvo deve continuar pequeno");
  } finally { app.fechar(); }
});
