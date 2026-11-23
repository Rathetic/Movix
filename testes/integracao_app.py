#!/usr/bin/env python3
"""Testes de integração do Movix no Chromium REAL (Playwright), usando o aplicativo completo:
index.html + backup-local.js + script.js + auth.js + sync.js (REAIS, sem mocks) + frete.js + lobby.js + nav.js.
Só a rede é simulada (rotas do Playwright para o Supabase). Uso:  python3 integracao_app.py [http://localhost:8765]
Sirva a pasta do projeto com:  python3 -m http.server 8765"""
import json, sys, time
from playwright.sync_api import sync_playwright

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765").rstrip("/")
BASE = BASE_URL + "/index.html"
SEED = {
  "motograna:movimentacoes": json.dumps([{"id": "m%d" % i, "descricao": "x", "tipo": "ganho", "categoria": "corrida", "valor": 10 + i, "data": "2026-11-%02d" % (i + 1)} for i in range(5)]),
  "motograna:combustivel": "[]", "motograna:manutencoes": "[]", "motograna:turnos": "[]", "motograna:objetivos": "[]",
  "motograna:veiculos": json.dumps([{"id": "v1", "nome": "Moto", "tipo": "moto"}]),
  "motograna:metaSemanal": "500", "motograna:remuneracao": json.dumps({"fixo": 50, "porEntrega": 4}),
}
LOGGER = """(function(){window.__escritas=[];var s=Storage.prototype.setItem,r=Storage.prototype.removeItem;
Storage.prototype.setItem=function(k,v){if(this===window.localStorage&&/^(motograna|movix):/.test(k))window.__escritas.push({k:k,op:'set',t:Date.now()});return s.apply(this,arguments)};
Storage.prototype.removeItem=function(k){if(this===window.localStorage&&/^(motograna|movix):/.test(k))window.__escritas.push({k:k,op:'rem',t:Date.now()});return r.apply(this,arguments)};})();"""
resultados = []

def dados_rest(reqs):
    """chamadas REST de sincronização de DADOS (exclui /rest/v1/migracoes, que é o registro da ativação manual)"""
    return [r for r in reqs["rest"] if "/rest/v1/migracoes" not in r[1]]

def check(nome, cond, extra=""):
    resultados.append((nome, bool(cond), extra))
    print(("OK    " if cond else "FALHA ") + nome + ((" -> " + str(extra)[:400]) if (extra and not cond) else ""))

def agora_ms(): return int(time.time() * 1000)

PAGS = []
def dormir(seg):
    """espera processando os eventos do navegador (dormir() travaria as rotas do Playwright e falsearia os horários)"""
    for pg in reversed(PAGS):
        if not pg.is_closed():
            pg.wait_for_timeout(int(seg * 1000)); return
    time.sleep(seg)

def novo_contexto(p, sessao=False, sync=False, hook=None, sem_locks=False, sem_modulo=False, modulo=None):
    ctx = p.chromium.launch().new_context()
    reqs = {"rest": [], "user": 0, "ciclos": [], "todos": []}
    def rota(route):
        u = route.request.url
        if "localhost" in u:
            if u.endswith("/backup-local.js") and (modulo or sem_modulo):
                m = modulo or {"status": 404}
                if m.get("abort"): return route.abort()
                if m.get("status"): return route.fulfill(status=m["status"], content_type="text/plain", body="nao encontrado")
                if "corpo" in m: return route.fulfill(status=200, content_type="application/javascript", body=m["corpo"])
                if m.get("transform"):
                    resp = route.fetch(); return route.fulfill(response=resp, body=m["transform"](resp.text()))
            return route.continue_()
        if "/auth/v1/user" in u:
            reqs["user"] += 1
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"id": "u1"}))
        if "supabase.co" in u:
            reqs["todos"].append((route.request.method, u.split("supabase.co")[1][:80], agora_ms()))
            if "/auth/v1/token" in u:     # renovação de sessão (o auth.js a dispara em 'online'/'visibilitychange')
                return route.fulfill(status=200, content_type="application/json", body=json.dumps({"access_token": "tk2", "refresh_token": "rt2", "expires_in": 7200, "expires_at": int(time.time()) + 7200, "user": {"id": "u1", "email": "a@b.c"}}))
            if "/rest/v1" in u:
                reqs["rest"].append((route.request.method, u.split("supabase.co")[1][:70], agora_ms()))
                if route.request.method == "GET" and "/rest/v1/veiculos?select" in u: reqs["ciclos"].append(agora_ms())   # 1º GET de cada ciclo de recebimento
            return route.fulfill(status=200, content_type="application/json", body="[]", headers={"content-range": "0-0/0"})
        return route.abort()
    ctx.route("**/*", rota)
    now = int(time.time()); init = {"movix:modo-local": "1"}; init.update(SEED)
    if sessao:
        init.pop("movix:modo-local")
        init["movix:sessao"] = json.dumps({"access_token": "tk", "refresh_token": "rt", "expires_at": now + 7200, "user": {"id": "u1", "email": "a@b.c", "nome": ""}})
    if sync:
        init["movix:sync"] = json.dumps({"ativo": True, "usuario": "u1", "ultimoPull": {}, "snapshot": {}, "ultimaSync": None})
    ctx.add_init_script("if(!sessionStorage.getItem('__seed')){sessionStorage.setItem('__seed','1');var d=%s;for(var k in d){if(!localStorage.getItem(k))localStorage.setItem(k,d[k]);}}" % json.dumps(init))
    ctx.add_init_script(LOGGER)
    if sem_locks: ctx.add_init_script("Object.defineProperty(navigator,'locks',{value:undefined,configurable:true});")
    if hook: ctx.add_init_script("window.__MOVIX_TESTE_BACKUP=%s;" % json.dumps(hook))
    return ctx, reqs

def pagina(ctx, hook=None, erros=None, aceitar_dialogos=True):
    pg = ctx.new_page(); PAGS.append(pg)
    if hook: pg.add_init_script("window.__MOVIX_TESTE_BACKUP=%s;" % json.dumps(hook))
    if erros is not None: pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    if aceitar_dialogos: pg.on("dialog", lambda d: d.accept())
    return pg

def pronto(pg, t=40000): pg.wait_for_function("window.MovixBackup && window.MovixBackup.estado().inicialConcluido", timeout=t)
def estado(pg): return pg.evaluate("MovixBackup.estado()")
def app_rodou(pg): return pg.evaluate("typeof iniciar === 'function' && typeof sincronizar === 'function'")
def gatilhos(pg):
    """dispara todos os gatilhos de sincronização que podem ser disparados sem esperar o intervalo de 60 s"""
    pg.evaluate("""()=>{window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new CustomEvent('movix:auth',{detail:{logado:true}}));
      var b=document.getElementById('btnSyncAgora'); if(b) b.click();
      localStorage.setItem('motograna:metaSemanal', String(500 + Math.floor(Math.random()*1000)));}""")

with sync_playwright() as p:
    # ===================== PARTE 1: cenários anteriores (modo local, sync ativa, duas abas) =====================
    ctx, reqs = novo_contexto(p); pg = pagina(ctx, erros=(erros := []))
    pg.goto(BASE); pronto(pg)
    check("A1 módulo carregou, sem erros de página", not erros, erros)
    lst = pg.evaluate("MovixBackup.listar()")
    check("A2 snapshot de inicialização concluído, dono local, saudável", len(lst) >= 1 and lst[0]["origem"] == "inicializacao" and lst[0]["dono"]["classe"] == "local" and lst[0]["qualidade"] == "saudavel", lst)
    check("A3 captura bruta feita ANTES do app gravar", lst[0]["completude"]["presentes"] >= 5, lst[0].get("completude"))
    est = estado(pg)
    check("A4 estado: IDB ok, SHA ok, Web Locks, participando", est["idb"] == "ok" and est["sha256"] and est["webLocks"] and est["participando"], est)
    check("A5 sync.js real funcionando (globais acessíveis)", pg.evaluate("typeof sincronizar==='function' && typeof pausarSincronizacao==='function' && typeof sincronizando!=='undefined'"))
    diag = pg.evaluate("MovixBackup.diagnostico()")
    check("A6 persist() registrado, sem falhas", diag["persist"] is not None and not (diag["falhas"] or []), diag)
    antes = pg.evaluate("localStorage.getItem('motograna:movimentacoes')")
    pacote = {"app": "Movix", "versao": 2, "movimentacoes": [{"id": "imp1", "descricao": "importada", "tipo": "ganho", "categoria": "corrida", "valor": 99, "data": "2026-11-05"}], "metaSemanal": 0, "combustivel": [], "manutencoes": [], "turnos": [], "objetivos": [], "veiculos": [], "metaMensal": 0}
    open("/tmp/imp.json", "w").write(json.dumps(pacote))
    pg.set_input_files("#arquivoImportar", "/tmp/imp.json"); dormir(1.5)
    lst2 = pg.evaluate("MovixBackup.listar()")
    check("A7 importarBackup: snapshot pre_importacao concluído ANTES de alterar", any(s["origem"] == "pre_importacao" for s in lst2), [s["origem"] for s in lst2])
    depois = pg.evaluate("localStorage.getItem('motograna:movimentacoes')")
    check("A8 importação continuou funcionando", "imp1" in depois and depois != antes)
    pre = [s for s in lst2 if s["origem"] == "pre_importacao"][0]
    pl = pg.evaluate("(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('movix-backup-local');q.onsuccess=()=>r(q.result)});const x=await new Promise(r=>{const t=db.transaction('payloads');const g=t.objectStore('payloads').get('%s');g.onsuccess=()=>r(g.result)});return x.dados['motograna:movimentacoes']})()" % pre["id"])
    check("A9 o snapshot pre_importacao guarda o estado ANTERIOR à importação", pl == antes and "imp1" not in pl)
    plano = pg.evaluate("MovixBackup.planejarRestauracao('%s', {})" % pre["id"])
    check("A10 plano de restauração ok (dono local x local)", plano["ok"], plano)
    with pg.expect_navigation(timeout=15000):
        r = pg.evaluate("MovixBackup.restaurar('%s', {})" % pre["id"])
    check("A11 restauração real concluída com recarga", r["ok"], r)
    pronto(pg)
    check("A12 dados restaurados idênticos ao snapshot, sem marcador pendente", pg.evaluate("localStorage.getItem('motograna:movimentacoes')") == antes and pg.evaluate("localStorage.getItem('movix:backup-recuperacao')") is None)
    check("A13 app sobe normalmente depois da restauração", not erros, erros)
    ctx.browser.close()

    ctx, reqs = novo_contexto(p, sessao=True, sync=True); pg = pagina(ctx, erros=(erros := []))
    pg.goto(BASE); pronto(pg)
    lst = pg.evaluate("MovixBackup.listar()")
    check("B1 com sessão validada online o snapshot de início é 'autenticado' u1", lst and lst[0]["dono"]["classe"] == "autenticado" and lst[0]["dono"]["usuarioId"] == "u1", lst[0]["dono"] if lst else None)
    check("B2 o módulo consultou /auth/v1/user e o sync.js ficou ativo", reqs["user"] >= 1 and pg.evaluate("estadoSync && estadoSync.ativo===true"), reqs["user"])
    pg.evaluate("localStorage.setItem('motograna:metaSemanal','123')"); sid = lst[0]["id"]
    with pg.expect_navigation(timeout=30000):
        r = pg.evaluate("MovixBackup.restaurar('%s', {})" % sid)
    check("B3 restauração com sync ATIVA: pausou e concluiu", r["ok"], r); pronto(pg)
    check("B4 movix:sync.ativo=false persistido depois da restauração e do recarregamento", pg.evaluate("JSON.parse(localStorage.getItem('movix:sync')).ativo") is False)
    check("B5 sync não está ativa em memória depois do recarregamento", pg.evaluate("estadoSync && estadoSync.ativo===false"))
    meta_apos = pg.evaluate("localStorage.getItem('motograna:metaSemanal')")     # lida ANTES de os gatilhos de teste gravarem valores aleatórios
    marca = len(reqs["rest"]); dormir(3); gatilhos(pg); dormir(1.5)
    check("B6 nenhum gatilho inicia sincronização depois da pausa", len(reqs["rest"]) == marca, reqs["rest"][marca:])
    check("B7 metaSemanal voltou ao valor do snapshot", meta_apos == "500", meta_apos)
    pg.evaluate("ativarSincronizacao()"); dormir(3)
    lst3 = pg.evaluate("MovixBackup.listar({incluirTodos:true})")
    check("B8 ativarSincronizacao: snapshot pre_ativacao_sync concluído antes do preventivo", any(s["origem"] == "pre_ativacao_sync" and s["estado"] == "concluido" for s in lst3), [(s["origem"], s["estado"]) for s in lst3])
    check("B9 sem erros de página no cenário com sync real", not erros, erros)
    ctx.browser.close()

    ctx, reqs = novo_contexto(p); a = pagina(ctx); b = pagina(ctx)
    a.goto(BASE); pronto(a); b.goto(BASE); pronto(b)
    sid = a.evaluate("MovixBackup.listar().then(l=>l[0].id)")
    r = a.evaluate("MovixBackup.restaurar('%s', {})" % sid)
    check("C1 duas abas reais: restauração recusada (outra_aba)", (not r["ok"]) and r["motivo"] == "outra_aba", r)
    b.close(); dormir(1.5); a.evaluate("localStorage.setItem('motograna:metaSemanal','77')")
    with a.expect_navigation(timeout=15000):
        r = a.evaluate("MovixBackup.restaurar('%s', {})" % sid)
    check("C2 depois de fechar a outra aba, a restauração prossegue", r["ok"], r)
    ctx.browser.close()

    # ===================== PARTE 2: correção A — o app só executa depois de obter o lock =====================
    ctx, reqs = novo_contexto(p)
    A = pagina(ctx, hook={"atrasoRestauracaoMs": 3500, "semRecarregar": True}); A.goto(BASE); pronto(A)
    sid = A.evaluate("MovixBackup.listar().then(l=>l[0].id)"); A.evaluate("localStorage.setItem('motograna:metaSemanal','123')")
    A.evaluate("()=>{window.__r=null; MovixBackup.restaurar('%s',{}).then(r=>{window.__r=r;window.__rfim=Date.now()}); return 1}" % sid)
    A.wait_for_function("MovixBackup.estado().emExclusivo===true", timeout=10000)
    t_excl = A.evaluate("MovixBackup.estado().marcos.exclusivoDesdeEm")
    B = pagina(ctx); B.goto(BASE); dormir(1.5)
    est = estado(B)
    check("A-1 aba nova durante a restauração: script.js/auth.js/sync.js NÃO executaram", B.evaluate("typeof iniciar==='undefined' && typeof iniciarAuth==='undefined' && typeof sincronizar==='undefined' && typeof iniciarLobby==='undefined'"))
    check("A-1b ela aguarda o lock (não participa) e mostra o aviso de espera", est["participando"] is False and est["aguardandoLock"] is True and B.locator("#movixEspera").is_visible(), (est["participando"], est["aguardandoLock"]))
    check("A-1c nenhuma gravação do app em motograna:*/movix:* enquanto aguarda", B.evaluate("window.__escritas.length") == 0, B.evaluate("window.__escritas"))
    A.wait_for_function("window.__r!==null", timeout=15000); rA = A.evaluate("window.__r"); t_fim_A = A.evaluate("MovixBackup.estado().marcos.exclusivoAteEm")
    check("A-1d a restauração na aba A concluiu", rA["ok"], rA)
    B.wait_for_function("typeof iniciar==='function' && MovixBackup.estado().inicialConcluido", timeout=30000)
    mB = estado(B)["marcos"]; writesB = B.evaluate("window.__escritas")
    check("A-1e B só obteve o lock DEPOIS de A liberar o exclusivo", mB["participacaoEm"] >= t_fim_A, (mB["participacaoEm"], t_fim_A))
    check("A-1f B iniciou o app depois do lock (appLiberado <= appCarregado) e inicializou normalmente", mB["participacaoEm"] <= mB["appLiberadoEm"] <= mB["appCarregadoEm"] and B.locator("#movixEspera").count() == 0, mB)
    check("A-1g B vê o estado restaurado (a captura foi refeita depois do lock)", B.evaluate("localStorage.getItem('motograna:metaSemanal')") == "500", B.evaluate("localStorage.getItem('motograna:metaSemanal')"))
    print("      linha do tempo A-1 (ms desde o exclusivo): exclusivo=0 fimA=%d lockB=%d appB=%d snapshotB=%s" % (t_fim_A - t_excl, mB["participacaoEm"] - t_excl, mB["appCarregadoEm"] - t_excl, (mB["snapshotInicialEm"] or 0) - t_excl))
    ctx.browser.close()

    ctx, reqs = novo_contexto(p)
    H = ctx.new_page(); PAGS.append(H); H.goto(BASE_URL + "/README.md")
    H.evaluate("()=>new Promise(res=>{navigator.locks.request('movix-dados',{mode:'exclusive'},()=>new Promise(r=>{window.__soltar=r;res(true)}))})")
    t_hold = agora_ms(); Y = pagina(ctx); Y.goto(BASE); dormir(2.0)
    check("A-2 sem lock: nenhuma gravação em motograna:*/movix:* causada pela inicialização", Y.evaluate("window.__escritas.length") == 0, Y.evaluate("window.__escritas"))
    check("A-2b sem lock: nenhuma função do app existe (nada executou)", Y.evaluate("typeof iniciar==='undefined' && typeof $==='undefined' && typeof sincronizar==='undefined'"))
    check("A-2c sem lock: a interface mostra o estado de espera (e o conteúdo fica coberto)", Y.locator("#movixEspera").is_visible())
    t_solta = agora_ms(); H.evaluate("window.__soltar()")
    Y.wait_for_function("typeof iniciar==='function'", timeout=20000); pronto(Y)
    w = Y.evaluate("window.__escritas"); mY = estado(Y)["marcos"]
    check("A-2d depois da liberação o app inicia e TODAS as gravações são posteriores à aquisição do lock", mY["participacaoEm"] >= t_solta - 50 and len(w) > 0 and min(x["t"] for x in w) >= mY["participacaoEm"], (mY["participacaoEm"], t_solta, w[:3]))
    ctx.browser.close()

    SEIS = "typeof iniciar==='undefined' && typeof iniciarAuth==='undefined' && typeof sincronizar==='undefined' && typeof iniciarLobby==='undefined' && typeof atualizarTela==='undefined' && !document.documentElement.classList.contains('nav-pronta')"
    TAGS = "['script.js','auth.js','sync.js','frete.js','lobby.js','nav.js'].filter(function(n){return document.querySelector('script[src=\"'+n+'\"]')}).length===0"

    # ---- Correção 1: sem Web Locks o app NÃO abre e nada é gravado (bloqueio total)
    ctx, reqs = novo_contexto(p, sessao=True, sync=True, sem_locks=True); erros = []; Z = pagina(ctx, erros=erros); Z.goto(BASE); dormir(3)
    check("A-3 sem navigator.locks: o app NÃO inicializa (nenhuma função/efeito dos seis scripts)", Z.evaluate(SEIS) and Z.evaluate(TAGS))
    check("A-3a os seis scripts funcionais não foram sequer injetados na página", Z.evaluate(TAGS))
    check("A-3b nenhuma gravação no LocalStorage durante a inicialização (nem no IndexedDB)", Z.evaluate("window.__escritas.length")==0 and Z.evaluate("indexedDB.databases().then(function(d){return d.length})")==0, Z.evaluate("window.__escritas"))
    msg = Z.locator("#movixBloqueio")
    check("A-3c tela de bloqueio visível, explica o recurso ausente e orienta a usar navegador compatível", msg.is_visible() and "Web Locks" in msg.inner_text() and "Chrome" in msg.inner_text() and "incompatível" in msg.inner_text(), msg.inner_text() if msg.count() else None)
    check("A-3d sem Web Locks: nenhuma requisição ao Supabase (a sincronização não roda)", len(reqs["todos"]) == 0, reqs["todos"][:3])
    gatilhos(Z); dormir(2)
    rr = Z.evaluate("MovixBackup.restaurar('x', {})")
    check("A-3e sem Web Locks: a restauração permanece indisponível", (not rr["ok"]) and rr["motivo"] == "sem_web_locks", rr)
    check("A-3f sem Web Locks: sync não tem estado (sync.js nem existe) e nada foi gravado mesmo depois dos gatilhos", Z.evaluate("typeof estadoSync==='undefined'") and len(reqs["todos"]) == 0 and not erros, erros)
    ctx.browser.close()
    ctx, reqs = novo_contexto(p); Z = pagina(ctx, erros=(erros := [])); Z.goto(BASE); pronto(Z)
    check("A-7 com Web Locks disponível o fluxo normal continua funcionando", app_rodou(Z) and estado(Z)["participando"] and Z.locator("#movixBloqueio").count() == 0 and Z.locator("#movixFalhaCarregamento").count() == 0 and not erros, erros)
    ctx.browser.close()

    # ---- Correção 2: falha do módulo => FALHA FECHADA (nenhum script funcional carrega)
    def stub(js): return {"corpo": js}
    CASOS = [
        ("B-1 HTTP 404 ao carregar backup-local.js", {"status": 404}, 3),
        ("B-1b falha de rede (requisição abortada)", {"abort": True}, 3),
        ("B-2 erro de execução no módulo (throw no topo)", stub("throw new Error('falha simulada');"), 3),
        ("B-2b erro de sintaxe no módulo", stub("function ( {"), 3),
        ("B-2c erro dentro de construir() (módulo real cai no stub)", {"transform": lambda src: src.replace("const FORMATO = 1;", "throw new Error('falha simulada em construir'); const FORMATO = 1;", 1)}, 3),
        ("B-3 ausência do objeto MovixBackup", stub("/* arquivo vazio */"), 3),
        ("B-4 ausência de aguardarInicio", stub("window.MovixBackup = {versao: 1, appCarregado: function(){}};"), 3),
        ("B-4b aguardarInicio existe mas não é função", stub("window.MovixBackup = {aguardarInicio: 'oi', appCarregado: function(){}};"), 3),
        ("B-5 a promessa de aguardarInicio REJEITA", stub("window.MovixBackup = {aguardarInicio: function(){ return Promise.reject(new Error('rejeitada')); }, appCarregado: function(){}};"), 3),
        ("B-5b aguardarInicio lança exceção síncrona", stub("window.MovixBackup = {aguardarInicio: function(){ throw new Error('boom'); }, appCarregado: function(){}};"), 3),
        ("B-5c a promessa resolve com algo diferente de 'ok' (sem_web_locks)", stub("window.MovixBackup = {aguardarInicio: function(){ return Promise.resolve('sem_web_locks'); }, appCarregado: function(){}};"), 3),
        ("B-5d a promessa resolve com true (não é 'ok')", stub("window.MovixBackup = {aguardarInicio: function(){ return Promise.resolve(true); }, appCarregado: function(){}};"), 3),
        ("B-5e aguardarInicio não devolve promessa", stub("window.MovixBackup = {aguardarInicio: function(){ return 1; }, appCarregado: function(){}};"), 3),
        ("B-6 módulo que trava sem responder nem mostrar espera (vigilância de 4 s)", stub("window.MovixBackup = {aguardarInicio: function(){ return new Promise(function(){}); }, appCarregado: function(){}};"), 6.5),
    ]
    for nome, mod, espera in CASOS:
        ctx, reqs = novo_contexto(p, sessao=True, sync=True, modulo=mod); erros = []; Z = pagina(ctx, erros=[]); Z.goto(BASE); dormir(espera)
        escr = Z.evaluate("window.__escritas"); tela = Z.locator("#movixFalhaCarregamento")
        seguro = Z.evaluate(SEIS) and Z.evaluate(TAGS) and len(escr) == 0 and len(reqs["todos"]) == 0
        check(nome + ": nenhum dos seis scripts carregou/executou; nenhuma gravação; nenhuma requisição ao Supabase", seguro, (escr[:3], reqs["todos"][:2]))
        check(nome + ": tela de erro visível, compreensível e com botão", tela.is_visible() and "Não foi possível abrir o Movix" in tela.inner_text() and "nenhum dado foi alterado" in tela.inner_text() and Z.get_by_role("button", name="Tentar novamente").is_visible(), tela.inner_text() if tela.count() else None)
        if nome.startswith("B-1 "):
            with Z.expect_navigation(timeout=10000): Z.get_by_role("button", name="Tentar novamente").click()
            dormir(1.5)
            check("B-1c o botão 'Tentar novamente' funciona sem os scripts do app (recarrega e continua bloqueado)", Z.locator("#movixFalhaCarregamento").is_visible() and Z.evaluate(SEIS) and Z.evaluate("window.__escritas.length")==0)
        ctx.browser.close()

    # ===================== PARTE 3: correção B — 1ª sincronização só depois do snapshot inicial "concluido" =====================
    ctx, reqs = novo_contexto(p, sessao=True, sync=True, hook={"atrasoGravacaoMs": 4000}); erros = []; S = pagina(ctx, erros=erros)
    t0 = agora_ms(); S.goto(BASE); S.wait_for_function("typeof iniciar==='function'", timeout=20000); dormir(1.5)
    gatilhos(S); dormir(1.5); gatilhos(S)
    pend = estado(S)
    check("B-1 backup inicial em andamento: nenhuma sincronização (zero chamadas ao REST) mesmo com todos os gatilhos", pend["protecao"]["estado"] == "pendente" and len(reqs["rest"]) == 0 and S.evaluate("sincronizando") is False, (pend["protecao"], reqs["rest"][:3]))
    check("B-1b consultas do sync.js foram bloqueadas (a porta foi realmente exercitada)", pend["contadores"]["consultasSyncBloqueadas"] >= 1, pend["contadores"])
    S.wait_for_function("MovixBackup.estado().protecao.estado==='concluida'", timeout=20000); dormir(3.5)
    m = estado(S)["marcos"]; cont = estado(S)["contadores"]; primeira_rest = reqs["rest"][0][2] if reqs["rest"] else None
    check("B-2 após 'concluido' a primeira sincronização começa (e só depois do snapshot)", primeira_rest is not None and primeira_rest >= m["snapshotInicialEm"], (primeira_rest, m["snapshotInicialEm"]))
    check("B-5 a liberação dispara no máximo UMA primeira sincronização", cont["primeiraSync"] == 1, cont)
    print("      linha do tempo B-1/B-2 (ms desde o carregamento): lock=%d appCarregado=%d snapshotConcluido=%d primeiraSyncSolicitada=%d primeiraRequisicaoREST=%s" % (m["participacaoEm"] - t0, m["appCarregadoEm"] - t0, m["snapshotInicialEm"] - t0, m["primeiraSyncSolicitadaEm"] - t0, (primeira_rest - t0) if primeira_rest else None))
    check("B-1c ordem: lock <= app carregado <= snapshot concluído <= primeira sincronização", m["participacaoEm"] <= m["appCarregadoEm"] <= m["snapshotInicialEm"] <= m["primeiraSyncSolicitadaEm"], m)
    n_ciclos = len(reqs["ciclos"]); S.evaluate("window.dispatchEvent(new Event('online'))"); dormir(2.5)
    check("B-5b gatilhos posteriores continuam funcionando normalmente (novo ciclo ao disparar 'online')", len(reqs["ciclos"]) > n_ciclos, (n_ciclos, len(reqs["ciclos"])))
    check("B-1d sem erros de página", not erros, erros)
    ctx.browser.close()

    ctx, reqs = novo_contexto(p, sessao=True, sync=True); S = pagina(ctx)
    t0 = agora_ms(); S.goto(BASE); S.wait_for_function("MovixBackup.estado().protecao.estado==='concluida'", timeout=30000); dormir(3.0)
    m = estado(S)["marcos"]; cont = estado(S)["contadores"]
    check("B-2c snapshot inicial concluído: a primeira sincronização começou (há chamadas ao REST) depois dele", len(reqs["rest"]) > 0 and reqs["rest"][0][2] >= m["snapshotInicialEm"], (len(reqs["rest"]), m))
    check("B-5c exatamente 1 primeiro ciclo (um GET de veiculos) e 1 liberação", len(reqs["ciclos"]) == 1 and cont["primeiraSync"] == 1, (len(reqs["ciclos"]), cont))
    ctx.browser.close()

    ctx, reqs = novo_contexto(p, sessao=True, sync=True, hook={"falharGravacao": True}, ); erros = []; S = pagina(ctx, erros=erros); S.clock.install()
    S.goto(BASE); S.wait_for_function("MovixBackup.estado().protecao.estado==='falhou'", timeout=30000); dormir(1)
    gatilhos(S); dormir(3.2); S.clock.fast_forward(61000); dormir(1.0)
    S.evaluate("ativarSincronizacao()"); dormir(2.0); gatilhos(S); S.clock.fast_forward(61000); dormir(1.5)
    est = estado(S)
    check("B-3 backup inicial FALHOU: sincronização automática permanece bloqueada (zero chamadas ao REST)", est["protecao"]["estado"] == "falhou" and len(dados_rest(reqs)) == 0, (est["protecao"], dados_rest(reqs)[:3]))
    check("B-4 gatilhos testados: inicialização, online, visibilitychange, movix:auth, botão 'Sincronizar agora', escrita no LocalStorage, intervalo de 60 s e ativação manual", est["contadores"]["consultasSyncBloqueadas"] >= 5 and est["contadores"]["consultasSync"] == est["contadores"]["consultasSyncBloqueadas"] and len(dados_rest(reqs)) == 0, est["contadores"])
    check("B-3b o app continua utilizável localmente", app_rodou(S) and S.evaluate("Array.isArray(movimentacoes) && movimentacoes.length===5") and not erros, erros)
    ctx.browser.close()

    ctx, reqs = novo_contexto(p, sessao=True, sync=True, hook={"falharGravacao": "inicializacao"}); erros = []; S = pagina(ctx, erros=erros)
    S.goto(BASE); S.wait_for_function("MovixBackup.estado().protecao.estado==='falhou'", timeout=30000); dormir(2)
    check("B-6 inicial falhou: nada sincroniza", len(reqs["rest"]) == 0, reqs["rest"][:3])
    S.evaluate("ativarSincronizacao()"); dormir(4)
    est = estado(S)
    check("B-6b ativação manual: o snapshot pre_ativacao_sync (concluído) libera a sincronização", est["protecao"]["estado"] == "concluida" and est["protecao"].get("origem") == "pre_ativacao_sync" and len(reqs["rest"]) > 0, (est["protecao"], len(reqs["rest"])))
    check("B-6c sem erros de página", not erros, erros)
    ctx.browser.close()

falhas = [r for r in resultados if not r[1]]
print("\nRESUMO INTEGRAÇÃO:", len(resultados) - len(falhas), "de", len(resultados), "passaram;", len(falhas), "falharam")
sys.exit(1 if falhas else 0)
