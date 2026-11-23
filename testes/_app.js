/* Carrega o aplicativo REAL (config.js, script.js, auth.js, sync.js e, opcionalmente, backup-local.js) num jsdom,
   com Supabase simulado. Use MOVIX_RAIZ=/caminho para rodar a mesma suíte contra outra versão (ex.: a original). */
"use strict";
const { JSDOM } = require("jsdom");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { SupabaseFake } = require("./_supabase_fake");

const RAIZ = process.env.MOVIX_RAIZ ? path.resolve(process.env.MOVIX_RAIZ) : path.resolve(__dirname, "..");
const ler = (n) => fs.readFileSync(path.join(RAIZ, n), "utf8");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* MovixBackup de mentira, com o mesmo contrato público do backup-local.js que o sync.js usa. */
function backupFalso(estadoInicial) {
  const B = {
    autorizada: estadoInicial !== false, consultas: 0, garantirChamadas: [], proximoGarantir: { ok: true },
    syncAutorizada() { this.consultas++; return this.autorizada === true; },
    async garantir(op) { this.garantirChamadas.push(op); const r = typeof this.proximoGarantir === "function" ? this.proximoGarantir(op) : this.proximoGarantir; if (r.ok && op && op.origem === "pre_ativacao_sync") this.autorizada = true; return r; },
    async protegerOperacao(origem, d) { const r = await this.garantir({ origem, motivo: d }); return r.ok; },
    async garantirAtivacaoSync(motivo) { const r = await this.garantir({ origem: "pre_ativacao_sync", motivo }); return r.ok ? r : { ok: false, motivo: r.motivo || "falha" }; },
    pronto() { return Promise.resolve(true); }, appCarregado() {}, aguardarInicio() { return Promise.resolve("ok"); },
    estado() { return { protecao: { estado: this.autorizada ? "concluida" : "pendente" } }; }
  };
  return B;
}

function criarApp(opcoes = {}) {
  const { seed = {}, sessao = null, sync = null, backup = "autorizado", servidor = new SupabaseFake(), confirmar = () => true, carregarSync = true, config = true } = opcoes;
  const html = ler("index.html").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 10 }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  w.Element.prototype.scrollIntoView = () => {};
  w.scrollTo = () => {};
  Object.defineProperty(w, "crypto", { value: require("crypto").webcrypto, configurable: true });
  const timers = new Set(), si = w.setInterval.bind(w), st = w.setTimeout.bind(w);
  w.setInterval = (f, ms, ...a) => { const id = si(f, ms, ...a); timers.add(id); return id; };
  w.setTimeout = (f, ms, ...a) => { const id = st(f, ms, ...a); timers.add(id); return id; };
  const dialogos = [];
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.confirm = (t) => { dialogos.push(String(t)); return typeof confirmar === "function" ? confirmar(String(t)) : confirmar; };
  w.fetch = (url, o) => servidor.fetch(url, o);
  Object.defineProperty(w.navigator, "onLine", { get: () => app.online, configurable: true });

  Object.keys(seed).forEach((k) => w.localStorage.setItem(k, typeof seed[k] === "string" ? seed[k] : JSON.stringify(seed[k])));
  if (sessao) w.localStorage.setItem("movix:sessao", JSON.stringify(sessao));
  if (sync) w.localStorage.setItem("movix:sync", JSON.stringify(sync));
  const contexto = dom.getInternalVMContext();
  const rodar = (codigo, nome) => new vm.Script(codigo, { filename: nome || "teste.js" }).runInContext(contexto);

  const app = {
    w, servidor, dialogos, online: true, contexto, raiz: RAIZ,
    ev: (c) => rodar(c), json: (c) => { const v = JSON.stringify(rodar("(" + c + ")")); return v === undefined ? undefined : JSON.parse(v); },
    ls: (k) => w.localStorage.getItem(k), lsJson: (k) => JSON.parse(w.localStorage.getItem(k)),
    espera,
    async ocioso(limite = 8000) { const t0 = Date.now(); for (;;) { await espera(15); let s = false; try { s = rodar("sincronizando"); } catch (e) { /* ainda não existe */ } if (!s) { await espera(25); try { if (!rodar("sincronizando")) return; } catch (e) { return; } } if (Date.now() - t0 > limite) throw new Error("sincronização não terminou"); } },
    async sincronizarAgora() { await rodar("sincronizar()"); await this.ocioso(); },
    fechar() { const fim = () => { timers.forEach((id) => { try { w.clearInterval(id); w.clearTimeout(id); } catch (e) { /* ignora */ } }); try { w.close(); } catch (e) { /* ignora */ } }; setTimeout(fim, 250).unref(); }
  };
  if (backup === "autorizado") app.backup = backupFalso(true);
  else if (backup === "pendente") app.backup = backupFalso(false);
  else if (backup && typeof backup === "object") app.backup = backup;
  if (app.backup) w.MovixBackup = app.backup;

  if (config) rodar(ler("config.js"), "config.js");
  rodar(ler("script.js"), "script.js");
  rodar(ler("auth.js"), "auth.js");
  if (carregarSync) rodar(ler("sync.js"), "sync.js");
  return app;
}

/* dados de exemplo (formato local válido) */
const mov = (i, extra = {}) => ({ id: "m" + String(i).padStart(5, "0"), descricao: "x" + i, tipo: "ganho", categoria: "Outros", valor: 10 + (i % 7), data: "2026-11-" + String((i % 27) + 1).padStart(2, "0"), ...extra });
const veic = (id = "v1", extra = {}) => ({ id, tipo: "moto", marca: "Honda", modelo: "CG", ano: "2020", placa: "ABC1D23", apelido: "Minha moto", kmAtual: 1000, ...extra });
const SEED_BASE = () => ({ "motograna:movimentacoes": [], "motograna:combustivel": [], "motograna:manutencoes": [], "motograna:turnos": [], "motograna:objetivos": [], "motograna:veiculos": [veic()] });

/* app já com sessão do usuário e sincronização ativa (sem snapshot: tudo local é "novo") */
function appLogado(servidor, uid = "u1", extra = {}) {
  const s = servidor.usuario(uid);
  const seed = { ...SEED_BASE(), ...(extra.seed || {}) };
  const sync = extra.sync === null ? null : { ativo: true, usuario: uid, ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao: null, ...(extra.sync || {}) };
  return criarApp({ ...extra, servidor, seed, sessao: s, sync });
}
module.exports = { criarApp, appLogado, backupFalso, mov, veic, SEED_BASE, espera, RAIZ };
