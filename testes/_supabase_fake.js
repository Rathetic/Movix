/* Supabase simulado (PostgREST + Auth) para os testes do Movix.
   Só implementa o que o aplicativo usa: select/order/limit, filtros eq/neq/gt/gte/lt/lte/in/is, or=(...and(...)),
   POST (upsert com on_conflict), PATCH (return=minimal|representation), RLS por usuário (user_id) e falhas injetáveis.
   NÃO executa nada em banco real. */
"use strict";

const normTs = (s) => {                       // "2026-11-20T10:00:00.123456+00:00" | "...Z" -> comparável (UTC, 6 casas)
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(String(s));
  if (!m) return String(s);
  const base = new Date(Date.parse(m[1] + (m[3] || "Z"))).toISOString().slice(0, 19);
  return base + "." + (m[2] || "").padEnd(6, "0").slice(0, 6);
};
const ehTs = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
const cmp = (a, b) => {
  if (ehTs(a) && ehTs(b)) { a = normTs(a); b = normTs(b); }
  return a < b ? -1 : a > b ? 1 : 0;
};

function dividirTopo(texto) {                  // separa por vírgula respeitando parênteses e aspas
  const out = []; let nivel = 0, aspas = false, atual = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === "\\" && aspas) { atual += c + texto[++i]; continue; }
    if (c === '"') aspas = !aspas;
    if (!aspas && c === "(") nivel++;
    if (!aspas && c === ")") nivel--;
    if (!aspas && nivel === 0 && c === ",") { out.push(atual); atual = ""; continue; }
    atual += c;
  }
  if (atual) out.push(atual);
  return out;
}
const desaspar = (v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

function avaliarCondicao(linha, col, op, valor) {
  const v = linha[col];
  switch (op) {
    case "eq": return v !== undefined && v !== null && cmp(v, valor) === 0;
    case "neq": return !(v !== undefined && v !== null && cmp(v, valor) === 0);
    case "gt": return v != null && cmp(v, valor) > 0;
    case "gte": return v != null && cmp(v, valor) >= 0;
    case "lt": return v != null && cmp(v, valor) < 0;
    case "lte": return v != null && cmp(v, valor) <= 0;
    case "in": return dividirTopo(valor.replace(/^\(|\)$/g, "")).map(desaspar).includes(String(v));
    case "is": return valor === "null" ? v == null : v != null;
    default: throw new Error("operador não suportado no simulador: " + op);
  }
}
function avaliarNo(linha, no) {                // no: "col.op.valor" | "and(...)" | "or(...)"
  let m = /^(and|or)\((.*)\)$/s.exec(no);
  if (m) { const filhos = dividirTopo(m[2]); return m[1] === "and" ? filhos.every((f) => avaliarNo(linha, f)) : filhos.some((f) => avaliarNo(linha, f)); }
  const i1 = no.indexOf("."), i2 = no.indexOf(".", i1 + 1);
  return avaliarCondicao(linha, no.slice(0, i1), no.slice(i1 + 1, i2), desaspar(no.slice(i2 + 1)));
}
function avaliarFiltro(linha, chave, valor) {
  if (chave === "or") return avaliarNo(linha, "or" + valor);
  if (chave === "and") return avaliarNo(linha, "and" + valor);
  const i = valor.indexOf(".");
  return avaliarCondicao(linha, chave, valor.slice(0, i), valor.slice(i + 1));
}

class SupabaseFake {
  constructor() {
    this.tabelas = {};                         // nome -> linhas
    ["veiculos", "abastecimentos", "manutencoes", "turnos", "movimentacoes", "objetivos", "configuracoes", "migracoes"].forEach((t) => { this.tabelas[t] = []; });
    this.tokens = {};                          // access_token -> user_id
    this.refresh = {};                         // refresh_token -> { id, email }
    this.relogio = Date.parse("2026-11-20T10:00:00.000Z"); this.micro = 0;
    this.requisicoes = [];                     // log: { n, metodo, tabela, url, uid, corpo }
    this.antes = null; this.depois = null; this.falhar = null; this.validadores = { migracoes: (l) => (["iniciada", "concluida", "falhou"].includes(l.status) ? null : "violates check constraint migracoes_status_check") }; this.patchIgnorarIds = new Set();
    this.n = 0;
  }
  usuario(id, email) { const at = "at-" + id, rt = "rt-" + id; this.tokens[at] = id; this.refresh[rt] = { id, email: email || id + "@x.com" }; return { access_token: at, refresh_token: rt, expires_at: Math.floor(Date.now() / 1000) + 7200, user: { id, email: email || id + "@x.com", nome: "" } }; }
  ts() { this.micro++; const ms = this.relogio + Math.floor(this.micro / 1000); return new Date(ms).toISOString().slice(0, 19) + "." + String(ms % 1000).padStart(3, "0") + String(this.micro % 1000).padStart(3, "0") + "+00:00"; }
  avancar(ms) { this.relogio += ms; }
  /* insere direto (como se outro aparelho tivesse gravado) */
  semear(tabela, uid, linhas, { mesmoTs = false } = {}) {
    const fixo = mesmoTs ? this.ts() : null;
    linhas.forEach((l) => this.tabelas[tabela].push({ user_id: uid, deleted_at: null, ...l, updated_at: l.updated_at || fixo || this.ts() }));
  }
  linhas(tabela, uid) { return this.tabelas[tabela].filter((l) => !uid || l.user_id === uid); }
  count(metodo, tabela) { return this.requisicoes.filter((r) => (!metodo || r.metodo === metodo) && (!tabela || r.tabela === tabela)).length; }

  fetch = async (url, opts = {}) => {
    const u = new URL(url), metodo = (opts.method || "GET").toUpperCase();
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "";
    const token = auth.replace(/^Bearer /, "");
    const req = { n: ++this.n, metodo, url: u.pathname + u.search, caminho: u.pathname, tabela: null, token, uid: this.tokens[token] || null, corpo: opts.body ? JSON.parse(opts.body) : undefined, prefer: (opts.headers && opts.headers.Prefer) || "" };
    const sinal = opts.signal;
    const abortavel = (p) => new Promise((res, rej) => {
      if (sinal && sinal.aborted) return rej(Object.assign(new Error("abortado"), { name: "AbortError" }));
      if (sinal) sinal.addEventListener("abort", () => rej(Object.assign(new Error("abortado"), { name: "AbortError" })), { once: true });
      p.then(res, rej);
    });
    const resp = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (corpo === undefined) throw new Error("sem corpo"); return JSON.parse(JSON.stringify(corpo)); }, headers: { get: () => null } });
    const rest = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
    if (rest) req.tabela = rest[1];
    this.requisicoes.push(req);
    if (this.antes) await abortavel(Promise.resolve(this.antes(req)));
    const f = this.falhar && this.falhar(req);
    if (f === "rede") throw new TypeError("Failed to fetch");
    let r;
    if (f && f.status) r = resp(f.status, f.corpo || { message: "falha injetada " + f.status });
    else r = await this.processar(req, u, resp);
    if (this.depois) await abortavel(Promise.resolve(this.depois(req, r)));
    return r;
  };

  async processar(req, u, resp) {
    if (u.pathname === "/auth/v1/user") return req.uid ? resp(200, { id: req.uid }) : resp(401, { message: "JWT expired" });
    if (u.pathname === "/auth/v1/token") {
      const rt = req.corpo && req.corpo.refresh_token, who = this.refresh[rt];
      if (!who) return resp(400, { error_code: "refresh_token_not_found", msg: "invalid" });
      const at = "at-" + who.id + "-" + this.n; this.tokens[at] = who.id;
      return resp(200, { access_token: at, refresh_token: rt, expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, user: { id: who.id, email: who.email } });
    }
    if (u.pathname.startsWith("/auth/v1/logout")) return resp(204);
    if (!req.tabela) return resp(404, { message: "rota desconhecida" });
    if (!this.tabelas[req.tabela]) return resp(404, { message: "tabela não encontrada" });
    if (!req.uid) return resp(401, { message: "JWT expired", code: "PGRST303" });
    const tabela = this.tabelas[req.tabela], uid = req.uid;
    const reservados = new Set(["select", "order", "limit", "offset", "on_conflict"]);
    const filtros = [...u.searchParams.entries()].filter(([k]) => !reservados.has(k));
    const visiveis = () => tabela.filter((l) => l.user_id === uid && filtros.every(([k, v]) => avaliarFiltro(l, k, v)));
    const proj = (l) => { const sel = u.searchParams.get("select"); if (!sel || sel === "*") return { ...l }; const o = {}; sel.split(",").forEach((c) => { o[c] = l[c]; }); return o; };

    if (req.metodo === "GET") {
      let rows = visiveis();
      const ordem = u.searchParams.get("order");
      if (ordem) { const cs = ordem.split(",").map((o) => o.split(".")); rows.sort((a, b) => { for (const [c, d] of cs) { const x = cmp(a[c], b[c]); if (x) return d === "desc" ? -x : x; } return 0; }); }
      const lim = u.searchParams.get("limit"); if (lim) rows = rows.slice(0, Number(lim));
      return resp(200, rows.map(proj));
    }
    if (req.metodo === "POST") {
      const lote = Array.isArray(req.corpo) ? req.corpo : [req.corpo];
      const val = this.validadores[req.tabela];
      for (const l of lote) { const erro = val && val(l); if (erro) return resp(400, { message: erro }); }
      const chave = req.tabela === "configuracoes" ? ["user_id"] : ["id"];
      const out = [];
      const novas = [];
      for (const l of lote) {
        const existente = tabela.find((x) => x.user_id === uid && chave.every((c) => c === "user_id" || x[c] === l[c]));
        if (existente) {
          if (!/merge-duplicates/.test(req.prefer)) return resp(409, { message: "duplicate key" });
          Object.assign(existente, l, { user_id: uid, updated_at: this.ts() }); out.push(existente);
        } else { const nova = { deleted_at: null, ...l, user_id: uid, updated_at: this.ts() }; if (req.tabela === "migracoes" && !nova.id) nova.id = "mig-" + (tabela.length + 1) + "-" + this.n; novas.push(nova); out.push(nova); }
      }
      novas.forEach((n) => tabela.push(n));
      return /return=representation/.test(req.prefer) ? resp(201, out.map(proj)) : resp(201);
    }
    if (req.metodo === "PATCH") {
      if (req.tabela === "migracoes" && req.corpo && req.corpo.status && this.validadores.migracoes(req.corpo)) return resp(400, { message: this.validadores.migracoes(req.corpo) });
      const alvo = visiveis().filter((l) => !this.patchIgnorarIds.has(l.id));
      alvo.forEach((l) => { Object.assign(l, req.corpo, { updated_at: this.ts() }); });
      return /return=representation/.test(req.prefer) ? resp(200, alvo.map(proj)) : resp(204);
    }
    return resp(405, { message: "método não suportado" });
  }
}
module.exports = { SupabaseFake, normTs, cmp };
