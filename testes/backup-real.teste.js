/* Integração com o backup-local.js REAL (IndexedDB simulado por fake-indexeddb, Web Locks simulado) + sync.js real. */
"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const fs = require("fs"); const path = require("path");
const { SupabaseFake } = require("./_supabase_fake"); const { criarApp, SEED_BASE, mov, espera, RAIZ } = require("./_app");

class Locks {
  constructor() { this.held = []; this.fila = []; }
  request(name, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    const modo = opts.mode || "exclusive";
    return new Promise((resolve, reject) => {
      const tentar = () => {
        if (this.held.some((h) => h.name === name && (modo === "exclusive" || h.mode === "exclusive"))) { if (opts.ifAvailable) { Promise.resolve(cb(null)).then(resolve, reject); return true; } return false; }
        const h = { name, mode: modo }; this.held.push(h);
        const fim = () => { this.held.splice(this.held.indexOf(h), 1); this.fila = this.fila.filter((t) => !t()); };
        Promise.resolve(cb({ name, mode: modo })).then((r) => { fim(); resolve(r); }, (e) => { fim(); reject(e); }); return true;
      };
      if (!tentar()) this.fila.push(tentar);
    });
  }
}

/* aba completa: backup-local.js primeiro, depois o "carregador" do index.html (aguardarInicio -> scripts do app -> appCarregado) */
/* versão direta: monta a janela na ordem real */
const { JSDOM } = require("jsdom"); const vm = require("vm");
async function aba(opc) {
  const { srv, hook, locks = new Locks(), idb = new IDBFactory(), semLocks = false, seed = {}, syncAtivo = true, ls = null } = opc;
  const tok = srv.usuario("u1");
  const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window, ctx = dom.getInternalVMContext(), rodar = (c, n) => new vm.Script(c, { filename: n || "t.js" }).runInContext(ctx);
  const cv = new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : () => {}), set: () => true });
  w.HTMLCanvasElement.prototype.getContext = () => cv; w.HTMLDialogElement.prototype.showModal = function () {}; w.Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto, configurable: true });
  Object.defineProperty(w, "indexedDB", { value: idb, configurable: true }); w.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(w.navigator, "locks", { value: semLocks ? undefined : locks, configurable: true });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.structuredClone = w.structuredClone || structuredClone;
  w.confirm = () => true; w.fetch = (u, o) => srv.fetch(u, o);
  const dados = ls || { ...Object.fromEntries(Object.entries({ ...SEED_BASE(), ...seed }).map(([k, v]) => [k, JSON.stringify(v)])), "movix:sessao": JSON.stringify(tok), ...(syncAtivo ? { "movix:sync": JSON.stringify({ ativo: true, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao: null }) } : {}) };
  Object.entries(dados).forEach(([k, v]) => w.localStorage.setItem(k, v));
  if (hook) w.__MOVIX_TESTE_BACKUP = hook;
  rodar(fs.readFileSync(path.join(RAIZ, "config.js"), "utf8"), "config.js"); rodar(fs.readFileSync(path.join(RAIZ, "backup-local.js"), "utf8"), "backup-local.js");
  const a = { w, ctx, srv, locks, idb, rodar, ev: (c) => rodar(c), json: (c) => JSON.parse(JSON.stringify(rodar("(" + c + ")"))), appRodou: false,
    estado: () => JSON.parse(JSON.stringify(w.MovixBackup.estado())), fechar() { setTimeout(() => { try { w.close(); } catch (e) { /* */ } }, 100).unref(); } };
  const r = await Promise.race([w.MovixBackup.aguardarInicio(), espera(1500).then(() => "sem_resposta")]);
  if (r === "ok") { ["script.js", "auth.js", "sync.js"].forEach((f) => rodar(fs.readFileSync(path.join(RAIZ, f), "utf8"), f)); a.appRodou = true; w.MovixBackup.appCarregado(); }
  a.resultadoInicio = r; return a;
}
const rests = (srv) => srv.requisicoes.filter((r) => r.tabela && r.tabela !== "migracoes");
const esperarAte = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("tempo esgotado"); await espera(50); } };

test("real: snapshot inicial concluído ANTES de qualquer sincronização; depois a sincronização acontece sozinha", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, hook: { atrasoGravacaoMs: 1500 }, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  try {
    assert.equal(a.resultadoInicio, "ok"); await espera(500);
    assert.equal(a.estado().protecao.estado, "pendente"); assert.equal(rests(srv).length, 0, "sincronizou antes do snapshot");
    await esperarAte(() => a.estado().protecao.estado === "concluida");
    const tConcl = a.estado().marcos.snapshotInicialEm;
    await esperarAte(() => rests(srv).length > 0); assert.ok(srv.requisicoes.find((r) => r.tabela && r.tabela !== "migracoes").n > 0);
    await esperarAte(() => srv.linhas("movimentacoes", "u1").length === 2);
    assert.ok(Date.now() >= tConcl);
  } finally { a.fechar(); }
});
test("real: snapshot inicial FALHOU => sincronização permanece bloqueada (app segue local)", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, hook: { falharGravacao: "inicializacao" }, seed: { "motograna:movimentacoes": [mov(1)] } });
  try {
    await esperarAte(() => a.estado().protecao.estado === "falhou"); await a.ev("sincronizar()"); await espera(500);
    assert.equal(rests(srv).length, 0); assert.equal(a.json("movimentacoes.length"), 1);
  } finally { a.fechar(); }
});
test("real: IndexedDB indisponível => bloqueia a sincronização", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, hook: { falharAbrirBanco: true }, seed: { "motograna:movimentacoes": [mov(1)] } });
  try { await esperarAte(() => a.estado().protecao.estado === "indisponivel"); await a.ev("sincronizar()"); await espera(500); assert.equal(rests(srv).length, 0); } finally { a.fechar(); }
});
test("real: Web Locks indisponível => o app nem inicia e nada vai à rede", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, semLocks: true, seed: { "motograna:movimentacoes": [mov(1)] } });
  try { assert.notEqual(a.resultadoInicio, "ok"); assert.equal(a.appRodou, false); await espera(400); assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0); assert.equal(a.w.MovixBackup.syncAutorizada(), false); } finally { a.fechar(); }
});
test("real: recuperação pendente => sincronização bloqueada e ativação manual recusada", async () => {
  const srv = new SupabaseFake(); const tok = srv.usuario("u1");
  const a = await aba({ srv, seed: { "motograna:movimentacoes": [mov(1)] }, syncAtivo: false });
  try {
    await esperarAte(() => a.estado().protecao.estado === "concluida");
    a.w.localStorage.setItem("movix:backup-recuperacao", JSON.stringify({ estado: "pendente", motivo: "teste" }));
    assert.equal(a.w.MovixBackup.syncAutorizada(), false);
    const r = await a.w.MovixBackup.garantirAtivacaoSync("x"); assert.equal(r.ok, false);
    a.w.localStorage.setItem("movix:sync", JSON.stringify({ ativo: true, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao: null })); a.ev("carregarEstadoSync()");
    srv.requisicoes.length = 0; await a.ev("sincronizar()"); await espera(300); assert.equal(rests(srv).length, 0);
    a.w.localStorage.removeItem("movix:backup-recuperacao");     // condições restabelecidas => retoma sozinho
    await esperarAte(() => rests(srv).length > 0, 8000);
  } finally { a.fechar(); }
});
test("real: ativação manual libera a sincronização depois de falha do snapshot inicial (pre_ativacao_sync)", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, hook: { falharGravacao: "inicializacao" }, seed: { "motograna:movimentacoes": [mov(1)] }, syncAtivo: false });
  try {
    await esperarAte(() => a.estado().protecao.estado === "falhou");
    await a.ev("ativarSincronizacao()"); await esperarAte(() => srv.linhas("movimentacoes", "u1").length === 1);
    assert.equal(a.estado().protecao.estado, "concluida"); assert.equal(a.estado().protecao.origem, "pre_ativacao_sync");
    const lista = await a.w.MovixBackup.listar(); assert.ok(lista.some((s) => s.origem === "pre_ativacao_sync"));
  } finally { a.fechar(); }
});
test("real: importar backup chama o módulo com origem pre_importacao ANTES de alterar os dados", async () => {
  const srv = new SupabaseFake(); const a = await aba({ srv, seed: { "motograna:movimentacoes": [mov(1)] }, syncAtivo: false });
  try {
    await esperarAte(() => a.estado().protecao.estado === "concluida");
    a.ev("window.__chamadas = []; const orig = MovixBackup.protegerOperacao; MovixBackup.protegerOperacao = async function (o, d) { const n = movimentacoes.length; const r = await orig.call(this, o, d); window.__chamadas.push({ o, antes: n, depois: movimentacoes.length, r }); return r; }");
    a.ev("importarBackup(new Blob([" + JSON.stringify(JSON.stringify({ app: "Movix", movimentacoes: [mov(2), mov(3)] })) + "]))");
    await esperarAte(() => a.json("movimentacoes.length") === 3);
    const c = a.json("window.__chamadas"); assert.equal(c.length, 1); assert.equal(c[0].o, "pre_importacao"); assert.equal(c[0].antes, 1); assert.equal(c[0].depois, 1, "dados mudaram antes do snapshot"); assert.equal(c[0].r, true);
    const snaps = await a.w.MovixBackup.listar(); assert.ok(snaps.some((x) => x.contagens["motograna:movimentacoes"] === 1), "nenhum snapshot guarda o estado anterior");
  } finally { a.fechar(); }
});
test("real: duas abas concorrentes participam do mesmo lock e ambas só sincronizam depois do próprio snapshot", async () => {
  const srv = new SupabaseFake(); const locks = new Locks(), idb = new IDBFactory();
  const A = await aba({ srv, locks, idb, seed: { "motograna:movimentacoes": [mov(1)] } });
  const B = await aba({ srv, locks, idb, seed: { "motograna:movimentacoes": [mov(1)] } });
  try {
    assert.equal(A.resultadoInicio, "ok"); assert.equal(B.resultadoInicio, "ok");
    await esperarAte(() => A.estado().protecao.estado === "concluida" && B.estado().protecao.estado === "concluida");
    await esperarAte(() => srv.linhas("movimentacoes", "u1").length === 1);
    assert.equal(srv.linhas("movimentacoes", "u1").length, 1, "duplicou entre abas");
  } finally { A.fechar(); B.fechar(); }
});
