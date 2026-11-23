"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { SupabaseFake } = require("./_supabase_fake");
const { criarApp, appLogado, backupFalso, mov, veic, SEED_BASE, espera } = require("./_app");

const ids = (l) => l.map((x) => x.id);
const rest = (srv) => srv.requisicoes.filter((r) => r.tabela && r.tabela !== "migracoes");
async function comApp(app, fn) { try { await fn(app); } finally { app.fechar(); } }

/* ===================== §2 Backup x sincronização ===================== */
test("backup: pendente => NENHUMA chamada de rede, mesmo com todos os gatilhos", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { backup: "pendente", seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await espera(100);
    await app.ev("sincronizar()");
    app.w.dispatchEvent(new app.w.Event("online"));
    app.w.document.dispatchEvent(new app.w.Event("visibilitychange"));
    app.w.document.dispatchEvent(new app.w.CustomEvent("movix:auth", { detail: { logado: true } }));
    app.w.document.getElementById("btnSyncAgora").click();
    app.w.localStorage.setItem("motograna:movimentacoes", JSON.stringify([mov(1), mov(2)]));
    await espera(2800);                       // vence o ESPERA_MS do agendar()
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0, "houve rede antes da autorização do backup");
    assert.ok(app.backup.consultas > 0, "a autorização não foi consultada");
  });
});
test("backup: retoma sozinho quando a autorização volta (sem ninguém chamar sincronizar)", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { backup: "pendente", seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  await comApp(app, async () => {
    await espera(100); assert.equal(srv.requisicoes.length, 0);
    app.backup.autorizada = true;
    await espera(4500);
    assert.equal(srv.linhas("movimentacoes", "u1").length, 2);
  });
});
test("backup: falha fechada (ausente, exceção, valor não-true)", async () => {
  for (const modo of ["ausente", "lanca", "undefined", "string"]) {
    const srv = new SupabaseFake();
    const b = backupFalso(true);
    if (modo === "lanca") b.syncAutorizada = () => { throw new Error("boom"); };
    if (modo === "undefined") b.syncAutorizada = () => undefined;
    if (modo === "string") b.syncAutorizada = () => "true";
    const app = appLogado(srv, "u1", { backup: modo === "ausente" ? "ausente" : b, seed: { "motograna:movimentacoes": [mov(1)] } });
    await comApp(app, async () => { await espera(100); await app.ev("sincronizar()"); assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0, modo); });
  }
});
test("backup: autorização revogada NO MEIO do ciclo interrompe antes da próxima etapa e nada é aplicado", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", [mov(50)]);
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso(); srv.requisicoes.length = 0;
    app.w.localStorage.setItem("motograna:turnos", "[]");
    srv.antes = (r) => { if (r.metodo === "POST") app.backup.autorizada = false; };
    app.ev("movimentacoes.push(" + JSON.stringify(mov(2)) + "); salvarDados()");
    await app.ev("sincronizar()"); await app.ocioso();
    assert.equal(srv.requisicoes.filter((r) => r.metodo === "GET").length, 0, "recebeu depois da revogação");
    srv.antes = null; app.backup.autorizada = true;
    await app.sincronizarAgora();
    assert.equal(srv.linhas("movimentacoes", "u1").length, 3);
  });
});
test("ativação manual: aguarda o snapshot pre_ativacao_sync antes de qualquer envio", async () => {
  const srv = new SupabaseFake(); const b = backupFalso(false);
  let liberar; b.garantir = async (op) => { b.garantirChamadas.push(op); await new Promise((r) => { liberar = r; }); b.autorizada = true; return { ok: true }; };
  const app = appLogado(srv, "u1", { backup: b, sync: null, seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    const p = app.ev("ativarSincronizacao()");
    await espera(300);
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0, "enviou antes do snapshot");
    liberar({ ok: true }); await p; await app.ocioso();
    assert.equal(b.garantirChamadas[0].origem, "pre_ativacao_sync");
    assert.equal(srv.linhas("movimentacoes", "u1").length, 1);
  });
});
test("ativação manual: snapshot falhou => NÃO ativa, nada enviado, dados locais intactos", async () => {
  const srv = new SupabaseFake(); const b = backupFalso(false); b.proximoGarantir = { ok: false, motivo: "idb" };
  const app = appLogado(srv, "u1", { backup: b, sync: null, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  await comApp(app, async () => {
    await app.ev("ativarSincronizacao()"); await espera(200);
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0);
    assert.notEqual(app.json("estadoSync && estadoSync.ativo"), true);
    assert.equal(app.json("movimentacoes.length"), 2);
  });
});

/* ===================== §3 Paginação ===================== */
test("paginação: 2.500 registros com updated_at distintos chegam todos", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", Array.from({ length: 2500 }, (_, i) => mov(i)));
  const app = appLogado(srv, "u1");
  await comApp(app, async () => { await app.ocioso(15000); assert.equal(app.json("movimentacoes.length"), 2500); });
});
test("paginação: 1.500 registros com o MESMO updated_at (sem pular nem repetir)", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", Array.from({ length: 1500 }, (_, i) => mov(i)), { mesmoTs: true });
  const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    await app.ocioso(15000);
    const l = app.json("movimentacoes");
    assert.equal(l.length, 1500); assert.equal(new Set(ids(l)).size, 1500);
  });
});
test("paginação: 3.200 no mesmo updated_at (3+ páginas) e repetir a sincronização é idempotente", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", Array.from({ length: 3200 }, (_, i) => mov(i)), { mesmoTs: true });
  const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    await app.ocioso(20000); await app.sincronizarAgora();
    const l = app.json("movimentacoes"); assert.equal(l.length, 3200); assert.equal(new Set(ids(l)).size, 3200);
    assert.equal(srv.linhas("movimentacoes", "u1").length, 3200);
  });
});
test("paginação: registros criados DURANTE a paginação aparecem (nesta ou na próxima rodada) sem duplicar", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", Array.from({ length: 2100 }, (_, i) => mov(i)));
  const app = appLogado(srv, "u1", { sync: { ativo: false } });
  await comApp(app, async () => {
    let n = 0;
    srv.antes = (r) => { if (r.metodo === "GET" && r.tabela === "movimentacoes" && ++n === 2) srv.semear("movimentacoes", "u1", Array.from({ length: 50 }, (_, i) => mov(9000 + i))); };
    app.ev("estadoSync.ativo = true"); await app.sincronizarAgora(); await app.sincronizarAgora();
    const l = app.json("movimentacoes"); assert.equal(l.length, 2150); assert.equal(new Set(ids(l)).size, 2150);
  });
});
test("paginação: falha na 2ª página NÃO avança o cursor; a rodada seguinte recebe tudo", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", Array.from({ length: 1500 }, (_, i) => mov(i)), { mesmoTs: true });
  const app = appLogado(srv, "u1", { sync: { ativo: false } });
  await comApp(app, async () => {
    let n = 0; srv.falhar = (r) => (r.metodo === "GET" && r.tabela === "movimentacoes" && ++n === 2 ? { status: 500 } : null);
    app.ev("estadoSync.ativo = true"); await app.sincronizarAgora();
    assert.equal(app.json("estadoSync.ultimoPull.movimentacoes"), undefined, "cursor avançou numa falha");
    srv.falhar = null; await app.sincronizarAgora();
    assert.equal(app.json("movimentacoes.length"), 1500);
  });
});
test("paginação: registro remoto inválido é descartado E reportado (cursor não o 'perde' em silêncio)", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", [mov(1), { id: "ruim", descricao: "x", tipo: "xx", categoria: "c", valor: 1, data: "2026-01-01" }]);
  const app = appLogado(srv, "u1");
  await comApp(app, async () => { await app.ocioso(); assert.equal(app.json("movimentacoes.length"), 1); assert.equal(app.json("resultadoSync.descartados.length"), 1); });
});

/* ===================== §4 Exclusões lógicas ===================== */
async function comTresSincronizados(extra = {}) {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1), mov(2), mov(3)] }, ...extra });
  await app.ocioso(); return { srv, app };
}
test("exclusão: confirmada => linha com deleted_at e referência removida do snapshot", async () => {
  const { srv, app } = await comTresSincronizados();
  await comApp(app, async () => {
    app.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'm00002'); salvarDados()");
    await app.sincronizarAgora();
    assert.ok(srv.linhas("movimentacoes", "u1").find((l) => l.id === "m00002").deleted_at);
    assert.equal(app.json("'m00002' in estadoSync.snapshot.movimentacoes"), false);
  });
});
test("exclusão: PATCH não atualiza todas as linhas => NÃO some do snapshot, é reportada e repetida com segurança", async () => {
  const { srv, app } = await comTresSincronizados();
  await comApp(app, async () => {
    srv.patchIgnorarIds.add("m00002");
    app.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'm00002'); salvarDados()");
    await app.sincronizarAgora();
    assert.equal(app.json("'m00002' in estadoSync.snapshot.movimentacoes"), true, "referência removida sem confirmação");
    assert.equal(srv.linhas("movimentacoes", "u1").find((l) => l.id === "m00002").deleted_at, null);
    assert.equal(app.json("resultadoSync.rejeitados.some(r => r.id === 'm00002')"), true);
    srv.patchIgnorarIds.clear(); await app.sincronizarAgora();
    assert.ok(srv.linhas("movimentacoes", "u1").find((l) => l.id === "m00002").deleted_at);
    assert.equal(app.json("'m00002' in estadoSync.snapshot.movimentacoes"), false);
  });
});
test("exclusão: erro de rede/500 preserva a referência", async () => {
  const { srv, app } = await comTresSincronizados();
  await comApp(app, async () => {
    srv.falhar = (r) => (r.metodo === "PATCH" ? { status: 500 } : null);
    app.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'm00001'); salvarDados()");
    await app.sincronizarAgora();
    assert.equal(app.json("'m00001' in estadoSync.snapshot.movimentacoes"), true);
  });
});
test("exclusão: já excluída por outro aparelho conta como confirmada (sem tentar para sempre)", async () => {
  const { srv, app } = await comTresSincronizados();
  await comApp(app, async () => {
    srv.tabelas.movimentacoes.find((l) => l.id === "m00003").deleted_at = "2026-11-20T11:00:00Z";
    app.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'm00003'); salvarDados()");
    await app.sincronizarAgora();
    assert.equal(app.json("'m00003' in estadoSync.snapshot.movimentacoes"), false);
  });
});
test("exclusão: nunca toca em registros de OUTRO usuário (RLS) e ids com vírgula/aspas não alteram o filtro", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u2", [{ ...mov(7), id: "b" }]);
  const esquisito = { ...mov(8), id: 'a,b' }, comum = { ...mov(9), id: "b" };
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [esquisito, comum] } });
  await comApp(app, async () => {
    await app.ocioso();
    app.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'a,b'); salvarDados()");
    await app.sincronizarAgora();
    const u1 = srv.linhas("movimentacoes", "u1");
    assert.ok(u1.find((l) => l.id === "a,b").deleted_at); assert.equal(u1.find((l) => l.id === "b").deleted_at, null, "id 'b' foi apagado por engano");
    assert.equal(srv.linhas("movimentacoes", "u2")[0].deleted_at, null);
  });
});

/* ===================== §5 Concorrência ===================== */
test("concorrência: alteração local DURANTE o envio não é perdida e vai na rodada seguinte", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso();
    let feito = false;
    srv.antes = (r) => { if (!feito && r.metodo === "POST" && r.tabela === "movimentacoes") { feito = true; app.ev("movimentacoes[0].valor = 999; salvarDados()"); } };
    app.ev("movimentacoes[0].valor = 5; salvarDados()");
    await app.sincronizarAgora(); srv.antes = null;
    assert.equal(app.json("movimentacoes[0].valor"), 999);
    assert.ok(app.json("contarPendencias()") >= 1);
    await app.sincronizarAgora();
    assert.equal(srv.linhas("movimentacoes", "u1")[0].valor, 999);
  });
});
test("concorrência: alteração local DURANTE o recebimento não é sobrescrita pela nuvem", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso();
    srv.tabelas.movimentacoes[0].valor = 50; srv.tabelas.movimentacoes[0].updated_at = srv.ts();
    srv.antes = (r) => { if (r.metodo === "GET" && r.tabela === "movimentacoes") app.ev("movimentacoes[0].valor = 77; salvarDados()"); };
    await app.sincronizarAgora(); srv.antes = null;
    assert.equal(app.json("movimentacoes[0].valor"), 77);
    await app.sincronizarAgora(); assert.equal(srv.linhas("movimentacoes", "u1")[0].valor, 77);
  });
});
test("concorrência: exclusão remota NÃO apaga alteração local pendente (e a alteração é reenviada)", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  await comApp(app, async () => {
    await app.ocioso();
    const r = srv.tabelas.movimentacoes.find((l) => l.id === "m00001"); r.deleted_at = "2026-11-20T11:00:00Z"; r.updated_at = srv.ts();
    srv.antes = (q) => { if (q.metodo === "GET" && q.tabela === "movimentacoes") app.ev("movimentacoes.find(m => m.id==='m00001').valor = 321; salvarDados()"); };
    await app.sincronizarAgora(); srv.antes = null;
    assert.equal(app.json("movimentacoes.some(m => m.id==='m00001' && m.valor===321)"), true, "alteração pendente foi apagada");
    await app.sincronizarAgora();
    const nuvem = srv.linhas("movimentacoes", "u1").find((l) => l.id === "m00001");
    assert.equal(nuvem.valor, 321); assert.equal(nuvem.deleted_at, null);
  });
});
test("concorrência: exclusão remota SEM alteração local apaga aqui (comportamento mantido)", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  await comApp(app, async () => {
    await app.ocioso();
    const r = srv.tabelas.movimentacoes.find((l) => l.id === "m00001"); r.deleted_at = "2026-11-20T11:00:00Z"; r.updated_at = srv.ts();
    await app.sincronizarAgora(); assert.equal(app.json("movimentacoes.length"), 1);
  });
});
test("concorrência: metas alteradas durante o recebimento não são sobrescritas", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:metaSemanal": "500" } });
  await comApp(app, async () => {
    await app.ocioso();
    srv.tabelas.configuracoes[0].meta_semanal = 900;
    srv.antes = (q) => { if (q.metodo === "GET" && q.tabela === "configuracoes") { app.ev("metaSemanal = 600; localStorage.setItem('motograna:metaSemanal','600')"); } };
    await app.sincronizarAgora(); srv.antes = null;
    assert.equal(app.json("metaSemanal"), 600);
    await app.sincronizarAgora(); assert.equal(srv.tabelas.configuracoes[0].meta_semanal, 600);
  });
});
test("concorrência: aplicar dados remotos não dispara novo ciclo (sem loop)", async () => {
  const srv = new SupabaseFake();
  srv.semear("movimentacoes", "u1", [mov(1), mov(2)]);
  const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    await app.ocioso(); const n = srv.count("GET", "veiculos"); await espera(3200);
    assert.equal(srv.count("GET", "veiculos"), n, "ciclo extra causado pela própria aplicação remota");
  });
});
test("dois aparelhos na mesma conta convergem", async () => {
  const srv = new SupabaseFake(); const tok = srv.usuario("u1");
  const mk = (seed) => criarApp({ servidor: srv, seed: { ...SEED_BASE(), ...seed }, sessao: tok, sync: { ativo: true, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao: null } });
  const A = mk({ "motograna:movimentacoes": [mov(1), mov(2)] }), B = mk({});
  try {
    await A.ocioso(); await B.ocioso(); await B.sincronizarAgora();
    assert.equal(B.json("movimentacoes.length"), 2);
    A.ev("movimentacoes[0].valor = 111; salvarDados()"); B.ev("movimentacoes[1].valor = 222; movimentacoes.push(" + JSON.stringify(mov(3)) + "); salvarDados()");
    await A.sincronizarAgora(); await B.sincronizarAgora(); await A.sincronizarAgora(); await B.sincronizarAgora();
    const a = A.json("movimentacoes").sort((x, y) => x.id.localeCompare(y.id)), b = B.json("movimentacoes").sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(a, b); assert.equal(a.length, 3); assert.equal(a[0].valor, 111); assert.equal(a[1].valor, 222);
    A.ev("movimentacoes = movimentacoes.filter(m => m.id !== 'm00003'); salvarDados()");
    await A.sincronizarAgora(); await B.sincronizarAgora(); assert.equal(B.json("movimentacoes.length"), 2);
  } finally { A.fechar(); B.fechar(); }
});

/* ===================== §6 Contas ===================== */
test("contas: logout DURANTE a sincronização não aplica nada nem faz novas chamadas; dados locais intactos", async () => {
  const srv = new SupabaseFake(); srv.semear("movimentacoes", "u1", [mov(50)]);
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso();
    srv.requisicoes.length = 0; let feito = false;
    srv.antes = (r) => { if (!feito && r.metodo === "GET") { feito = true; app.ev("encerrarSessaoLocal()"); } };
    app.ev("movimentacoes.push(" + JSON.stringify(mov(2)) + "); salvarDados()");
    await app.ev("sincronizar()"); await app.ocioso();
    const n = srv.requisicoes.length; await espera(300);
    assert.equal(srv.requisicoes.length, n);
    assert.equal(app.json("movimentacoes.length"), 3, "dado local perdido");
    assert.equal(app.json("estadoSync.usuario"), "u1");
  });
});
test("contas: resposta ATRASADA da conta anterior não é aplicada depois do login de outra conta", async () => {
  const srv = new SupabaseFake(); srv.semear("movimentacoes", "u1", [mov(50), mov(51)]);
  const t2 = srv.usuario("u2");
  const app = appLogado(srv, "u1", { sync: { ativo: false }, seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    let solta; const seg = new Promise((r) => { solta = r; });
    srv.depois = (r, resp) => (r.metodo === "GET" && r.tabela === "movimentacoes" && r.uid === "u1" ? seg : null);
    app.ev("estadoSync.ativo = true");
    const p = app.ev("sincronizar()"); await espera(200);
    app.ev("guardarSessao(" + JSON.stringify({ access_token: t2.access_token, refresh_token: t2.refresh_token, expires_at: t2.expires_at }) + "," + JSON.stringify(t2.user) + ")");
    solta(); await p; await app.ocioso(); await espera(300);
    assert.equal(app.json("movimentacoes.some(m => m.id === 'm00050')"), false, "dados da conta anterior entraram");
    assert.equal(srv.requisicoes.filter((r) => r.uid === "u2" && r.tabela).length, 0, "enviou/pediu dados com a conta nova sem ativação");
    assert.equal(app.json("estadoSync.usuario"), "u1");
  });
});
test("contas: trocar de conta com dados pendentes NÃO envia nada sem confirmação explícita; ativação avisa da outra conta", async () => {
  const srv = new SupabaseFake(); const t2 = srv.usuario("u2");
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso();
    app.ev("movimentacoes.push(" + JSON.stringify(mov(2)) + "); salvarDados()");        // pendente da conta u1
    app.ev("encerrarSessaoLocal()");
    app.ev("guardarSessao(" + JSON.stringify({ access_token: t2.access_token, refresh_token: t2.refresh_token, expires_at: t2.expires_at }) + "," + JSON.stringify(t2.user) + ")");
    srv.requisicoes.length = 0; await espera(3000);
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0);
    app.w.confirm = (t) => { app.dialogos.push(t); return false; };
    await app.ev("ativarSincronizacao()");
    assert.match(app.dialogos.at(-1), /OUTRA conta/); assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0);
    assert.equal(srv.linhas("movimentacoes", "u2").length, 0);
  });
});
test("contas: 401 persistente e 403 não apagam nem substituem dados locais", async () => {
  for (const status of [401, 403]) {
    const srv = new SupabaseFake(); srv.semear("movimentacoes", "u1", [mov(50)]);
    const app = appLogado(srv, "u1", { sync: { ativo: false }, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
    await comApp(app, async () => {
      srv.falhar = (r) => (r.tabela ? { status } : null);
      app.ev("estadoSync.ativo = true"); await app.sincronizarAgora();
      assert.equal(app.json("movimentacoes.length"), 2); assert.ok(app.json("resultadoSync.erro").length > 0);
      assert.equal(app.json("estadoSync.ativo"), true);
    });
  }
});
test("contas: logout durante renovação de token não restaura a sessão com resposta atrasada", async () => {
  const srv = new SupabaseFake(); const t = srv.usuario("u1");
  const app = criarApp({ servidor: srv, seed: SEED_BASE(), sessao: t, sync: { ativo: false, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null } });
  await comApp(app, async () => {
    let solta; const esperaResposta = new Promise((r) => { solta = r; });
    srv.antes = (r) => (r.caminho === "/auth/v1/token" ? esperaResposta : null);
    const p = app.ev("renovarSessao()");
    while (!srv.requisicoes.some((r) => r.caminho === "/auth/v1/token")) await espera(10);
    app.ev("encerrarSessaoLocal()");
    solta(); await p;
    assert.equal(app.json("sessao === null"), true, "a resposta antiga restaurou a sessão encerrada");
    assert.equal(app.ls("movix:sessao"), null, "a sessão encerrada voltou ao LocalStorage");
  });
});
test("sync: pausar durante renovação do token impede que a requisição REST seja enviada", async () => {
  const srv = new SupabaseFake(); const t = srv.usuario("u1");
  const app = criarApp({ servidor: srv, seed: { ...SEED_BASE(), "motograna:movimentacoes": [mov(1)] }, sessao: t,
    sync: { ativo: true, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null } });
  await comApp(app, async () => {
    await app.ocioso();
    app.ev("sessao.expires_at = Math.floor(Date.now() / 1000) - 10");
    let solta; const esperaResposta = new Promise((r) => { solta = r; });
    srv.antes = (r) => (r.caminho === "/auth/v1/token" ? esperaResposta : null);
    srv.requisicoes.length = 0;
    const p = app.ev("sincronizar()");
    while (!srv.requisicoes.some((r) => r.caminho === "/auth/v1/token")) await espera(10);
    app.ev("pausarSincronizacao()");
    solta(); await p; await espera(100);
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0, "requisição REST foi enviada depois da pausa");
    assert.equal(app.json("estadoSync.ativo"), false);
  });
});

test("contas: token expirado é renovado; após logout o token antigo não autoriza mais nada", async () => {
  const srv = new SupabaseFake(); const t = srv.usuario("u1"); t.expires_at = Math.floor(Date.now() / 1000) - 10;
  const app = criarApp({ servidor: srv, seed: SEED_BASE(), sessao: t, sync: { ativo: true, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao: null } });
  await comApp(app, async () => {
    await app.ocioso(); assert.ok(srv.requisicoes.some((r) => r.caminho === "/auth/v1/token"));
    app.ev("encerrarSessaoLocal()"); srv.requisicoes.length = 0;
    await app.ev("sincronizar()"); await app.ocioso(); assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0);
  });
});

test("contas: renovações simultâneas compartilham uma única chamada de refresh", async () => {
  const srv = new SupabaseFake(); const t = srv.usuario("u1");
  const app = criarApp({ servidor: srv, seed: SEED_BASE(), sessao: t, sync: { ativo: false, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null } });
  await comApp(app, async () => {
    let solta; const esperaResposta = new Promise((r) => { solta = r; });
    srv.antes = (r) => (r.caminho === "/auth/v1/token" ? esperaResposta : null);
    const p1 = app.ev("renovarSessao()");
    while (!srv.requisicoes.some((r) => r.caminho === "/auth/v1/token")) await espera(10);
    const p2 = app.ev("renovarSessao()");
    await espera(30);
    assert.equal(srv.requisicoes.filter((r) => r.caminho === "/auth/v1/token").length, 1);
    solta(); const resultados = await Promise.all([p1, p2]);
    assert.deepEqual(resultados, [true, true]);
    assert.notEqual(app.json("sessao.access_token"), t.access_token);
  });
});

test("contas: token expirado + falha temporária de refresh não entrega token vencido", async () => {
  const srv = new SupabaseFake(); const t = srv.usuario("u1");
  t.expires_at = Math.floor(Date.now() / 1000) - 10;
  const app = criarApp({ servidor: srv, seed: SEED_BASE(), sessao: t, sync: { ativo: false, usuario: "u1", ultimoPull: {}, snapshot: {}, ultimaSync: null } });
  await comApp(app, async () => {
    srv.falhar = (r) => (r.caminho === "/auth/v1/token" ? { status: 503 } : null);
    const token = await app.ev("obterTokenValido()");
    assert.equal(token, null);
    assert.equal(app.json("Boolean(sessao)"), true, "falha temporária não deve apagar a sessão local");
    assert.equal(srv.requisicoes.filter((r) => r.tabela).length, 0);
  });
});


test("sync: HTTP 401 com refresh confirmado repete uma vez usando o token novo", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    let falhou = false;
    srv.falhar = (r) => {
      if (r.tabela === "movimentacoes" && !falhou) { falhou = true; return { status: 401 }; }
      return null;
    };
    await app.ev('restFetch("movimentacoes?select=id", { metodo: "GET", prefer: "count=exact", usuario: "u1", foraDoCiclo: true })');
    const chamadas = srv.requisicoes.filter((r) => r.tabela === "movimentacoes");
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[0].url, chamadas[1].url);
    assert.equal(chamadas[0].metodo, chamadas[1].metodo);
    assert.equal(chamadas[0].prefer, chamadas[1].prefer);
    assert.notEqual(chamadas[0].token, chamadas[1].token);
    assert.equal(srv.requisicoes.filter((r) => r.caminho === "/auth/v1/token").length, 1);
  });
});

test("sync: HTTP 401 sem refresh confirmado não repete a chamada REST", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    srv.falhar = (r) => {
      if (r.tabela === "movimentacoes") return { status: 401 };
      if (r.caminho === "/auth/v1/token") return { status: 503 };
      return null;
    };
    await assert.rejects(
      app.ev('restFetch("movimentacoes", { usuario: "u1", foraDoCiclo: true })'),
      (e) => e && e.status === 401
    );
    assert.equal(srv.requisicoes.filter((r) => r.tabela === "movimentacoes").length, 1);
    assert.equal(srv.requisicoes.filter((r) => r.caminho === "/auth/v1/token").length, 1);
  });
});

test("contas: pausar e reativar a sincronização volta a funcionar", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ocioso(); app.ev("pausarSincronizacao()"); app.ev("movimentacoes.push(" + JSON.stringify(mov(2)) + "); salvarDados()");
    srv.requisicoes.length = 0; await app.ev("sincronizar()"); assert.equal(srv.requisicoes.length, 0);
    await app.ev("ativarSincronizacao()"); await app.ocioso(); assert.equal(srv.linhas("movimentacoes", "u1").length, 2);
  });
});

/* ===================== §7 Chaves do LocalStorage ===================== */
test("chaves: só dados sincronizáveis agendam; preferências do aparelho não; erro no observador não quebra setItem", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    await app.ocioso();
    for (const k of ["motograna:frete", "motograna:veiculoAtivo", "motograna:turnoAtual", "motograna:turnoEncerrado", "movix:sync-x"]) { app.w.localStorage.setItem(k, "1"); assert.equal(app.json("timerSync == null"), true, k); }
    for (const k of ["motograna:movimentacoes", "motograna:metaSemanal", "motograna:remuneracao", "motograna:turnos"]) { app.ev("clearTimeout(timerSync); timerSync = null"); app.w.localStorage.setItem(k, k === "motograna:movimentacoes" || k === "motograna:turnos" ? "[]" : "1"); assert.equal(app.json("timerSync != null"), true, k); }
    app.backup.syncAutorizada = () => { throw new Error("x"); };
    assert.doesNotThrow(() => app.w.localStorage.setItem("motograna:movimentacoes", "[]"));
    assert.equal(app.w.localStorage.getItem("motograna:movimentacoes"), "[]");
    assert.equal(app.json("Storage.prototype.setItem.__movixSync"), true);
  });
});

/* ===================== §8 Migração ===================== */
const relatorio = (app) => app.lsJson("movix:relatorio-migracao");
test("migração: integral => 'concluida' (banco e relatório)", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1", { sync: null, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  await comApp(app, async () => {
    await app.ev("ativarSincronizacao()"); await app.ocioso();
    const r = relatorio(app); assert.equal(r.situacao, "concluida"); assert.equal(r.totalRejeitados, 0); assert.ok(r.tabelas.includes("movimentacoes"));
    assert.equal(srv.tabelas.migracoes[0].status, "concluida"); assert.equal(app.json("estadoSync.migracao"), null);
  });
});
test("migração: com rejeições => 'parcial', NUNCA 'concluida'; rejeições persistem entre rodadas e dados locais ficam", async () => {
  const srv = new SupabaseFake(); srv.validadores.movimentacoes = (l) => (l.id === "m00002" ? "valor fora do permitido" : null);
  const app = appLogado(srv, "u1", { sync: null, seed: { "motograna:movimentacoes": [mov(1), mov(2), mov(3)] } });
  await comApp(app, async () => {
    await app.ev("ativarSincronizacao()"); await app.ocioso(); await app.sincronizarAgora(); await app.sincronizarAgora();
    const r = relatorio(app); assert.equal(r.situacao, "parcial"); assert.equal(r.totalRejeitados, 1); assert.equal(r.rejeitados[0].id, "m00002");
    assert.match(Object.keys(r.motivos)[0], /valor fora/);
    assert.notEqual(srv.tabelas.migracoes[0].status, "concluida"); assert.equal(srv.tabelas.migracoes[0].resumo.situacao, "parcial");
    assert.equal(app.json("movimentacoes.length"), 3);
    srv.validadores.movimentacoes = null; await app.sincronizarAgora();       // rejeição resolvida
    assert.equal(relatorio(app).situacao, "concluida"); assert.equal(srv.tabelas.migracoes[0].status, "concluida");
  });
});
test("migração: falha ao registrar 'falhou' mantém estado remoto pendente e a próxima rodada conclui", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { sync: null, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  let falhasPatch = 0;
  await comApp(app, async () => {
    srv.falhar = (r) => {
      if (r.tabela === "movimentacoes" && r.metodo === "GET") return { status: 500 };
      if (r.tabela === "migracoes" && r.metodo === "PATCH" && r.corpo && r.corpo.status === "falhou" && falhasPatch++ === 0) return { status: 500 };
      return null;
    };

    await app.ev("ativarSincronizacao()");
    await app.ocioso();

    assert.equal(relatorio(app).situacao, "falhou", "o relatório local deve registrar a falha original");
    assert.equal(falhasPatch, 1, "o PATCH de falha precisa ter sido tentado");
    assert.equal(srv.tabelas.migracoes.length, 1);
    assert.equal(srv.tabelas.migracoes[0].status, "iniciada", "o servidor não confirmou o PATCH que marcaria falhou");
    assert.notEqual(app.lsJson("movix:sync").migracao.situacaoRemota, "falhou", "o estado local não pode fingir que o PATCH foi confirmado");

    srv.falhar = null;
    await app.sincronizarAgora();

    assert.equal(relatorio(app).situacao, "concluida", "a retomada deve concluir a migração");
    assert.equal(srv.tabelas.migracoes.length, 1, "a retomada não deve criar outra migração");
    assert.equal(srv.tabelas.migracoes[0].status, "concluida", "o estado remoto deve ser regularizado na retomada");
    assert.equal(app.json("estadoSync.migracao"), null);
  });
});

test("migração: interrompida por erro => 'falhou'; retomada depois (novo carregamento) conclui", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1", { sync: null, seed: { "motograna:movimentacoes": [mov(1), mov(2)] } });
  let dump;
  try {
    srv.falhar = (r) => (r.tabela === "movimentacoes" && r.metodo === "GET" ? { status: 500 } : null);
    await app.ev("ativarSincronizacao()"); await app.ocioso();
    assert.equal(relatorio(app).situacao, "falhou"); assert.equal(srv.tabelas.migracoes[0].status, "falhou");
    dump = Object.fromEntries(Array.from({ length: app.w.localStorage.length }, (_, i) => app.w.localStorage.key(i)).map((k) => [k, app.w.localStorage.getItem(k)]));
  } finally { app.fechar(); }
  srv.falhar = null;
  const app2 = criarApp({ servidor: srv, seed: dump });
  await comApp(app2, async () => { await app2.ocioso(); assert.equal(relatorio(app2).situacao, "concluida"); assert.equal(srv.tabelas.migracoes.length, 1); assert.equal(srv.tabelas.migracoes[0].status, "concluida"); });
});
test("migração: mesmos dados ativados duas vezes => 'ja_realizada' e um único registro", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1", { sync: null, seed: { "motograna:movimentacoes": [mov(1)] } });
  await comApp(app, async () => {
    await app.ev("ativarSincronizacao()"); await app.ocioso();
    app.ev("pausarSincronizacao()"); app.ev("localStorage.removeItem('movix:backup-preventivo')");
    await app.ev("ativarSincronizacao()"); await app.ocioso();
    assert.equal(srv.tabelas.migracoes.length, 1); assert.equal(relatorio(app).situacao, "ja_realizada");
  });
});
test("migração: backup importado duas vezes é registrado uma vez e a 2ª avisa", async () => {
  const srv = new SupabaseFake(); const app = appLogado(srv, "u1");
  await comApp(app, async () => {
    await app.ocioso();
    const ev = () => app.w.document.dispatchEvent(new app.w.CustomEvent("movix:backup-importado", { detail: { texto: '{"x":1}', adicionados: 1, ignorados: 0 } }));
    ev(); await espera(300); ev(); await espera(300);
    assert.equal(srv.tabelas.migracoes.length, 1); assert.match(app.w.document.getElementById("toast").textContent, /já tinha sido importado/);
  });
});
