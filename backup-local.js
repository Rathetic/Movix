/* =====================================================
   Movix – Backup local automático (Etapa 12 / E1)
   Guarda cópias ("snapshots") dos dados do aplicativo no IndexedDB, de forma
   independente do LocalStorage, que continua sendo o armazenamento de trabalho.

   O QUE ESTE ARQUIVO FAZ
     • Captura, como TEXTO BRUTO, todas as chaves "motograna:*" (inclusive JSON corrompido).
     • Grava cada snapshot em etapas (T1..T5). Só o estado "concluido" conta como backup:
         T1 grava payload + metadados (estado "gravando", uma transação)
         T2 "confirmado"  T3 relê e confere SHA-256  T4 "verificado"  T5 "concluido"
       Entre as transações NÃO há atomicidade: uma interrupção deixa um estado
       intermediário, tratado por recuperarIntermediarios() sob lock exclusivo.
     • Identifica o proprietário (autenticado / local / dono_desconhecido), validando
       a sessão online em /auth/v1/user. Nenhum token é gravado.
     • Retenção: 14 diários, 8 semanais, 6 mensais + 10 de operações de risco,
       último íntegro, último saudável e a migração do preventivo antigo.
     • Restauração controlada (snapshot de segurança, pausa da sincronização, validação,
       rollback e marcador persistente). NÃO é atômica: são várias chaves independentes.
     • Coordenação entre abas por um único Web Lock "movix-dados":
         todas as abas = "shared"; restauração/recuperação = "exclusive" + ifAvailable.

   INICIALIZAÇÃO PROTEGIDA (index.html carrega o app por um pequeno carregador)
     • script.js, auth.js, sync.js, frete.js, lobby.js e nav.js só são EXECUTADOS depois que esta aba obtém a
       participação (shared) no lock "movix-dados" (MovixBackup.aguardarInicio()). Enquanto outra aba restaura
       dados (lock exclusivo), esta aba mostra um aviso de espera e nenhum código do app roda nem grava.
     • Sem Web Locks o app NÃO abre: tela de bloqueio, nenhum script do app executa, nada é gravado, sem sincronização
       e sem restauração (BLOQUEAR_APP_SEM_WEB_LOCKS = true). O carregador do index.html FALHA FECHADO: só carrega o app
       se esta função devolver a promessa e ela resolver com "ok"; qualquer outra coisa mostra a tela de erro.
     • A sincronização AUTOMÁTICA só é liberada (MovixBackup.syncAutorizada(), consultada pelo sync.js) depois que o
       snapshot inicial chega a "concluido". Falha ou pendência mantêm a sincronização bloqueada; o app segue local.

   O QUE ESTE ARQUIVO NÃO FAZ
     • O sync.js consulta syncAutorizada() em sincronizar(), agendar() e a cada etapa do ciclo (falha fechada)
       e usa garantirAtivacaoSync() na ativação manual.
     • Não faz backup na nuvem, outbox, conflitos, SQL nem interface nova.
     • Não protege contra limpeza dos dados do navegador, perda do aparelho ou aba antiga
       (sem este módulo) que continue aberta.

   GANCHO DE TESTES (inerte quando indefinido): window.__MOVIX_TESTE_BACKUP
   Lido UMA vez, ao carregar este arquivo. Só consegue PIORAR condições (falhas, atrasos);
   nunca afrouxa verificação. Não recebe nem registra dados. Campos:
     isolamento:"nome"            usa banco, prefixo e chaves próprios (não toca nos dados reais)
     falharAbrirBanco, falharGravacao, lancarQuota, falharLeitura, falharSha256,
     corromperPayloadAposGravar, atrasoGravacaoMs, pararAposTransacao:n (1..5),
     perderParticipacaoAposTransacao:n, falharAoAplicarChave:n, falharRollback,
     semWebLocks, atrasoRestauracaoMs, atrasoEntreLiberarEAdquirirMs,
     validacaoSimulada:"falha"|"timeout"|"idDivergente", donoForcadoNoSnapshot:"id",
     prazoGarantirMs, semRecarregar, semAutomaticos (não dispara o fluxo inicial), exigirWebLocks.
     falharGravacao aceita true (todas as origens) ou o nome de uma origem (ex.: "inicializacao").
   ===================================================== */
(function () {
  "use strict";

  var stub = {
    versao: 0, indisponivel: true,
    estado: function () { return { disponivel: false, motivo: "erro_inicializacao" }; },
    garantir: function () { return Promise.resolve({ ok: false, etapa: "modulo", motivo: "modulo_indisponivel" }); },
    garantirAtivacaoSync: function () { return Promise.resolve({ ok: false, etapa: "modulo", motivo: "modulo_indisponivel" }); },
    syncAutorizada: function () { return false; },          // módulo quebrado: a sincronização automática não começa
    appCarregado: function () { /* nada */ },
    protegerOperacao: function (origem, descricao) {
      return Promise.resolve(confirm("Não foi possível criar a cópia de segurança independente neste aparelho (módulo indisponível).\n\nSe continuar, esta operação será feita SEM essa cópia. Deseja continuar mesmo assim?"));
    },
    listar: function () { return Promise.resolve([]); }
  };

  try { construir(); } catch (erro) {
    try { console.warn("[MovixBackup] falha ao inicializar:", erro); } catch (e) { /* ignora */ }
    window.MovixBackup = stub;
  }

  function construir() {
    /* ---------- Configuração e gancho de testes ---------- */
    const T = (window.__MOVIX_TESTE_BACKUP && typeof window.__MOVIX_TESTE_BACKUP === "object") ? Object.assign({}, window.__MOVIX_TESTE_BACKUP) : null;
    const t = (k) => (T ? T[k] : undefined);
    const ISO = T && typeof T.isolamento === "string" ? T.isolamento : "";
    const SUF = ISO ? "-" + ISO : "";

    const FORMATO = 1;
    const DB_NOME = "movix-backup-local" + SUF, DB_VERSAO = 1;
    const PREFIXO = ISO ? ISO + "-motograna:" : "motograna:";
    const CHAVE_RECUPERACAO = "movix:backup-recuperacao" + SUF;
    const CHAVE_SYNC = "movix:sync" + SUF;
    const CHAVE_PREVENTIVO = "movix:backup-preventivo" + SUF;
    const LOCK_NOME = "movix-dados" + SUF;
    const SS_RESULTADO = "movix-backup-resultado" + SUF;

    const BLOQUEAR_APP_SEM_WEB_LOCKS = true;                  // sem Web Locks o app NÃO abre (tela de erro); nada é gravado
    const AUTORIZADORAS_SYNC = ["inicializacao", "pre_ativacao_sync"];   // snapshots cujo "concluido" libera a sincronização automática
    const PRAZO_GARANTIR_MS = 15000, ESPERA_AUTH_MS = 8000, VALIDACAO_AUTO_MS = 3000, VALIDACAO_RESTAURO_MS = 5000;
    const ESPERA_SYNC_MS = 20000, INTERVALO_ALTERACAO_MS = 30 * 60000, MAX_ALTERACAO_DIA = 6, TTL_VALIDACAO_MS = 15 * 60000;
    const INTERMEDIARIOS = ["gravando", "confirmado", "verificado"];
    const ORIGENS_RISCO = ["pre_restauracao", "pre_importacao", "pre_ativacao_sync", "pre_remocao_copias", "pre_restauracao_preventiva"];
    const ABA_ID = gerarId();

    // funções originais de escrita (capturadas antes de o sync.js substituí-las)
    const lsSet = Storage.prototype.setItem, lsRem = Storage.prototype.removeItem;

    /* ---------- Catálogo das chaves e grupos de restauração ---------- */
    const CATALOGO = [
      { sufixo: "movimentacoes", grupo: "nucleo", tipo: "lista", lista: true },
      { sufixo: "combustivel", grupo: "nucleo", tipo: "lista", lista: true },
      { sufixo: "manutencoes", grupo: "nucleo", tipo: "lista", lista: true },
      { sufixo: "turnos", grupo: "nucleo", tipo: "lista", lista: true },
      { sufixo: "veiculos", grupo: "nucleo", tipo: "lista", lista: true },
      { sufixo: "objetivos", grupo: "objetivos", tipo: "lista", lista: true },
      { sufixo: "metaSemanal", grupo: "metas", tipo: "numero" },
      { sufixo: "metaMensal", grupo: "metas", tipo: "numero" },
      { sufixo: "remuneracao", grupo: "remuneracao", tipo: "objeto", campos: ["fixo", "porEntrega"] },
      { sufixo: "veiculoAtivo", grupo: "preferencias", tipo: "texto" },
      { sufixo: "frete", grupo: "preferencias", tipo: "objeto" },
      { sufixo: "turnoEncerrado", grupo: "turno_encerrado", tipo: "turnoEncerrado" },
      { sufixo: "turnoAtual", grupo: "turno_em_andamento", tipo: "turnoAtual" }
    ].map((c) => Object.assign({ chave: PREFIXO + c.sufixo }, c));
    const CATALOGO_POR_CHAVE = {};
    CATALOGO.forEach((c) => { CATALOGO_POR_CHAVE[c.chave] = c; });
    const GRUPOS_PADRAO = ["nucleo", "objetivos", "metas", "remuneracao", "preferencias", "turno_encerrado"];
    const chavesDoGrupo = (g) => CATALOGO.filter((c) => c.grupo === g).map((c) => c.chave);
    const CHAVE_TURNOS = PREFIXO + "turnos", CHAVE_TURNO_ATUAL = PREFIXO + "turnoAtual", CHAVE_TURNO_ENCERRADO = PREFIXO + "turnoEncerrado";

    /* ---------- Utilitários ---------- */
    function pad2(n) { return n < 10 ? "0" + n : String(n); }
    function agora() { return Date.now(); }
    function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }
    function gerarId() {
      let a = Math.random().toString(36).slice(2, 8);
      try { const v = new Uint32Array(1); crypto.getRandomValues(v); a = v[0].toString(36); } catch (e) { /* ignora */ }
      return "bk-" + Date.now().toString(36) + "-" + a;
    }
    function diaLocal(ms) { const d = new Date(ms); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
    function mesLocal(dia) { return String(dia).slice(0, 7); }
    function semanaLocal(dia) {                       // segunda-feira da semana, como "AAAA-MM-DD"
      const p = String(dia).split("-").map(Number);
      const d = new Date(p[0], p[1] - 1, p[2]);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }
    // JSON com chaves ordenadas (mesmo conteúdo => mesmo texto)
    function estavel(v) {
      if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
      if (Array.isArray(v)) return "[" + v.map(estavel).join(",") + "]";
      return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + estavel(v[k])).join(",") + "}";
    }
    function canonico(dados, formato) { return estavel([formato || FORMATO, Object.keys(dados).sort().map((k) => [k, dados[k]])]); }
    function canonicoMeta(m) {
      return estavel({ id: m.id, formato: m.formato, origem: m.origem, criadoEm: m.criadoEm, dono: m.dono, contagens: m.contagens, hashConteudo: m.hashConteudo, estados: m.inventario && m.inventario.estados, fora: m.inventario && m.inventario.foraDoCatalogo });
    }
    function mesmoConteudo(a, b) {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
    }
    function aviso(texto, erro) {
      try { if (typeof toast === "function") { toast(texto, Boolean(erro)); return; } } catch (e) { /* ignora */ }
      try { console.info("[MovixBackup]", texto); } catch (e) { /* ignora */ }
    }
    class ErroPipeline extends Error { constructor(etapa, motivo) { super(motivo); this.etapa = etapa; this.motivo = motivo; } }
    class ParadaTeste extends Error { constructor(n) { super("parada_de_teste"); this.n = n; } }

    /* ---------- SHA-256 (Web Crypto; sem substituto fraco) ---------- */
    const shaDisponivel = () => typeof crypto !== "undefined" && Boolean(crypto) && Boolean(crypto.subtle) && typeof crypto.subtle.digest === "function";
    async function sha256(texto) {
      if (t("falharSha256")) throw new ErroPipeline("sha256", "falha_sha256_simulada");
      const bytes = new TextEncoder().encode(texto);
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      let s = ""; for (let i = 0; i < h.length; i++) s += (h[i] < 16 ? "0" : "") + h[i].toString(16);
      return s;
    }

    /* ---------- Marcos de tempo, proteção inicial e carregador do app ---------- */
    const marcos = { moduloCarregadoEm: Date.now(), participacaoEm: null, appLiberadoEm: null, appCarregadoEm: null, snapshotInicialEm: null, primeiraConsultaSyncEm: null, primeiraSyncLiberadaEm: null, primeiraSyncSolicitadaEm: null, exclusivoDesdeEm: null, exclusivoAteEm: null };
    const contadores = { consultasSync: 0, consultasSyncBloqueadas: 0, primeiraSync: 0 };
    let protecao = { estado: "pendente", motivo: "inicial_em_andamento", concluidoEm: null };
    let modoCarregador = false, appLiberado = false, capturaAtual = null, resolverDecisao = null, resolverAppLiberado = null, resolverAppCarregado = null, primeiraSyncChamada = false;
    const decisaoModo = new Promise((r) => { resolverDecisao = r; });
    const appLiberadoPromise = new Promise((r) => { resolverAppLiberado = r; });
    const appCarregadoPromise = new Promise((r) => { resolverAppCarregado = r; });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => resolverDecisao(modoCarregador), { once: true }); else resolverDecisao(false);

    function caixaFixa(id, estilo, texto) {
      if (document.getElementById(id)) return null;
      const d = document.createElement("div");
      d.id = id; d.setAttribute("role", id === "movixAvisoSemLocks" ? "status" : "alert"); d.style.cssText = estilo; d.textContent = texto;
      (document.body || document.documentElement).appendChild(d);
      return d;
    }
    const ESTILO_TELA = "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.94);color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center";
    function mostrarEspera() { caixaFixa("movixEspera", ESTILO_TELA, "Aguardando outra janela do Movix concluir uma operação de segurança dos dados (por exemplo, a restauração de um backup). O aplicativo abrirá automaticamente em seguida."); }
    function esconderEspera() { const d = document.getElementById("movixEspera"); if (d) d.remove(); }
    function mostrarBloqueioSemLocks() { esconderEspera(); caixaFixa("movixBloqueio", ESTILO_TELA, "Navegador incompatível. O Movix precisa de um recurso de segurança (Web Locks) que este navegador não oferece, por isso não pode abrir e nenhum dado foi alterado. Use uma versão atual do Chrome, Edge, Firefox ou Safari para continuar."); }
    function mostrarAvisoSemLocks() {
      const d = caixaFixa("movixAvisoSemLocks", "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 40px 8px 12px;background:#92400e;color:#fff;font:14px/1.4 system-ui,sans-serif;text-align:center", "Este navegador não oferece a coordenação entre abas (Web Locks). O Movix funciona neste aparelho, mas a sincronização, a ativação da sincronização e a restauração de backups ficam desativadas.");
      if (d) { const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Fechar aviso"); x.style.cssText = "position:absolute;top:2px;right:8px;background:none;border:0;color:#fff;font-size:22px;cursor:pointer"; x.addEventListener("click", () => d.remove()); d.appendChild(x); }
    }
    // Chamada pelo carregador do index.html: só resolve quando esta aba pode iniciar o app (lock obtido ou política sem Web Locks)
    function aguardarInicio() {
      modoCarregador = true; resolverDecisao(true);
      const decidir = () => {
        if (appLiberado) return;
        if (!locksDisponivel()) {
          if (BLOQUEAR_APP_SEM_WEB_LOCKS || t("exigirWebLocks") === true) { mostrarBloqueioSemLocks(); return; }   // não abre o app
          appLiberado = true; marcos.appLiberadoEm = agora(); capturaAtual = capturarBruto() || capturaAtual;
          mostrarAvisoSemLocks(); resolverAppLiberado("sem_web_locks"); return;
        }
        if (participando) {
          appLiberado = true; marcos.appLiberadoEm = agora(); esconderEspera();
          capturaAtual = capturarBruto() || capturaAtual;      // estado atual, ANTES de qualquer código do app (outra aba pode ter restaurado)
          resolverAppLiberado("ok");
        }
      };
      aoParticipar = decidir;
      setTimeout(() => { if (!appLiberado && locksDisponivel() && !participando) mostrarEspera(); }, 200);
      decidir();
      return appLiberadoPromise;
    }
    function appCarregado() { if (marcos.appCarregadoEm === null) { marcos.appCarregadoEm = agora(); resolverAppCarregado(true); } }
    // Consultada pelo sync.js (sincronizar e agendar). Só o snapshot inicial "concluido" libera a sincronização automática.
    function syncAutorizada() {
      contadores.consultasSync++;
      if (marcos.primeiraConsultaSyncEm === null) marcos.primeiraConsultaSyncEm = agora();
      let ok = false;
      try { ok = locksDisponivel() && detemLock() && !emExclusivo && !exclusivoPendente && !marcadorAtual() && protecao.estado === "concluida"; } catch (e) { ok = false; }
      if (ok) { if (marcos.primeiraSyncLiberadaEm === null) marcos.primeiraSyncLiberadaEm = agora(); } else contadores.consultasSyncBloqueadas++;
      return ok;
    }
    function autorizarSync(origem, id) {
      if (protecao.estado === "concluida") return;
      protecao = { estado: "concluida", motivo: null, origem, snapshotId: id, concluidoEm: agora() };
      if (marcos.snapshotInicialEm === null) marcos.snapshotInicialEm = protecao.concluidoEm;
      // a primeira sincronização foi bloqueada no carregamento: dispara UMA vez, sem timers nem repetições
      if (!primeiraSyncChamada) {
        primeiraSyncChamada = true; contadores.primeiraSync++; marcos.primeiraSyncSolicitadaEm = agora();
        try { if (typeof sincronizar === "function") Promise.resolve(sincronizar()).catch(() => { /* ignora */ }); } catch (e) { /* ignora */ }
      }
    }

    /* ---------- Estado do módulo ---------- */
    const estadoMod = { idb: "desconhecido", sha: shaDisponivel(), cota: false };
    let ultimaFalha = null, ultimoSnapshot = null, persistTentado = false, inicialConcluido = false;
    let marcadorMemoria = null, perdaSimulada = false, ultimaRecuperacaoTentativa = 0, ultimoHashTentado = null;
    const pipelinesAtivos = new Set(), estadosMemoria = new Map();

    /* ---------- IndexedDB ---------- */
    let dbPromessa = null;
    function abrirBanco() {
      if (dbPromessa) return dbPromessa;
      dbPromessa = new Promise((resolve, reject) => {
        if (t("falharAbrirBanco")) { reject(new Error("falha_abrir_simulada")); return; }
        if (typeof indexedDB === "undefined" || !indexedDB) { reject(new Error("idb_ausente")); return; }
        let finalizado = false, rq;
        const timer = setTimeout(() => { if (!finalizado) { finalizado = true; reject(new Error("abrir_timeout")); } }, 5000);
        try { rq = indexedDB.open(DB_NOME, DB_VERSAO); } catch (e) { clearTimeout(timer); reject(e); return; }
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains("snapshots")) {
            const s = db.createObjectStore("snapshots", { keyPath: "id" });
            s.createIndex("criadoEm", "criadoEm"); s.createIndex("diaLocal", "diaLocal");
            s.createIndex("estado", "estado"); s.createIndex("hashConteudo", "hashConteudo");
          }
          if (!db.objectStoreNames.contains("payloads")) db.createObjectStore("payloads", { keyPath: "snapshotId" });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "chave" });
        };
        rq.onsuccess = () => {
          clearTimeout(timer);
          if (finalizado) { try { rq.result.close(); } catch (e) { /* ignora */ } return; }
          finalizado = true;
          const db = rq.result;
          db.onversionchange = () => { try { db.close(); } catch (e) { /* ignora */ } dbPromessa = null; };
          db.onclose = () => { dbPromessa = null; };
          resolve(db);
        };
        rq.onerror = () => { clearTimeout(timer); if (!finalizado) { finalizado = true; reject(rq.error || new Error("abrir_erro")); } };
      });
      dbPromessa.catch(() => { dbPromessa = null; });
      return dbPromessa;
    }
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error("erro_requisicao")); });
    // Executa "corpo" dentro de uma transação e só resolve no oncomplete (gravação confirmada).
    // Dentro do corpo, só se pode aguardar requisições do IndexedDB (nada de Web Crypto ou rede).
    function transacao(db, lojas, modo, corpo) {
      return new Promise((resolve, reject) => {
        let resultado, txn, falhou = false;
        try { txn = db.transaction(lojas, modo); } catch (e) { reject(e); return; }
        txn.oncomplete = () => { if (!falhou) resolve(resultado); };
        txn.onerror = () => { falhou = true; reject(txn.error || new Error("erro_transacao")); };
        txn.onabort = () => { falhou = true; reject(txn.error || new Error("transacao_abortada")); };
        Promise.resolve().then(() => corpo(txn)).then((r) => { resultado = r; }, (e) => { falhou = true; try { txn.abort(); } catch (x) { /* ignora */ } reject(e); });
      });
    }
    async function lerMeta(chave) {
      const db = await abrirBanco();
      const r = await transacao(db, ["meta"], "readonly", (tx) => req(tx.objectStore("meta").get(chave)));
      return r ? r.valor : undefined;
    }
    async function gravarMeta(chave, valor) {
      const db = await abrirBanco();
      await transacao(db, ["meta"], "readwrite", (tx) => req(tx.objectStore("meta").put({ chave, valor })));
    }
    async function atualizarMeta(chave, fn) {
      const db = await abrirBanco();
      return transacao(db, ["meta"], "readwrite", async (tx) => {
        const lj = tx.objectStore("meta"), r = await req(lj.get(chave));
        const novo = fn(r ? r.valor : undefined);
        await req(lj.put({ chave, valor: novo }));
        return novo;
      });
    }
    function registrarFalha(etapa, motivo, origem, id) {
      const f = { em: agora(), etapa: String(etapa), motivo: String(motivo || ""), origem: origem || null, id: id || null };
      ultimaFalha = f;
      try { console.warn("[MovixBackup] falha:", f.etapa, f.motivo); } catch (e) { /* ignora */ }
      if (estadoMod.idb === "ok") atualizarMeta("falhas", (v) => (Array.isArray(v) ? v : []).concat([f]).slice(-20)).catch(() => { /* ignora */ });
      return f;
    }
    const falhou = (etapa, motivo, origem, id) => { registrarFalha(etapa, motivo, origem, id); return { ok: false, etapa, motivo, id: id || null }; };

    /* ---------- Coordenação entre abas: um único Web Lock "movix-dados" ---------- */
    let locksQuebrou = false;
    const locksDisponivel = () => !locksQuebrou && !t("semWebLocks") && typeof navigator !== "undefined" && Boolean(navigator.locks) && typeof navigator.locks.request === "function";
    let participando = false, emExclusivo = false, solicitando = false, exclusivoPendente = false, aguardandoLock = false;
    let soltarParticipacao = null, promessaParticipacao = null, aoParticipar = null;
    const detemLock = () => !perdaSimulada && (!locksDisponivel() || participando || emExclusivo);

    function iniciarParticipacao() {
      if (!locksDisponivel() || participando || solicitando) return;
      solicitando = true;
      const segurar = () => new Promise((fim) => {
        participando = true; solicitando = false; aguardandoLock = false;
        if (marcos.participacaoEm === null) marcos.participacaoEm = agora();
        soltarParticipacao = () => { participando = false; soltarParticipacao = null; fim(); };
        if (aoParticipar) aoParticipar();
      });
      // Tenta entrar de imediato; se um lock exclusivo estiver ativo, fica na fila (o app NÃO inicia enquanto isso)
      promessaParticipacao = navigator.locks.request(LOCK_NOME, { mode: "shared", ifAvailable: true }, (lock) => {
        if (lock) return segurar();
        aguardandoLock = true;
        return navigator.locks.request(LOCK_NOME, { mode: "shared" }, () => segurar());
      }).catch(() => { locksQuebrou = true; if (aoParticipar) aoParticipar(); }).then(() => { participando = false; solicitando = false; soltarParticipacao = null; });
    }
    async function aguardarParticipacao(ms) {
      if (!locksDisponivel()) return true;
      const limite = agora() + ms;
      while (!detemLock()) { if (agora() >= limite) return false; await dormir(25); }
      return true;
    }
    // Exclusividade REAL: libera a própria participação e pede o mesmo recurso em modo exclusivo, sem esperar.
    // A concessão do lock é a verificação: não há intervalo entre "checar" e "adquirir".
    async function comExclusivo(corpo) {
      if (!locksDisponivel()) return { ok: false, motivo: "sem_web_locks" };
      if (exclusivoPendente) return { ok: false, motivo: "operacao_exclusiva_em_andamento" };
      exclusivoPendente = true;
      try {
        await Promise.allSettled(Array.from(pipelinesAtivos));
        // se a própria participação ainda está sendo concedida, espera: senão o pedido exclusivo esbarraria no nosso próprio "shared"
        if (solicitando && !participando) {
          const lim = agora() + 1500;
          while (solicitando && !participando && agora() < lim) await dormir(20);
          if (solicitando && !participando) return { ok: false, motivo: "outra_aba" };      // outra aba segura o lock exclusivo
        }
        if (soltarParticipacao) { const p = promessaParticipacao; soltarParticipacao(); try { await p; } catch (e) { /* ignora */ } }
        const lacuna = Number(t("atrasoEntreLiberarEAdquirirMs")) || 0;
        if (lacuna) await dormir(lacuna);
        return await navigator.locks.request(LOCK_NOME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) return { ok: false, motivo: "outra_aba" };
          emExclusivo = true; marcos.exclusivoDesdeEm = agora(); marcos.exclusivoAteEm = null;
          try { return await corpo(); } finally { emExclusivo = false; marcos.exclusivoAteEm = agora(); }
        });
      } catch (e) {
        return { ok: false, motivo: "erro_lock", detalhe: String(e && e.message || e) };
      } finally {
        exclusivoPendente = false;
        iniciarParticipacao();
      }
    }
    const exigirLock = (op) => { if (!(op && op.interno) && !detemLock()) throw new ErroPipeline("lock", "perdeu_participacao"); };

    /* ---------- Proprietário dos dados ---------- */
    // O auth.js não avisa quando termina de iniciar (iniciarAuth() é async e a promessa é descartada).
    // A inicialização é INFERIDA por sinais observáveis, sem alterar auth.js e sem bloquear a abertura do app.
    let authInicializada = false, linkEmail = false, geracaoSessao = 0, ultimoIdVisto = null, resolverAuth = null;
    let cacheValidacao = null;                        // só em memória; nunca persistido
    const authPronta = new Promise((r) => { resolverAuth = r; });
    function sessaoAtual() { try { return typeof sessao !== "undefined" ? sessao : null; } catch (e) { return null; } }
    function idDaSessao() { const s = sessaoAtual(); return s && s.user && s.user.id ? String(s.user.id) : null; }
    function agoraSeg() { return Math.floor(Date.now() / 1000); }
    function margemRenovacao() { try { return typeof MARGEM_RENOVACAO === "number" ? MARGEM_RENOVACAO : 60; } catch (e) { return 60; } }
    function lerUsuarioSync() {
      try { const raw = localStorage.getItem(CHAVE_SYNC); if (!raw) return null; const o = JSON.parse(raw); return o && typeof o.usuario === "string" && o.usuario ? o.usuario : null; } catch (e) { return null; }
    }
    function marcarAuthInicializada() { if (!authInicializada) { authInicializada = true; resolverAuth(true); } }
    function observarAuth() {
      ultimoIdVisto = null;
      document.addEventListener("movix:auth", () => {
        const id = idDaSessao();
        if (id !== ultimoIdVisto) { geracaoSessao++; cacheValidacao = null; }
        ultimoIdVisto = id;
        marcarAuthInicializada();
      });
      const aoPronto = () => {
        linkEmail = window.__movixLinkEmail === true;
        const s = sessaoAtual();
        ultimoIdVisto = idDaSessao();
        const renovando = Boolean(s) && typeof s.expires_at === "number" && s.expires_at - agoraSeg() < margemRenovacao();
        if (linkEmail) return;                                    // só vira "inicializada" no primeiro movix:auth
        if (renovando) { setTimeout(marcarAuthInicializada, ESPERA_AUTH_MS); return; }   // aguarda movix:auth; depois decide a validação online
        marcarAuthInicializada();
      };
      // Com o carregador do index.html, auth.js só executa depois do lock: a avaliação espera o app terminar de carregar
      const disparar = () => { if (modoCarregador) appCarregadoPromise.then(aoPronto); else aoPronto(); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", disparar, { once: true }); else disparar();
    }
    function aguardarAuth(ms) { return authInicializada ? Promise.resolve(true) : Promise.race([authPronta, dormir(ms).then(() => false)]); }
    const desconhecido = (motivo, extra) => Object.assign({ classe: "dono_desconhecido", usuarioId: null, motivo, validadoPor: null, validadoEm: null }, extra || {});

    // Consulta /auth/v1/user. Snapshots automáticos NUNCA provocam renovação de sessão (evita refresh concorrente com o auth.js).
    async function validarSessaoOnline(modo) {
      const sim = t("validacaoSimulada");
      if (sim === "falha") return { ok: false, motivo: "validacao_simulada_falha" };
      if (sim === "timeout") return { ok: false, motivo: "timeout" };
      if (sim === "idDivergente") return { ok: false, motivo: "id_divergente" };
      if (typeof navigator !== "undefined" && navigator.onLine === false) return { ok: false, motivo: "offline" };
      let cfg = null;
      try { cfg = typeof lerConfiguracao === "function" ? lerConfiguracao() : null; } catch (e) { cfg = null; }
      if (!cfg || !cfg.ok) return { ok: false, motivo: "config_invalida" };
      let s = sessaoAtual();
      if (!s || !s.access_token) return { ok: false, motivo: "sem_sessao" };
      let token = s.access_token;
      if (typeof s.expires_at === "number" && s.expires_at - agoraSeg() <= margemRenovacao()) {
        if (modo === "restauro" && typeof obterTokenValido === "function") {
          try { token = await obterTokenValido(); } catch (e) { token = null; }
          if (!token) return { ok: false, motivo: "token_indisponivel" };
          s = sessaoAtual();
        } else return { ok: false, motivo: "token_expirando" };
      }
      const id0 = s && s.user && s.user.id ? String(s.user.id) : null;
      if (!id0) return { ok: false, motivo: "sessao_sem_usuario" };
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctl) ctl.abort(); }, modo === "restauro" ? VALIDACAO_RESTAURO_MS : VALIDACAO_AUTO_MS);
      try {
        const r = await fetch(String(cfg.url).replace(/\/+$/, "") + "/auth/v1/user", { headers: { apikey: cfg.chave, Authorization: "Bearer " + token }, signal: ctl ? ctl.signal : undefined });
        if (!r.ok) return { ok: false, motivo: "http_" + r.status };
        const j = await r.json();
        const idServidor = j && j.id ? String(j.id) : null;
        if (!idServidor || idServidor !== id0 || idDaSessao() !== idServidor) return { ok: false, motivo: "id_divergente" };
        return { ok: true, id: idServidor };
      } catch (e) {
        return { ok: false, motivo: e && e.name === "AbortError" ? "timeout" : "rede" };
      } finally { clearTimeout(timer); }
    }
    async function resolverDono(modo) {
      const forcado = t("donoForcadoNoSnapshot");
      if (typeof forcado === "string") return { classe: "autenticado", usuarioId: forcado, motivo: "gancho_teste", validadoPor: "teste", validadoEm: agora() };
      const g0 = geracaoSessao;
      if (!authInicializada) await aguardarAuth(modo === "restauro" ? ESPERA_AUTH_MS : 3000);
      if (!authInicializada) return desconhecido(linkEmail ? "fluxo_link_email" : "auth_nao_inicializada");
      const s = sessaoAtual(), usuSync = lerUsuarioSync();
      if (!s) {
        if (usuSync) return desconhecido("sem_sessao_com_usuario_sync");
        return geracaoSessao !== g0 ? desconhecido("sessao_mudou") : { classe: "local", usuarioId: null, motivo: "sem_sessao", validadoPor: null, validadoEm: null };
      }
      const id = idDaSessao();
      if (modo !== "restauro" && cacheValidacao && cacheValidacao.id === id && cacheValidacao.geracao === geracaoSessao && agora() - cacheValidacao.em < TTL_VALIDACAO_MS) {
        if (usuSync && usuSync !== id) return desconhecido("divergente_sync");
        return { classe: "autenticado", usuarioId: id, motivo: "validada_na_sessao", validadoPor: "auth_v1_user_online", validadoEm: cacheValidacao.em };
      }
      const v = await validarSessaoOnline(modo);
      if (!v.ok) return desconhecido(v.motivo);
      if (geracaoSessao !== g0 || idDaSessao() !== v.id) return desconhecido("sessao_mudou");
      cacheValidacao = { id: v.id, geracao: geracaoSessao, em: agora() };
      if (usuSync && usuSync !== v.id) return desconhecido("divergente_sync");
      return { classe: "autenticado", usuarioId: v.id, motivo: "validada_online", validadoPor: "auth_v1_user_online", validadoEm: agora() };
    }
    // Só restaura com os dois donos conhecidos e compatíveis
    function donoCompativel(snap, atual) {
      if (!snap || snap.classe === "dono_desconhecido") return { ok: false, motivo: "dono_do_snapshot_desconhecido" };
      if (!atual || atual.classe === "dono_desconhecido") return { ok: false, motivo: "dono_atual_desconhecido:" + (atual ? atual.motivo : "?") };
      if (snap.classe !== atual.classe) return { ok: false, motivo: snap.classe === "local" ? "snapshot_local_em_sessao_autenticada" : "outra_conta" };
      if (snap.classe === "autenticado" && snap.usuarioId !== atual.usuarioId) return { ok: false, motivo: "outra_conta" };
      return { ok: true };
    }

    /* ---------- Captura bruta e inventário ---------- */
    function capturarBruto() {
      const ler = () => {
        const o = {};
        for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(PREFIXO) === 0) { const v = localStorage.getItem(k); if (v !== null) o[k] = v; } }
        return o;
      };
      try {
        let a = ler(), b = ler();
        for (let i = 0; i < 2 && !mesmoConteudo(a, b); i++) { a = b; b = ler(); }
        return mesmoConteudo(a, b) ? { dados: b } : null;           // leituras que não estabilizam => sem captura
      } catch (e) { return null; }
    }
    function avaliarItem(it, texto) {
      if (texto === null || texto === undefined) return { estado: "ausente" };
      const ruim = { estado: "presente_ilegivel" }, bom = (n) => (n === undefined ? { estado: "presente_legivel" } : { estado: "presente_legivel", n });
      try {
        if (it.tipo === "numero") return Number.isFinite(parseFloat(texto)) ? bom() : ruim;
        if (it.tipo === "texto") return typeof texto === "string" && texto.length ? bom() : ruim;
        const v = JSON.parse(texto);
        if (it.tipo === "lista") return Array.isArray(v) && v.every((x) => x && typeof x === "object" && !Array.isArray(x)) ? bom(v.length) : ruim;
        if (!v || typeof v !== "object" || Array.isArray(v)) return ruim;
        if (it.tipo === "objeto") { for (const c of it.campos || []) if (c in v && !Number.isFinite(Number(v[c]))) return ruim; return bom(); }
        if (it.tipo === "turnoAtual") return Number.isFinite(v.inicio) && (v.pausas === undefined || Array.isArray(v.pausas)) ? bom() : ruim;
        if (it.tipo === "turnoEncerrado") return typeof v.id === "string" && Number.isFinite(v.inicio) && Number.isFinite(v.fim) ? bom() : ruim;
      } catch (e) { return ruim; }
      return ruim;
    }
    function inventariar(dados) {
      const estados = {}, contagens = {}, ilegiveis = [];
      let presentes = 0, ausentes = 0;
      CATALOGO.forEach((it) => {
        const r = avaliarItem(it, Object.prototype.hasOwnProperty.call(dados, it.chave) ? dados[it.chave] : null);
        estados[it.chave] = r.estado;
        if (r.n !== undefined) contagens[it.chave] = r.n;
        if (r.estado === "ausente") ausentes++; else presentes++;
        if (r.estado === "presente_ilegivel") ilegiveis.push(it.chave);
      });
      const fora = Object.keys(dados).filter((k) => !CATALOGO_POR_CHAVE[k]).sort();
      return { estados, contagens, ilegiveis, fora, completude: { catalogadas: CATALOGO.length, presentes, ausentes, ilegiveis: ilegiveis.length, foraDoCatalogo: fora.length } };
    }
    // "saudavel" nunca é "completo": ausentes e ilegíveis ficam registrados. Omissões de listas viram "suspeito".
    function avaliarQualidade(inv, base, op) {
      if (op.qualidadeFixa) return { qualidade: op.qualidadeFixa, avisos: (op.avisos || []).slice() };
      const avisos = []; let suspeito = false;
      inv.ilegiveis.forEach((k) => { avisos.push("ilegivel:" + k); suspeito = true; });
      if (base && base.inventario) {
        CATALOGO.filter((c) => c.lista).forEach((c) => {
          const antes = base.inventario.estados[c.chave], agoraE = inv.estados[c.chave];
          if (antes === "presente_legivel" && agoraE === "ausente") { avisos.push("chave_ausente:" + c.chave); suspeito = true; }
          const bn = base.contagens && base.contagens[c.chave], n = inv.contagens[c.chave];
          if (bn !== undefined && n !== undefined && bn >= 5 && n < bn * 0.7) { avisos.push("queda_brusca:" + c.chave + ":" + bn + "->" + n); suspeito = true; }
        });
      }
      return { qualidade: suspeito ? "suspeito" : "saudavel", avisos };
    }

    /* ---------- Leitura de snapshots ---------- */
    async function lerCompleto(db, id) {
      if (t("falharLeitura")) throw new ErroPipeline("leitura", "falha_leitura_simulada");
      return transacao(db, ["snapshots", "payloads"], "readonly", async (tx) => ({
        meta: await req(tx.objectStore("snapshots").get(id)), payload: await req(tx.objectStore("payloads").get(id))
      }));
    }
    async function listarMetas(db, filtro) {
      return transacao(db, ["snapshots"], "readonly", async (tx) => {
        const todos = await req(tx.objectStore("snapshots").getAll());
        return filtro ? todos.filter(filtro) : todos;
      });
    }
    function primeiroConcluido(ls, filtro) {
      return new Promise((resolve, reject) => {
        const c = ls.index("criadoEm").openCursor(null, "prev");
        c.onsuccess = () => { const cur = c.result; if (!cur) { resolve(null); return; } if (cur.value.estado === "concluido" && (!filtro || filtro(cur.value))) { resolve(cur.value); return; } cur.continue(); };
        c.onerror = () => reject(c.error);
      });
    }
    async function verificarIntegridade(meta, payload) {
      if (!meta) return { ok: false, motivo: "snapshot_inexistente" };
      if (!payload) return { ok: false, motivo: "payload_ausente" };
      if (typeof meta.formato !== "number" || meta.formato > FORMATO) return { ok: false, motivo: "formato_desconhecido" };
      const dados = payload.dados;
      if (!dados || typeof dados !== "object" || !meta.hashes) return { ok: false, motivo: "payload_invalido" };
      const chaves = Object.keys(dados);
      if (chaves.length !== Object.keys(meta.hashes).length) return { ok: false, motivo: "chaves_divergentes" };
      for (const k of chaves) { if (typeof dados[k] !== "string") return { ok: false, motivo: "valor_invalido:" + k }; }
      if ((await sha256(canonico(dados, meta.formato))) !== meta.hashConteudo) return { ok: false, motivo: "hash_conteudo" };
      for (const k of chaves) { if ((await sha256(dados[k])) !== meta.hashes[k]) return { ok: false, motivo: "hash_chave:" + k }; }
      if ((await sha256(canonicoMeta(meta))) !== meta.hashMetadados) return { ok: false, motivo: "hash_metadados" };
      return { ok: true };
    }
    // Compare-and-set: só muda o estado se ainda for o esperado (impede duas abas de se atropelarem)
    async function transitar(db, id, de, para, extra, validarMeta) {
      return transacao(db, ["snapshots"], "readwrite", async (tx) => {
        const ls = tx.objectStore("snapshots"), m = await req(ls.get(id));
        if (!m) throw new ErroPipeline("cas", "snapshot_inexistente");
        if (m.estado !== de) return { mudou: false, estado: m.estado };
        if (validarMeta && !validarMeta(m)) throw new ErroPipeline("cas", "metadados_incoerentes");
        Object.assign(m, extra || {}); m.estado = para;
        await req(ls.put(m));
        return { mudou: true, estado: para };
      });
    }
    async function forcarInvalido(db, id, motivo) {
      return transacao(db, ["snapshots"], "readwrite", async (tx) => {
        const ls = tx.objectStore("snapshots"), m = await req(ls.get(id));
        if (!m || (INTERMEDIARIOS.indexOf(m.estado) === -1 && m.estado !== "concluido")) return false;
        m.estado = "invalido"; m.motivoInvalido = String(motivo); m.invalidadoEm = agora();
        await req(ls.put(m)); return true;
      });
    }

    /* ---------- Pipeline T1..T5 ---------- */
    const parar = (n) => {
      if (Number(t("pararAposTransacao")) === n) throw new ParadaTeste(n);
      if (Number(t("perderParticipacaoAposTransacao")) === n) perdaSimulada = true;
    };
    async function prepararSnapshot(db, cap, origem, op, dono) {
      const dados = cap.dados, inv = inventariar(dados), hashes = {};
      let tamanho = 0;
      for (const k of Object.keys(dados)) { hashes[k] = await sha256(dados[k]); tamanho += dados[k].length; }
      const hashConteudo = await sha256(canonico(dados, FORMATO));
      let base = null;
      try { base = await transacao(db, ["snapshots"], "readonly", (tx) => primeiroConcluido(tx.objectStore("snapshots"), (m) => m.qualidade === "saudavel" && m.origem !== "migracao_preventivo")); } catch (e) { base = null; }
      const q = avaliarQualidade(inv, base, op);
      const criadoEm = op.criadoEm || agora();
      const meta = {
        id: gerarId(), criadoEm, diaLocal: diaLocal(criadoEm), formato: FORMATO, origem, motivo: op.motivo || null, estado: "gravando",
        dono, evidencias: Object.assign({ usuarioSyncLocal: lerUsuarioSync() }, op.evidenciasExtra || {}),
        inventario: { estados: inv.estados, foraDoCatalogo: inv.fora }, completude: inv.completude, contagens: inv.contagens,
        hashes, hashConteudo, tamanhoBytes: tamanho, qualidade: q.qualidade, avisos: q.avisos, parcial: Boolean(op.parcial),
        tentativa: { abaId: ABA_ID, iniciadaEm: agora() }
      };
      meta.hashMetadados = await sha256(canonicoMeta(meta));
      return { meta, dados };
    }
    async function executarPipeline(cap, op) {
      const origem = op.origem || "manual";
      let id = null, etapa = "preparo";
      try {
        if (!shaDisponivel()) { estadoMod.sha = false; return falhou("sha256", "indisponivel_sha256", origem); }
        if (!op.interno && exclusivoPendente) return falhou("lock", "exclusivo_em_andamento", origem);
        if (!op.interno && !(await aguardarParticipacao(3000))) return falhou("lock", "sem_participacao", origem);
        let db;
        try { db = await abrirBanco(); estadoMod.idb = "ok"; } catch (e) { estadoMod.idb = "indisponivel"; return falhou("banco", "indisponivel_idb:" + (e && e.message || e), origem); }
        estadoMod.sha = true;
        exigirLock(op);
        const dono = op.donoPre || await resolverDono("auto");
        const { meta, dados } = await prepararSnapshot(db, cap, origem, op, dono);
        id = meta.id; estadosMemoria.set(id, "gravando");
        const atraso = Number(t("atrasoGravacaoMs")) || 0; if (atraso) await dormir(atraso);

        etapa = "T1"; exigirLock(op);
        const r1 = await transacao(db, ["snapshots", "payloads"], "readwrite", async (tx) => {
          const fg = t("falharGravacao"); if (fg === true || fg === origem) throw new Error("falha_gravacao_simulada");
          if (t("lancarQuota")) throw new DOMException("cota simulada", "QuotaExceededError");
          const ls = tx.objectStore("snapshots");
          if (!op.semDedupe) {                               // dedupe dentro da transação (serializada entre abas)
            const ult = await primeiroConcluido(ls);
            if (ult && ult.hashConteudo === meta.hashConteudo && ult.dono && ult.dono.classe === dono.classe && ult.dono.usuarioId === dono.usuarioId) return { dup: ult };
          }
          await req(tx.objectStore("payloads").put({ snapshotId: id, dados }));
          await req(ls.put(meta));
          return { dup: null };
        });
        if (r1.dup) { if (AUTORIZADORAS_SYNC.indexOf(origem) !== -1) autorizarSync(origem, r1.dup.id); return { ok: true, estado: "concluido", id: r1.dup.id, deduplicado: true, meta: r1.dup }; }
        parar(1);

        etapa = "T2"; exigirLock(op);
        const r2 = await transitar(db, id, "gravando", "confirmado", { confirmadoEm: agora() });
        if (!r2.mudou) throw new ErroPipeline("T2", "estado_inesperado:" + r2.estado);
        parar(2);

        etapa = "T3"; exigirLock(op);
        if (t("corromperPayloadAposGravar")) {
          await transacao(db, ["payloads"], "readwrite", async (tx) => { const p = await req(tx.objectStore("payloads").get(id)); const k = Object.keys(p.dados)[0]; if (k) p.dados[k] = p.dados[k] + " "; await req(tx.objectStore("payloads").put(p)); });
        }
        const lido = await lerCompleto(db, id);
        const v = await verificarIntegridade(lido.meta, lido.payload);
        if (!v.ok) { await forcarInvalido(db, id, v.motivo).catch(() => { /* ignora */ }); return falhou("T3", "verificacao:" + v.motivo, origem, id); }
        parar(3);

        etapa = "T4"; exigirLock(op);
        const r4 = await transitar(db, id, "confirmado", "verificado", { verificadoEm: agora() });
        if (!r4.mudou) throw new ErroPipeline("T4", "estado_inesperado:" + r4.estado);
        parar(4);

        etapa = "T5"; exigirLock(op);
        const r5 = await transitar(db, id, "verificado", "concluido", { concluidoEm: agora() }, (m) => m.hashMetadados === meta.hashMetadados);
        if (!r5.mudou) throw new ErroPipeline("T5", "estado_inesperado:" + r5.estado);
        parar(5);

        estadoMod.cota = false; ultimoSnapshot = { id, origem, em: agora(), classe: dono.classe, qualidade: meta.qualidade };
        const concluido = Object.assign({}, meta, { estado: "concluido" });
        if (AUTORIZADORAS_SYNC.indexOf(origem) !== -1) autorizarSync(origem, id);        // "concluido" (e só ele) libera a 1ª sincronização
        await aposConcluido(db, concluido, op);
        return { ok: true, estado: "concluido", id, deduplicado: false, meta: concluido };
      } catch (e) {
        if (e instanceof ParadaTeste) return { ok: false, etapa: "parada_de_teste", motivo: "parada_apos_tx" + e.n, id };
        const motivo = e && e.name === "QuotaExceededError" ? "cota" : (e && e.motivo) || String(e && e.message || e);
        if (motivo === "cota") estadoMod.cota = true;
        return falhou((e && e.etapa) || etapa, motivo, origem, id);
      } finally { perdaSimulada = false; if (id) estadosMemoria.delete(id); }
    }
    function gravarSnapshot(cap, op) {
      const p = executarPipeline(cap, op || {});
      pipelinesAtivos.add(p);
      p.then(() => pipelinesAtivos.delete(p), () => pipelinesAtivos.delete(p));
      return p;
    }
    async function aposConcluido(db, meta, op) {
      try {
        const prot = (op && op.protegerIds ? op.protegerIds.slice() : []), mk = marcadorAtual();
        if (mk) { if (mk.snapshotAlvo) prot.push(mk.snapshotAlvo); if (mk.preSnapshotId) prot.push(mk.preSnapshotId); }
        await aplicarRetencao(db, prot);
      } catch (e) { registrarFalha("retencao", e && e.message || e, meta.origem, meta.id); }
      if (!persistTentado) {
        persistTentado = true;
        try {
          const antes = await lerMeta("persist");
          if (antes === undefined) {
            let r = { suportado: false, concedido: false };
            if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.persist === "function") {
              try { r = { suportado: true, concedido: Boolean(await navigator.storage.persist()) }; } catch (e) { r = { suportado: true, concedido: false, erro: String(e && e.message || e) }; }
            }
            r.em = agora(); await gravarMeta("persist", r);
          }
        } catch (e) { /* ignora */ }
      }
    }

    /* ---------- Retenção ---------- */
    // União das categorias: um snapshot em várias categorias é mantido uma vez; só se apaga o que não está em nenhuma.
    function calcularRetencao(lista, protegidos) {
      const concl = lista.filter((m) => m.estado === "concluido").sort((a, b) => b.criadoEm - a.criadoEm);
      const manter = new Set();
      (protegidos || []).forEach((p) => manter.add(p));                                   // alvo/pré-snapshot de uma restauração
      if (concl[0]) manter.add(concl[0].id);                                              // último íntegro
      const ls = concl.find((m) => m.qualidade === "saudavel"); if (ls) manter.add(ls.id); // último saudável
      concl.filter((m) => m.origem === "migracao_preventivo").forEach((m) => manter.add(m.id));
      concl.filter((m) => ORIGENS_RISCO.indexOf(m.origem) !== -1).slice(0, 10).forEach((m) => manter.add(m.id));
      const dias = []; concl.forEach((m) => { if (dias.indexOf(m.diaLocal) === -1) dias.push(m.diaLocal); });
      dias.sort().reverse();
      const janelaDiaria = dias.slice(0, 14);
      janelaDiaria.forEach((d) => manter.add(concl.find((x) => x.diaLocal === d).id));
      const corte1 = janelaDiaria.length ? janelaDiaria[janelaDiaria.length - 1] : null;
      const anteriores = corte1 ? concl.filter((m) => m.diaLocal < corte1) : [];
      const semanas = []; anteriores.forEach((m) => { const s = semanaLocal(m.diaLocal); if (semanas.indexOf(s) === -1) semanas.push(s); });
      semanas.sort().reverse();
      const janelaSemanal = semanas.slice(0, 8);
      janelaSemanal.forEach((s) => manter.add(anteriores.find((x) => semanaLocal(x.diaLocal) === s).id));
      const corte2 = janelaSemanal.length ? janelaSemanal[janelaSemanal.length - 1] : corte1;
      const anteriores2 = corte2 ? concl.filter((m) => m.diaLocal < corte2) : [];
      const meses = []; anteriores2.forEach((m) => { const s = mesLocal(m.diaLocal); if (meses.indexOf(s) === -1) meses.push(s); });
      meses.sort().reverse();
      meses.slice(0, 6).forEach((s) => manter.add(anteriores2.find((x) => mesLocal(x.diaLocal) === s).id));
      const apagar = concl.filter((m) => !manter.has(m.id)).map((m) => m.id);
      // inválidos/falhos: nunca recuperáveis; ficam só os 3 mais recentes para diagnóstico
      lista.filter((m) => m.estado === "invalido" || m.estado === "falhou").sort((a, b) => b.criadoEm - a.criadoEm).slice(3).forEach((m) => apagar.push(m.id));
      return { manter, apagar };
    }
    // Só é chamada logo após um NOVO snapshot chegar a "concluido"; nunca por falta de espaço
    async function aplicarRetencao(db, protegidos) {
      const { apagar } = calcularRetencao(await listarMetas(db), protegidos);
      let n = 0;
      for (const id of apagar) {
        try {
          await transacao(db, ["snapshots", "payloads"], "readwrite", async (tx) => { await req(tx.objectStore("snapshots").delete(id)); await req(tx.objectStore("payloads").delete(id)); });
          n++;
        } catch (e) { registrarFalha("retencao_exclusao", e && e.message || e, null, id); }
      }
      return n;
    }

    /* ---------- Recuperação de snapshots interrompidos (somente sob lock exclusivo) ---------- */
    async function recuperarUm(db, id) {
      const lido = await lerCompleto(db, id);
      if (!lido.meta) return { id, resultado: "inexistente" };
      if (INTERMEDIARIOS.indexOf(lido.meta.estado) === -1) return { id, resultado: "ja_resolvido", estado: lido.meta.estado };
      const v = await verificarIntegridade(lido.meta, lido.payload);            // confere dados e hashes ANTES de promover
      if (!v.ok) { await forcarInvalido(db, id, v.motivo); return { id, resultado: "invalido", motivo: v.motivo }; }
      let estadoAtual = lido.meta.estado;
      const passos = [["gravando", "confirmado", { confirmadoEm: agora() }], ["confirmado", "verificado", { verificadoEm: agora() }], ["verificado", "concluido", { concluidoEm: agora(), recuperadoEm: agora() }]];
      for (const p of passos) {
        if (estadoAtual !== p[0]) continue;
        const r = await transitar(db, id, p[0], p[1], p[2], p[1] === "concluido" ? (m) => m.hashMetadados === lido.meta.hashMetadados : null);
        if (!r.mudou) return { id, resultado: "concorrencia", estado: r.estado };
        estadoAtual = p[1];
      }
      return { id, resultado: "concluido" };
    }
    // Não há decisão por tempo: sem o lock exclusivo, os intermediários permanecem pendentes.
    async function recuperarIntermediarios() {
      if (estadoMod.idb === "indisponivel" || !shaDisponivel()) return { ok: false, motivo: "indisponivel" };
      const db = await abrirBanco();
      const pend = await listarMetas(db, (m) => INTERMEDIARIOS.indexOf(m.estado) !== -1);
      if (!pend.length) return { ok: true, processados: 0, resultados: [] };
      return comExclusivo(async () => {
        const resultados = [];
        const agoraPend = (await listarMetas(db, (m) => INTERMEDIARIOS.indexOf(m.estado) !== -1)).sort((a, b) => a.criadoEm - b.criadoEm);
        for (const m of agoraPend) { try { resultados.push(await recuperarUm(db, m.id)); } catch (e) { resultados.push({ id: m.id, resultado: "erro", motivo: String(e && e.message || e) }); } }
        return { ok: true, processados: resultados.length, resultados };
      });
    }
    // Rotina: relê o snapshot concluído mais recente; só pode REBAIXAR (nunca promove)
    async function verificarUltimoConcluido(db) {
      const ult = await transacao(db, ["snapshots"], "readonly", (tx) => primeiroConcluido(tx.objectStore("snapshots")));
      if (!ult) return;
      const lido = await lerCompleto(db, ult.id), v = await verificarIntegridade(lido.meta, lido.payload);
      if (!v.ok) { await forcarInvalido(db, ult.id, "rotina:" + v.motivo); registrarFalha("verificacao_rotina", v.motivo, ult.origem, ult.id); }
    }

    /* ---------- Migração única do backup preventivo antigo (o original nunca é tocado) ---------- */
    async function migrarPreventivo() {
      const m = await lerMeta("migracaoPreventivo");
      if (m && m.feita) return;
      let bruto = null; try { bruto = localStorage.getItem(CHAVE_PREVENTIVO); } catch (e) { return; }
      if (bruto === null) return;
      const hashOrigem = await sha256(bruto);
      if (m && m.hashOrigem === hashOrigem) return;                              // já tentado com este conteúdo
      let obj = null; try { obj = JSON.parse(bruto); } catch (e) { obj = null; }
      const p = obj && obj.pacote && typeof obj.pacote === "object" ? obj.pacote : null;
      if (!p || !Array.isArray(p.movimentacoes)) { await gravarMeta("migracaoPreventivo", { feita: false, hashOrigem, motivo: "estrutura_invalida", em: agora() }); return; }
      const dados = {};
      ["movimentacoes", "combustivel", "manutencoes", "turnos", "objetivos", "veiculos"].forEach((k) => { if (Array.isArray(p[k])) dados[PREFIXO + k] = JSON.stringify(p[k]); });
      if (Number(p.metaSemanal) > 0) dados[PREFIXO + "metaSemanal"] = String(Number(p.metaSemanal));
      if (Number(p.metaMensal) > 0) dados[PREFIXO + "metaMensal"] = String(Number(p.metaMensal));
      const quando = Date.parse(obj.criadoEm);
      const r = await gravarSnapshot({ dados }, {
        origem: "migracao_preventivo", motivo: "importacao_unica", criadoEm: Number.isFinite(quando) ? quando : agora(), semDedupe: true, parcial: true,
        qualidadeFixa: "nao_avaliado", avisos: ["parcial:sem_remuneracao_veiculo_ativo_turnos_e_frete"],
        donoPre: desconhecido("migracao_preventivo"), evidenciasExtra: { usuarioDeclarado: typeof obj.usuario === "string" ? obj.usuario : null, hashOrigem }
      });
      if (r.ok) await gravarMeta("migracaoPreventivo", { feita: true, hashOrigem, snapshotId: r.id, em: agora() });
      else await gravarMeta("migracaoPreventivo", { feita: false, hashOrigem, motivo: "falha:" + r.motivo, em: agora() });
    }

    /* ---------- Marcador persistente de restauração / recuperação pendente ---------- */
    function lerMarcadorLS() {
      try {
        const b = localStorage.getItem(CHAVE_RECUPERACAO); if (b === null) return null;
        const o = JSON.parse(b); return o && typeof o === "object" ? o : { estado: "pendente", motivo: "marcador_ilegivel" };
      } catch (e) { return { estado: "pendente", motivo: "marcador_ilegivel" }; }
    }
    const marcadorAtual = () => lerMarcadorLS() || marcadorMemoria;
    async function gravarMarcador(m) {
      marcadorMemoria = m;
      const espelho = { estado: m.estado, snapshotAlvo: m.snapshotAlvo || null, preSnapshotId: m.preSnapshotId || null, etapa: m.etapa || null, desde: m.desde || null, motivo: m.motivo || null };
      try { lsSet.call(localStorage, CHAVE_RECUPERACAO, JSON.stringify(espelho)); } catch (e) { /* ignora */ }
      try { await gravarMeta("recuperacao", m); } catch (e) { /* ignora */ }
    }
    async function limparMarcador() {
      marcadorMemoria = null;
      try { lsRem.call(localStorage, CHAVE_RECUPERACAO); } catch (e) { /* ignora */ }
      try { await gravarMeta("recuperacao", null); } catch (e) { /* ignora */ }
    }
    function bloqueioDe(origem) {
      if (origem === "pre_ativacao_sync" && !locksDisponivel()) return "Este navegador não oferece a coordenação entre abas (Web Locks). Por segurança, a sincronização não pode ser ativada aqui.";
      const m = marcadorAtual(); if (!m) return null;
      if (m.estado === "em_andamento") return "Há uma restauração de dados em andamento neste aparelho. Aguarde a conclusão e tente de novo.";
      if (m.estado === "pendente" && origem === "pre_ativacao_sync") return "Há uma recuperação de dados pendente neste aparelho. A sincronização não pode ser ativada até que ela seja resolvida.";
      return null;
    }

    /* ---------- Pausa da sincronização (usa só os mecanismos existentes do sync.js) ---------- */
    function verificarSyncParadaSincrono() {
      try {
        if (typeof sincronizando !== "undefined" && sincronizando === true) return { ok: false, motivo: "sincronizacao_em_andamento" };
        if (typeof estadoSync !== "undefined" && estadoSync && estadoSync.ativo) return { ok: false, motivo: "sincronizacao_ativa" };
        const raw = localStorage.getItem(CHAVE_SYNC);
        if (raw) { const o = JSON.parse(raw); if (o && o.ativo === true) return { ok: false, motivo: "sincronizacao_ativa_no_armazenamento" }; }
      } catch (e) { return { ok: false, motivo: "estado_sync_ilegivel" }; }
      return { ok: true };
    }
    async function pausarSyncParaRestauro() {
      try {
        if (typeof estadoSync !== "undefined" && estadoSync && estadoSync.ativo) {
          if (typeof pausarSincronizacao !== "function") return { ok: false, motivo: "pausar_indisponivel" };
          pausarSincronizacao();
        }
      } catch (e) { return { ok: false, motivo: "pausar_erro" }; }
      const limite = agora() + ESPERA_SYNC_MS;
      while (typeof sincronizando !== "undefined" && sincronizando === true) {       // não há como cancelar um ciclo: só aguardar
        if (agora() > limite) return { ok: false, motivo: "sincronizacao_em_andamento" };
        await dormir(100);
      }
      return verificarSyncParadaSincrono();
    }

    /* ---------- Plano de restauração ---------- */
    function contarItem(chave, texto) { const it = CATALOGO_POR_CHAVE[chave]; if (!it || texto === null) return null; const r = avaliarItem(it, texto); return r.n !== undefined ? r.n : (r.estado === "presente_legivel" ? 1 : -1); }
    async function montarPlano(db, id, opcoes) {
      opcoes = opcoes || {};
      const bloqueios = [], conflitos = [], avisos = [], itens = [], comparativo = {};
      const { meta, payload } = await lerCompleto(db, id);
      if (!meta) return { ok: false, snapshotId: id, bloqueios: ["snapshot_inexistente"], conflitos, avisos, itens };
      if (meta.estado !== "concluido") bloqueios.push("snapshot_nao_concluido:" + meta.estado);
      const v = await verificarIntegridade(meta, payload);
      if (!v.ok) bloqueios.push("integridade:" + v.motivo);
      const atual = capturarBruto();
      if (!atual) bloqueios.push("captura_atual_falhou");
      const donoAtual = await resolverDono("restauro");
      const comp = donoCompativel(meta.dono, donoAtual);
      if (!comp.ok) bloqueios.push(comp.motivo);
      if (bloqueios.length) return { ok: false, snapshotId: id, bloqueios, conflitos, avisos, itens, donoSnapshot: meta.dono, donoAtual };

      const sel = new Set(Array.isArray(opcoes.grupos) ? opcoes.grupos : GRUPOS_PADRAO);
      if (opcoes.incluirTurnoAtual) sel.add("turno_em_andamento"); else sel.delete("turno_em_andamento");
      const snap = payload.dados, cur = atual.dados;
      const vs = (k) => (Object.prototype.hasOwnProperty.call(snap, k) ? snap[k] : null), va = (k) => (Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null);
      const idsTurnos = new Set();
      try { (JSON.parse((sel.has("nucleo") ? vs(CHAVE_TURNOS) : va(CHAVE_TURNOS)) || "[]") || []).forEach((x) => { if (x && x.id !== undefined) idsTurnos.add(String(x.id)); }); } catch (e) { /* ignora */ }

      sel.forEach((g) => {
        if (g === "outros") {                                                   // chaves desconhecidas: só gravam, nunca removem
          Object.keys(snap).filter((k) => !CATALOGO_POR_CHAVE[k]).forEach((k) => { itens.push({ chave: k, grupo: "outros", acao: snap[k] === va(k) ? "manter" : "gravar", valor: snap[k] }); });
          return;
        }
        const chaves = chavesDoGrupo(g);
        if (!chaves.length) { avisos.push("grupo_desconhecido:" + g); return; }
        chaves.forEach((k) => {
          const s = vs(k), a = va(k);
          comparativo[k] = { atual: contarItem(k, a), snapshot: contarItem(k, s) };
          let acao, motivoConflito = null;
          if (g === "turno_encerrado" || g === "turno_em_andamento") {            // ausência no snapshot nunca remove o estado atual
            if (s === null) { acao = "manter"; if (a !== null) avisos.push("preservado_sem_equivalente_no_snapshot:" + k); }
            else if (s === a) acao = "manter";
            else {
              if (g === "turno_encerrado") {
                let idSnap = null; try { idSnap = String(JSON.parse(s).id); } catch (e) { /* ignora */ }
                if (a !== null) motivoConflito = "turno_encerrado_atual_existe";
                else if (va(CHAVE_TURNO_ATUAL) !== null && !(sel.has("turno_em_andamento") && opcoes.substituirTurnoAtual)) motivoConflito = "turno_em_andamento_atual_existe";
                else if (idSnap !== null && idsTurnos.has(idSnap)) motivoConflito = "turno_ja_registrado";
              } else {
                if (a !== null && !opcoes.substituirTurnoAtual) motivoConflito = "turno_em_andamento_atual_existe";
                else if (va(CHAVE_TURNO_ENCERRADO) !== null) motivoConflito = "turno_encerrado_atual_existe";
                try { const inicio = JSON.parse(s).inicio; if (Number.isFinite(inicio)) avisos.push("turno_em_andamento_idade_horas:" + Math.round((agora() - inicio) / 360000) / 10); } catch (e) { /* ignora */ }
              }
              if (motivoConflito) { acao = "manter"; conflitos.push({ chave: k, motivo: motivoConflito }); } else acao = "gravar";
            }
          } else if (s === null) acao = a === null ? "manter" : "remover";
          else acao = s === a ? "manter" : "gravar";
          itens.push({ chave: k, grupo: g, acao, valor: acao === "gravar" ? s : undefined });
        });
      });
      return { ok: true, snapshotId: id, bloqueios, conflitos, avisos, itens, comparativo, donoSnapshot: meta.dono, donoAtual, grupos: Array.from(sel), formato: meta.formato };
    }

    /* ---------- Rollback ---------- */
    async function reverterParaPre(db, preId, capA, preMeta) {
      let origem = null;
      try {
        const lido = await lerCompleto(db, preId), v = await verificarIntegridade(lido.meta, lido.payload);
        if (v.ok) { origem = lido.payload.dados; preMeta = lido.meta; }
      } catch (e) { /* tenta a cópia em memória */ }
      if (!origem && capA && preMeta && (await sha256(canonico(capA.dados, preMeta.formato))) === preMeta.hashConteudo) origem = capA.dados;
      if (!origem) return { ok: false, motivo: "origem_do_rollback_indisponivel" };
      // bloco síncrono: nenhuma outra tarefa desta aba roda entre as escritas
      const atual = capturarBruto();
      const todas = new Set(Object.keys(origem).concat(atual ? Object.keys(atual.dados) : []));
      try {
        if (t("falharRollback")) throw new Error("falha_rollback_simulada");
        todas.forEach((k) => { if (Object.prototype.hasOwnProperty.call(origem, k)) lsSet.call(localStorage, k, origem[k]); else lsRem.call(localStorage, k); });
      } catch (e) { return { ok: false, motivo: "rollback_escrita:" + (e && e.message || e) }; }
      const depois = capturarBruto();
      if (!depois || !mesmoConteudo(origem, depois.dados)) return { ok: false, motivo: "rollback_nao_confere" };
      for (const k of Object.keys(origem)) { if (preMeta && preMeta.hashes && (await sha256(depois.dados[k])) !== preMeta.hashes[k]) return { ok: false, motivo: "rollback_hash:" + k }; }
      return { ok: true };
    }

    /* ---------- Restauração (NÃO é atômica: várias chaves independentes) ---------- */
    async function restaurarSobLock(id, opcoes) {
      const db = await abrirBanco();
      // 1-3. validar o snapshot integralmente, o proprietário e montar o plano
      const plano = await montarPlano(db, id, opcoes);
      if (!plano.ok) return { ok: false, motivo: "bloqueado", bloqueios: plano.bloqueios };
      // 4-5. snapshot de segurança do estado atual, gravado e verificado
      const capA = capturarBruto();
      if (!capA) return { ok: false, motivo: "captura_atual_falhou" };
      const pre = await gravarSnapshot(capA, { origem: "pre_restauracao", motivo: "restauracao:" + id, interno: true, donoPre: plano.donoAtual, protegerIds: [id] });
      if (!pre.ok) return { ok: false, motivo: "pre_restauracao_falhou", detalhe: pre.motivo };            // nada foi tocado
      const preMeta = pre.meta;
      const esperado = {};
      for (const it of plano.itens) { if (it.acao === "gravar") esperado[it.chave] = await sha256(it.valor); else if (it.acao === "remover") esperado[it.chave] = null; }
      // 6. marcador persistente + 7. pausar a sincronização
      await gravarMarcador({ estado: "em_andamento", snapshotAlvo: id, preSnapshotId: pre.id, etapa: "preparo", desde: agora(), esperado });
      const pz = await pausarSyncParaRestauro();
      if (!pz.ok) { await limparMarcador(); return { ok: false, motivo: pz.motivo }; }
      // revalidar o proprietário imediatamente antes de aplicar (sem TTL)
      const g0 = geracaoSessao;
      const dono2 = await resolverDono("restauro");
      const comp = donoCompativel(plano.donoSnapshot, dono2);
      if (!comp.ok || geracaoSessao !== g0) { await limparMarcador(); return { ok: false, motivo: "dono_mudou_ou_incompativel", detalhe: comp.motivo }; }
      const atrasoR = Number(t("atrasoRestauracaoMs")) || 0; if (atrasoR) await dormir(atrasoR);

      // ===== A PARTIR DAQUI NÃO PODE HAVER "await" ATÉ O FIM DA APLICAÇÃO (bloco síncrono) =====
      const capB = capturarBruto();
      if (!capB || !mesmoConteudo(capA.dados, capB.dados)) { await limparMarcador(); return { ok: false, motivo: "estado_mudou", detalhe: "o armazenamento mudou durante a preparação; nada foi aplicado" }; }
      const sy = verificarSyncParadaSincrono();
      if (!sy.ok) { await limparMarcador(); return { ok: false, motivo: sy.motivo }; }
      const esperadoFinal = Object.assign({}, capA.dados);
      let erroAplicar = null, n = 0, gravadas = 0, removidas = 0;
      try {
        for (const it of plano.itens) {
          if (it.acao === "manter") continue;
          n++;
          if (Number(t("falharAoAplicarChave")) === n) throw new Error("falha_aplicar_simulada");
          if (it.acao === "gravar") { lsSet.call(localStorage, it.chave, it.valor); esperadoFinal[it.chave] = it.valor; gravadas++; }
          else { lsRem.call(localStorage, it.chave); delete esperadoFinal[it.chave]; removidas++; }
        }
      } catch (e) { erroAplicar = e; }
      const capC = capturarBruto();
      // ===== FIM DO BLOCO SÍNCRONO =====

      let erroValidar = erroAplicar ? "aplicacao:" + (erroAplicar.message || erroAplicar) : null;
      if (!erroValidar) {
        if (!capC || !mesmoConteudo(esperadoFinal, capC.dados)) erroValidar = "conteudo_final_diferente_do_esperado";   // inclui as chaves fora do plano
        else {
          const inv = inventariar(capC.dados);
          for (const it of plano.itens) {
            if (it.acao !== "gravar") continue;
            if ((await sha256(capC.dados[it.chave])) !== esperado[it.chave]) { erroValidar = "hash:" + it.chave; break; }
            const c = plano.comparativo && plano.comparativo[it.chave];
            if (c && c.snapshot !== null && inv.contagens[it.chave] !== undefined && inv.contagens[it.chave] !== c.snapshot) { erroValidar = "contagem:" + it.chave; break; }
          }
        }
      }
      if (!erroValidar) {
        try { await gravarMeta("ultimaRestauracao", { snapshotId: id, preSnapshotId: pre.id, em: agora(), resultado: "ok", gravadas, removidas, conflitos: plano.conflitos }); } catch (e) { /* ignora */ }
        await limparMarcador();                                  // a sincronização permanece PAUSADA (reativação é manual)
        try { sessionStorage.setItem(SS_RESULTADO, JSON.stringify({ ok: true, em: agora(), snapshotId: id, gravadas, removidas })); } catch (e) { /* ignora */ }
        if (!t("semRecarregar")) setTimeout(() => { try { location.reload(); } catch (e) { /* ignora */ } }, 150);
        return { ok: true, snapshotId: id, preSnapshotId: pre.id, gravadas, removidas, conflitos: plano.conflitos, avisos: plano.avisos, recarregando: !t("semRecarregar") };
      }
      // rollback a partir do snapshot de segurança e validação do rollback
      await gravarMarcador({ estado: "em_andamento", snapshotAlvo: id, preSnapshotId: pre.id, etapa: "rollback", desde: agora(), esperado });
      const rb = await reverterParaPre(db, pre.id, capA, preMeta);
      if (rb.ok) {
        await limparMarcador();
        registrarFalha("restauracao", erroValidar, "restauracao", id);
        return { ok: false, motivo: "falha_na_aplicacao", detalhe: erroValidar, rollback: "ok" };
      }
      await gravarMarcador({ estado: "pendente", snapshotAlvo: id, preSnapshotId: pre.id, etapa: "rollback_falhou", desde: agora(), motivo: rb.motivo, esperado });
      aviso("A restauração falhou e a recuperação automática também. A sincronização continua pausada; há uma recuperação pendente.", true);
      registrarFalha("rollback", rb.motivo, "restauracao", id);
      return { ok: false, motivo: "recuperacao_pendente", detalhe: erroValidar, rollback: "falhou", rollbackMotivo: rb.motivo };
    }
    async function restaurar(id, opcoes) {
      if (!locksDisponivel()) return { ok: false, motivo: "sem_web_locks" };
      if (!shaDisponivel()) return { ok: false, motivo: "indisponivel_sha256" };
      const m = marcadorAtual();
      if (m) return { ok: false, motivo: m.estado === "pendente" ? "recuperacao_pendente" : "restauracao_em_andamento" };
      try { await abrirBanco(); } catch (e) { return { ok: false, motivo: "indisponivel_idb" }; }
      return comExclusivo(() => restaurarSobLock(id, opcoes || {}));
    }
    async function resolverRecuperacao(opcoes) {
      const acao = opcoes && opcoes.acao;
      if (acao !== "reverter" && acao !== "concluir") return { ok: false, motivo: "acao_invalida" };
      return comExclusivo(async () => {
        const db = await abrirBanco();
        let m = null; try { m = await lerMeta("recuperacao"); } catch (e) { /* ignora */ }
        m = m || marcadorAtual();
        if (!m) return { ok: false, motivo: "sem_recuperacao" };
        if (acao === "reverter") {
          const rb = await reverterParaPre(db, m.preSnapshotId, null, null);
          if (rb.ok) { await limparMarcador(); return { ok: true, acao }; }
          return { ok: false, motivo: rb.motivo };
        }
        const atual = capturarBruto(), esp = m.esperado || {};
        let ok = Boolean(atual);
        for (const k of Object.keys(esp)) {
          if (!ok) break;
          if (esp[k] === null) ok = !Object.prototype.hasOwnProperty.call(atual.dados, k);
          else ok = Object.prototype.hasOwnProperty.call(atual.dados, k) && (await sha256(atual.dados[k])) === esp[k];
        }
        if (!ok) return { ok: false, motivo: "estado_nao_corresponde_ao_esperado" };
        await limparMarcador(); return { ok: true, acao };
      });
    }
    // Restauração interrompida (aba fechada): só se conclui "pendente" sob lock exclusivo (prova de que nenhuma outra aba a executa)
    async function verificarMarcadorInterrompido() {
      let m = marcadorAtual();
      if (!m || m.estado !== "em_andamento") return;
      const r = await comExclusivo(async () => {
        const atual = marcadorAtual();
        if (atual && atual.estado === "em_andamento") {
          const completo = Object.assign({}, (await lerMeta("recuperacao")) || atual, { estado: "pendente", etapa: "interrompida", motivo: "interrompida", desde: agora() });
          await gravarMarcador(completo);
          aviso("Uma restauração de dados foi interrompida. A sincronização continua pausada; há uma recuperação pendente neste aparelho.", true);
        }
        return { ok: true };
      });
      return r;
    }

    /* ---------- Proteção das operações de risco já existentes ---------- */
    async function garantir(op) {
      op = op || {};
      const prazo = Number(t("prazoGarantirMs")) || PRAZO_GARANTIR_MS;
      const cap = capturarBruto();
      if (!cap) return falhou("captura", "captura_falhou", op.origem);
      const p = gravarSnapshot(cap, { origem: op.origem || "manual", motivo: op.motivo });
      return Promise.race([p, dormir(prazo).then(() => falhou("prazo", "prazo_esgotado", op.origem))]);
    }
    function confirmarSemCopia(motivo) {
      return confirm("Não foi possível criar a cópia de segurança independente neste aparelho (" + (motivo || "motivo desconhecido") + ").\n\nSe continuar, esta operação será feita SEM essa cópia. Deseja continuar mesmo assim?");
    }
    async function protegerOperacao(origem, descricao) {
      try {
        const bl = bloqueioDe(origem);
        if (bl) { aviso(bl, true); return false; }
        const r = await garantir({ origem, motivo: descricao });
        if (r && r.ok) return true;
        return confirmarSemCopia(r && r.motivo);
      } catch (e) { return confirmarSemCopia(e && e.message); }
    }

    // Ativação manual da sincronização: snapshot "pre_ativacao_sync" OBRIGATÓRIO. Sem confirmação "continuar sem cópia":
    // bloqueio (Web Locks ausente, recuperação pendente, restauração em andamento) ou falha => { ok:false }.
    async function garantirAtivacaoSync(motivo) {
      try {
        const bl = bloqueioDe("pre_ativacao_sync");
        if (bl) { aviso(bl, true); return { ok: false, etapa: "bloqueio", motivo: "bloqueado" }; }
        const r = await garantir({ origem: "pre_ativacao_sync", motivo: motivo || "ativação da sincronização" });
        return r && r.ok ? r : { ok: false, etapa: r && r.etapa, motivo: (r && r.motivo) || "falha" };
      } catch (e) { return { ok: false, etapa: "erro", motivo: String((e && e.message) || e) }; }
    }

    /* ---------- Gatilhos automáticos ---------- */
    async function verificarGatilhos(evento) {
      if (estadoMod.idb !== "ok" || !shaDisponivel() || exclusivoPendente) return;
      const hoje = diaLocal(agora());
      const ud = await lerMeta("ultimoDiario");
      if (ud !== hoje) { const r = await garantir({ origem: "diario", motivo: evento }); if (r.ok) await gravarMeta("ultimoDiario", hoje); return; }
      if (evento !== "oculto") return;
      const info = (await lerMeta("alteracao")) || {}, n = info.dia === hoje ? info.n : 0;
      if (n >= MAX_ALTERACAO_DIA || agora() - (info.em || 0) < INTERVALO_ALTERACAO_MS) return;
      const cap = capturarBruto(); if (!cap) return;
      const h = await sha256(canonico(cap.dados, FORMATO));
      if (h === ultimoHashTentado) return;
      ultimoHashTentado = h;
      const r = await gravarSnapshot(cap, { origem: "alteracao", motivo: evento });
      if (r.ok && !r.deduplicado) await gravarMeta("alteracao", { dia: hoje, n: n + 1, em: agora() });
    }
    async function fluxoInicial(capturaInicial, escondido) {         // capturaInicial: função (a captura é refeita quando o lock é obtido)
      try {
        // modo carregador: nada acontece antes de a aba obter o lock e de o app terminar de carregar
        if (await decisaoModo) { await appLiberadoPromise; await appCarregadoPromise; }
        // sem Web Locks (e com bloqueio obrigatório) o módulo não faz nada: nem abre o IndexedDB nem grava snapshots
        if ((BLOQUEAR_APP_SEM_WEB_LOCKS || t("exigirWebLocks") === true) && !locksDisponivel()) { protecao = { estado: "indisponivel", motivo: "sem_web_locks", concluidoEm: null }; return; }
        if (!shaDisponivel()) { estadoMod.sha = false; protecao = { estado: "indisponivel", motivo: "indisponivel_sha256", concluidoEm: null }; registrarFalha("inicio", "indisponivel_sha256"); return; }
        try { await abrirBanco(); estadoMod.idb = "ok"; } catch (e) { estadoMod.idb = "indisponivel"; protecao = { estado: "indisponivel", motivo: "indisponivel_idb", concluidoEm: null }; try { console.warn("[MovixBackup] IndexedDB indisponível:", e && e.message || e); } catch (x) { /* ignora */ } return; }
        try { const mi = await lerMeta("recuperacao"); if (mi && !lerMarcadorLS()) { marcadorMemoria = mi; try { lsSet.call(localStorage, CHAVE_RECUPERACAO, JSON.stringify({ estado: mi.estado, snapshotAlvo: mi.snapshotAlvo || null, preSnapshotId: mi.preSnapshotId || null, etapa: mi.etapa || null, desde: mi.desde || null, motivo: mi.motivo || null })); } catch (e) { /* ignora */ } } else if (mi) marcadorMemoria = mi; } catch (e) { /* ignora */ }
        try { await verificarUltimoConcluido(await abrirBanco()); } catch (e) { registrarFalha("verificacao_rotina", e && e.message || e); }
        await Promise.race([aguardarAuth(ESPERA_AUTH_MS), escondido]);
        if (capturaInicial()) {
          const op = { origem: "inicializacao", motivo: "carregamento" };
          if (!authInicializada) op.donoPre = desconhecido(linkEmail ? "fluxo_link_email" : "auth_nao_inicializada");
          const r = await gravarSnapshot(capturaInicial(), op);
          if (!r.ok && protecao.estado !== "concluida") protecao = { estado: "falhou", motivo: r.motivo || "falha", concluidoEm: null };
          if (r.ok) { try { ultimoHashTentado = r.meta ? r.meta.hashConteudo : null; await gravarMeta("ultimoDiario", diaLocal(agora())); } catch (e) { /* ignora */ } }
        }
        try { await migrarPreventivo(); } catch (e) { registrarFalha("migracao_preventivo", e && e.message || e); }
        try { await verificarMarcadorInterrompido(); } catch (e) { registrarFalha("marcador", e && e.message || e); }
        await dormir(1000);
        try { await recuperarIntermediarios(); } catch (e) { registrarFalha("recuperacao", e && e.message || e); }
      } finally { inicialConcluido = true; resolverPronto(true); }
    }
    let resolverPronto = null;
    const prontoPromessa = new Promise((r) => { resolverPronto = r; });

    /* ---------- API pública ---------- */
    function estado() {
      return { marcos: Object.assign({}, marcos), protecao: Object.assign({}, protecao), contadores: Object.assign({}, contadores), modoCarregador, aguardandoLock, semWebLocks: !locksDisponivel(), disponivel: estadoMod.idb !== "indisponivel" && estadoMod.sha, idb: estadoMod.idb, sha256: estadoMod.sha, cota: estadoMod.cota, webLocks: locksDisponivel(), participando, emExclusivo, authInicializada, ultimaFalha, ultimoSnapshot, pipelinesAtivos: pipelinesAtivos.size, emMemoria: Array.from(estadosMemoria.entries()), recuperacao: marcadorAtual(), inicialConcluido };
    }
    async function diagnostico() {
      const db = await abrirBanco(), todos = await listarMetas(db), porEstado = {};
      todos.forEach((m) => { porEstado[m.estado] = (porEstado[m.estado] || 0) + 1; });
      return { porEstado, falhas: await lerMeta("falhas"), persist: await lerMeta("persist"), migracao: await lerMeta("migracaoPreventivo"), ultimaRestauracao: await lerMeta("ultimaRestauracao") };
    }
    async function listar(opcoes) {
      opcoes = opcoes || {};
      const db = await abrirBanco(), todos = await listarMetas(db, opcoes.incluirTodos ? null : (m) => m.estado === "concluido");
      return todos.sort((a, b) => b.criadoEm - a.criadoEm).map((m) => ({ id: m.id, criadoEm: m.criadoEm, origem: m.origem, estado: m.estado, qualidade: m.qualidade, dono: m.dono, contagens: m.contagens, avisos: m.avisos, parcial: m.parcial, completude: m.completude, tamanhoBytes: m.tamanhoBytes, motivoInvalido: m.motivoInvalido || null }));
    }
    async function verificar(id) {
      const db = await abrirBanco(), lido = await lerCompleto(db, id);
      const v = await verificarIntegridade(lido.meta, lido.payload);
      return Object.assign({ id, estado: lido.meta ? lido.meta.estado : null }, v);
    }
    function ultimoResultado() {
      try { const r = sessionStorage.getItem(SS_RESULTADO); if (r) { sessionStorage.removeItem(SS_RESULTADO); return JSON.parse(r); } } catch (e) { /* ignora */ }
      return null;
    }
    window.MovixBackup = {
      versao: FORMATO, garantir, criar: garantir, protegerOperacao, garantirAtivacaoSync, listar, verificar, diagnostico, estado,
      aguardarInicio, appCarregado, syncAutorizada,
      planejarRestauracao: async (id, opcoes) => montarPlano(await abrirBanco(), id, opcoes), restaurar, resolverRecuperacao,
      recuperarIntermediarios, pronto: () => prontoPromessa, ultimoResultado,
      _puro: { calcularRetencao, canonico, estavel, semanaLocal, diaLocal, avaliarItem, donoCompativel, inventariar }
    };

    /* ---------- Início (síncrono, antes de script.js: captura os textos brutos antes de qualquer gravação do app) ---------- */
    capturaAtual = capturarBruto();
    observarAuth();
    iniciarParticipacao();
    if (t("semAutomaticos")) { resolverPronto(true); return; }
    let escondidoResolver = null;
    const escondido = new Promise((r) => { escondidoResolver = r; });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") { escondidoResolver(true); verificarGatilhos("oculto").catch(() => { /* ignora */ }); }
      else {
        verificarGatilhos("visivel").catch(() => { /* ignora */ });
        if (agora() - ultimaRecuperacaoTentativa > 5 * 60000) { ultimaRecuperacaoTentativa = agora(); recuperarIntermediarios().catch(() => { /* ignora */ }); }
      }
    });
    setInterval(() => { verificarGatilhos("intervalo").catch(() => { /* ignora */ }); }, 15 * 60000);
    const avisarResultado = () => { const r = ultimoResultado(); if (r && r.ok) aviso("Backup restaurado. A sincronização continua pausada neste aparelho."); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", avisarResultado, { once: true }); else avisarResultado();
    fluxoInicial(() => capturaAtual, escondido);


  }
})();
