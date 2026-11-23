/* =====================================================
   Movix – Sincronização com o Supabase (Fase 3.4)
   Modelo "local primeiro": o app continua usando o LocalStorage; a nuvem
   é um espelho sincronizado em segundo plano (e funciona offline).
   Depende de config.js, script.js e auth.js (usa funções e variáveis de lá).

   Como funciona (resumo):
   1. ENVIAR: compara cada registro local com a "foto" da última sincronização
      (snapshot). Novos/alterados viram upsert; o que sumiu do aparelho vira
      exclusão lógica (deleted_at) na nuvem. A ordem respeita as chaves
      estrangeiras: veículos -> abastecimentos/manutenções -> movimentações.
   2. RECEBER: busca na nuvem o que mudou desde a última vez (updated_at) e
      aplica no aparelho. Exclusões de outros aparelhos chegam via deleted_at.
   3. Conflito: se o mesmo registro mudou nos dois lados, vale o que este
      aparelho tem pendente (ele é enviado antes de receber). Isso vale também
      para exclusões remotas: uma alteração local ainda não enviada NUNCA é
      apagada por uma exclusão vinda da nuvem (será reenviada na rodada seguinte).
   Segurança dos dados: a sincronização NUNCA apaga nada daqui por conta
   própria; só remove um registro quando a nuvem diz explicitamente que ele
   foi excluído em outro aparelho e não há alteração local pendente nele.
   Proteções (revisão de confiabilidade):
   • Nada é enviado nem recebido sem a autorização do backup independente
     (MovixBackup.syncAutorizada()); ela é consultada ANTES de cada etapa e
     qualquer falha/dúvida significa "bloqueado" (falha fechada). A sincronização
     retoma sozinha quando a autorização volta.
   • Recebimento paginado por (updated_at, id): estável com timestamps iguais.
   • Exclusão lógica só é confirmada (e só some do snapshot) quando a nuvem
     devolve as linhas realmente atualizadas.
   • Cada ciclo pertence a UMA conta: troca de conta/logout/pausa cancela o ciclo
     e descarta respostas atrasadas.
   Organização: 1 Estado • 2 Tabelas • 3 API REST • 4 Enviar • 5 Receber
                • 6 Orquestração • 7 Ativação • 8 Tela • 9 Inicialização
   ===================================================== */

const SYNC_CHAVE = "movix:sync";               // estado da sincronização (não vai nos backups)
const BACKUP_PREVENTIVO_CHAVE = "movix:backup-preventivo";
const LOTE = 200, ESPERA_MS = 2500, JANELA_SEGURANCA_MS = 10000, LIMITE_PAGINA = 1000;
const ESPERA_BACKUP_MS = 2000, ESPERA_BACKUP_MAX_MS = 30000;   // nova consulta à autorização do backup (recuo progressivo)
// Chaves do LocalStorage que representam dados sincronizáveis. As demais chaves "motograna:" (veiculoAtivo, frete,
// turnoAtual, turnoEncerrado) são preferências/estado do aparelho: gravá-las não dispara envio.
const CHAVES_DADOS = ["motograna:movimentacoes", "motograna:combustivel", "motograna:manutencoes", "motograna:turnos", "motograna:objetivos",
  "motograna:veiculos", "motograna:metaSemanal", "motograna:metaMensal", "motograna:remuneracao"];

let estadoSync = null;      // { ativo, usuario, ultimoPull:{}, snapshot:{}, ultimaSync }
let sincronizando = false, refazer = false, timerSync = null, aplicandoRemoto = false;
let ultimoErroAvisado = "";
let cicloAtual = null;       // { estado, usuario, ctrl, cancelado } do ciclo em andamento (um por vez)
let timerBackup = null, tentativasBackup = 0, usuarioVisto = null, ativando = false;
let resultadoSync = { erro: "", offline: false, rejeitados: [], descartados: [], enviados: {}, recebidos: {} };

/* ---------- 1. Estado ---------- */
const hashTexto = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h.toString(36) + ":" + s.length; };
const hashLinha = (t, item) => hashTexto(JSON.stringify(t.paraLinha(item)));
const numOuNulo = (v) => (typeof v === "number" && isFinite(v) ? v : null);

function carregarEstadoSync() {
  try { estadoSync = JSON.parse(localStorage.getItem(SYNC_CHAVE)); } catch (erro) { estadoSync = null; }
  if (!estadoSync || typeof estadoSync.usuario !== "string") estadoSync = null;
}
function salvarEstadoSync() {
  try { if (estadoSync) localStorage.setItem(SYNC_CHAVE, JSON.stringify(estadoSync)); } catch (erro) { /* ignora */ }
}
const usuarioAtual = () => (typeof sessao !== "undefined" && sessao ? sessao.user.id : null);
const podeSincronizar = () => Boolean(estadoSync && estadoSync.ativo && usuarioAtual() === estadoSync.usuario && lerConfiguracao().ok);

/* ---------- 2. Tabelas: como cada registro local vira linha do banco ---------- */
// paraLinha: local -> banco (só colunas gravávelis; colunas calculadas ficam de fora)
// paraLocal: banco -> local.  Ordem importa por causa das chaves estrangeiras
// (turnos vem ANTES de movimentacoes: o ganho do turno aponta para o turno por turno_id).
const TABELAS = [
  { nome: "veiculos", lista: () => extras.veiculos, gravar: (l) => { extras.veiculos = l; salvarExtras("veiculos"); },
    validar: (i) => itemExtraValido("veiculos", i),
    paraLinha: (v) => ({ id: v.id, tipo: v.tipo, marca: v.marca || "", modelo: v.modelo || "", ano: v.ano ? Number(v.ano) : null, placa: v.placa || null, apelido: v.apelido, km_atual: v.kmAtual }),
    paraLocal: (r) => ({ id: r.id, tipo: r.tipo, marca: r.marca, modelo: r.modelo, ano: r.ano == null ? "" : String(r.ano), placa: r.placa || "", apelido: r.apelido, kmAtual: Number(r.km_atual) }) },
  { nome: "abastecimentos", lista: () => extras.combustivel, gravar: (l) => { extras.combustivel = l; salvarExtras("combustivel"); },
    validar: (i) => itemExtraValido("combustivel", i),
    paraLinha: (c) => ({ id: c.id, veiculo_id: c.veiculoId, data: c.data, km_inicial: c.kmInicial, km_final: c.kmFinal, consumo_km_l: Math.round(c.consumo * 100) / 100, preco_litro: Math.round(c.preco * 1000) / 1000 }),
    paraLocal: (r) => ({ id: r.id, data: r.data, veiculoId: r.veiculo_id, kmInicial: Number(r.km_inicial), kmFinal: Number(r.km_final), consumo: Number(r.consumo_km_l), preco: Number(r.preco_litro), distancia: Number(r.distancia), litros: Number(r.litros), custo: Number(r.custo) }) },
  { nome: "manutencoes", lista: () => extras.manutencoes, gravar: (l) => { extras.manutencoes = l; salvarExtras("manutencoes"); },
    validar: (i) => itemExtraValido("manutencoes", i),
    paraLinha: (m) => ({ id: m.id, veiculo_id: m.veiculoId, tipo: String(m.tipo).slice(0, 40), descricao: String(m.descricao).trim().slice(0, 60) || String(m.tipo).slice(0, 40), valor: m.valor, km: m.km, data: m.data, prox_km: numOuNulo(m.proxKm), prox_data: m.proxData || null }),
    paraLocal: (r) => { const m = { id: r.id, tipo: r.tipo, descricao: r.descricao, valor: Number(r.valor), km: Number(r.km), data: r.data, veiculoId: r.veiculo_id }; if (r.prox_km != null) m.proxKm = Number(r.prox_km); if (r.prox_data) m.proxData = r.prox_data; return m; } },
  { nome: "turnos", lista: () => extras.turnos, gravar: (l) => { extras.turnos = l; salvarExtras("turnos"); },
    validar: (i) => itemExtraValido("turnos", i),
    paraLinha: (t) => ({ id: t.id, data: t.data, inicio: t.inicio, fim: t.fim, minutos: t.minutos, ganhos: t.ganhos, entregas: t.entregas, pausa_min: t.pausaMin || 0, registro: t.registro === "automático" ? "automatico" : "manual", km: numOuNulo(t.km), veiculo_id: null }),
    paraLocal: (r) => { const t = { id: r.id, data: r.data, inicio: String(r.inicio).slice(0, 5), fim: String(r.fim).slice(0, 5), minutos: Number(r.minutos), ganhos: Number(r.ganhos), entregas: Number(r.entregas), pausaMin: Number(r.pausa_min), registro: r.registro === "automatico" ? "automático" : "manual" }; if (r.km != null) t.km = Number(r.km); return t; } },
  { nome: "movimentacoes", lista: () => movimentacoes, gravar: (l) => { movimentacoes = l; salvarDados(); },
    validar: (i) => registroValido(i),
    paraLinha: (m) => ({ id: m.id, descricao: String(m.descricao).trim().slice(0, 60) || "Sem descrição", tipo: m.tipo, categoria: String(m.categoria).slice(0, 40), valor: m.valor, data: m.data,
      abastecimento_id: m.origem && m.origem.tipo === "combustivel" ? m.origem.id : null, manutencao_id: m.origem && m.origem.tipo === "manutencao" ? m.origem.id : null,
      turno_id: m.origem && m.origem.tipo === "turno" ? m.origem.id : null }),
    paraLocal: (r) => { const m = { id: r.id, descricao: r.descricao, tipo: r.tipo, categoria: r.categoria, valor: Number(r.valor), data: r.data }; if (r.abastecimento_id) m.origem = { tipo: "combustivel", id: r.abastecimento_id }; else if (r.manutencao_id) m.origem = { tipo: "manutencao", id: r.manutencao_id }; else if (r.turno_id) m.origem = { tipo: "turno", id: r.turno_id }; return m; } },
  { nome: "objetivos", lista: () => extras.objetivos, gravar: (l) => { extras.objetivos = l; salvarExtras("objetivos"); },
    validar: (i) => itemExtraValido("objetivos", i),
    paraLinha: (o) => ({ id: o.id, nome: String(o.nome).slice(0, 40), meta: o.meta, guardado: o.guardado }),
    paraLocal: (r) => ({ id: r.id, nome: r.nome, meta: Number(r.meta), guardado: Number(r.guardado) }) }
];

/* ---------- 3. Chamadas à API REST do Supabase (PostgREST) ---------- */
// Valor entre aspas para filtros do PostgREST: ids com vírgula, parêntese ou aspas não conseguem alterar a consulta
const aspasFiltro = (v) => '"' + String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const listaFiltro = (ids) => encodeURIComponent("(" + ids.map(aspasFiltro).join(",") + ")");

function erroInterrompido(motivo) {
  const e = new Error("sincronização interrompida: " + motivo);
  e.interrompido = true; e.motivo = motivo;
  return e;
}

// Compara timestamps do banco (microssegundos, "+00:00" ou "Z") sem perder precisão: -1, 0 ou 1
function normalizarTs(texto) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(String(texto));
  if (!m) return String(texto);
  const base = Date.parse(m[1] + (m[3] || "Z"));
  return isNaN(base) ? String(texto) : new Date(base).toISOString().slice(0, 19) + "." + (m[2] || "").padEnd(6, "0").slice(0, 6);
}
const compararTs = (a, b) => { const x = normalizarTs(a), y = normalizarTs(b); return x < y ? -1 : x > y ? 1 : 0; };
const tsParaMs = (texto) => { const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3})\d*)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(texto)); return m ? Date.parse(m[1] + (m[2] ? "." + m[2].padEnd(3, "0") : "") + (m[3] || "Z")) : Date.parse(texto); };

// "usuario": a conta dona da operação. Se a sessão mudar (antes, durante ou depois da chamada) nada é enviado
// e a resposta é descartada: uma resposta atrasada da conta anterior nunca chega ao aparelho.
// foraDoCiclo: registro administrativo (ex.: marcar a migração como "falhou") disparado quando o ciclo já terminou ou está
// terminando; não pertence ao ciclo, mas continua exigindo a mesma conta e a autorização do backup.
async function restFetch(caminho, { metodo = "GET", corpo, prefer, usuario, foraDoCiclo = false } = {}, repetir = true) {
  const ciclo = foraDoCiclo ? null : cicloAtual;
  const dono = usuario || (ciclo && ciclo.usuario) || usuarioAtual();
  if (dono && usuarioAtual() !== dono) throw erroInterrompido("sessao_mudou");
  const cfg = lerConfiguracao(), token = await obterTokenValido();
  // A renovação do token pode demorar. Nesse intervalo o usuário pode pausar a sync,
  // sair da conta ou o backup pode perder autorização. Revalidar ANTES de criar/enviar
  // a requisição impede que uma escrita atrasada chegue à nuvem depois do cancelamento.
  if (ciclo && (cicloAtual !== ciclo || ciclo.cancelado || ciclo.ctrl.signal.aborted))
    throw erroInterrompido(ciclo.cancelado || "ciclo_substituido");
  if (dono && usuarioAtual() !== dono) throw erroInterrompido("sessao_mudou");
  if (!cfg.ok || !token) { const e = new Error("Sessão indisponível."); e.semSessao = true; throw e; }
  if (ciclo) checar();
  else if (!backupAutoriza()) throw erroInterrompido("backup"); // inclui o registro da migração na ativação manual
  if (dono && usuarioAtual() !== dono) throw erroInterrompido("sessao_mudou");
  const ctrl = new AbortController(), limite = setTimeout(() => ctrl.abort(), 30000);
  const aoCancelar = () => ctrl.abort(), sinalCiclo = ciclo && ciclo.ctrl.signal;
  if (sinalCiclo) {
    if (sinalCiclo.aborted) ctrl.abort();
    else sinalCiclo.addEventListener("abort", aoCancelar, { once: true });
  }
  if (ctrl.signal.aborted) { clearTimeout(limite); throw erroInterrompido((ciclo && ciclo.cancelado) || "ciclo_cancelado"); }
  let resp;
  try {
    resp = await fetch(cfg.url + "/rest/v1/" + caminho, {
      method: metodo, signal: ctrl.signal,
      headers: { apikey: cfg.chave, Authorization: "Bearer " + token, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
  } catch (erro) {
    if (ciclo && ciclo.cancelado) throw erroInterrompido(ciclo.cancelado);
    const e = new Error("rede"); e.rede = true; throw e;
  } finally { clearTimeout(limite); if (sinalCiclo) sinalCiclo.removeEventListener("abort", aoCancelar); }
  let dados = null;
  try { dados = await resp.json(); } catch (erro) { /* resposta vazia */ }
  if ((dono && usuarioAtual() !== dono) || (ciclo && ciclo.cancelado)) throw erroInterrompido((ciclo && ciclo.cancelado) || "sessao_mudou");   // resposta atrasada: descartada
  if (resp.status === 401 && repetir) {
    // Se outra chamada já renovou a sessão enquanto esta resposta chegava,
    // basta repetir com o token novo; caso contrário, compartilha o refresh.
    const tokenJaRenovado = Boolean(sessao && sessao.access_token !== token);
    const renovou = tokenJaRenovado || await renovarSessao();
    if ((dono && usuarioAtual() !== dono) || (ciclo && ciclo.cancelado))
      throw erroInterrompido((ciclo && ciclo.cancelado) || "sessao_mudou");
    if (renovou) return restFetch(caminho, { metodo, corpo, prefer, usuario, foraDoCiclo }, false);
  }
  if (!resp.ok) {
    const e = new Error((dados && (dados.message || dados.hint)) || "erro " + resp.status);
    e.status = resp.status;
    e.rejeicao = [400, 409, 422].includes(resp.status); // problema no DADO (não na conexão)
    throw e;
  }
  return dados;
}

/* ---------- 4. Enviar (local -> nuvem) ---------- */
async function enviarLote(t, lote, snap) {
  try {
    await restFetch(t.nome + "?on_conflict=user_id,id", { metodo: "POST", prefer: "resolution=merge-duplicates,return=minimal", corpo: lote.map((x) => ({ ...x.linha, deleted_at: null })) });
    checar();
    lote.forEach((x) => { snap[x.linha.id] = x.h; });
    contar("enviados", t.nome, lote.length);
  } catch (e) {
    if (!e.rejeicao) throw e;
    if (lote.length > 1) { for (const x of lote) await enviarLote(t, [x], snap); return; } // isola o registro problemático
    resultadoSync.rejeitados.push({ tabela: t.nome, id: lote[0].linha.id, motivo: e.message, tipo: "envio" });
  }
}

// Exclusão lógica CONFIRMADA: o PATCH devolve as linhas realmente atualizadas (RLS pode filtrar linhas em silêncio).
// Só o que a nuvem confirma (ou já tinha como excluído) sai do snapshot; o resto continua pendente e é reportado.
async function excluirLogicamente(t, ids, snap) {
  const atualizadas = await restFetch(t.nome + "?select=id&deleted_at=is.null&id=in." + listaFiltro(ids),
    { metodo: "PATCH", prefer: "return=representation", corpo: { deleted_at: new Date().toISOString() } });
  const feitos = new Set(Array.isArray(atualizadas) ? atualizadas.map((r) => String(r.id)) : []);
  const faltando = ids.filter((id) => !feitos.has(id));
  const jaExcluidos = new Set();
  if (faltando.length) {              // não foram atualizadas agora: já estavam excluídas, não existem, ou o acesso foi negado
    const vistas = await restFetch(t.nome + "?select=id,deleted_at&id=in." + listaFiltro(faltando));
    (Array.isArray(vistas) ? vistas : []).forEach((r) => { if (r.deleted_at) jaExcluidos.add(String(r.id)); });
  }
  checar();
  ids.forEach((id) => {
    if (feitos.has(id) || jaExcluidos.has(id)) { delete snap[id]; return; }
    resultadoSync.rejeitados.push({ tabela: t.nome, id, motivo: "exclusão não confirmada pela nuvem", tipo: "exclusao" });
  });
}

async function enviarTabela(t, E) {
  const snap = (E.snapshot[t.nome] = E.snapshot[t.nome] || {});
  const locais = t.lista(), ids = new Set(), sujos = [];
  locais.forEach((i) => { ids.add(i.id); const linha = t.paraLinha(i), h = hashTexto(JSON.stringify(linha)); if (snap[i.id] !== h) sujos.push({ linha, h }); });
  for (let k = 0; k < sujos.length; k += LOTE) await enviarLote(t, sujos.slice(k, k + LOTE), snap);

  const apagados = Object.keys(snap).filter((id) => !ids.has(id)); // existiam e sumiram daqui
  for (let k = 0; k < apagados.length; k += 100) await excluirLogicamente(t, apagados.slice(k, k + 100), snap);
}

// Metas ficam na tabela configuracoes (1 linha por usuário)
const linhaConfig = () => ({ meta_semanal: metaSemanal > 0 ? metaSemanal : null, meta_mensal: metaMensal > 0 ? metaMensal : null });

// Remuneração por turno (ganho fixo + valor por entrega) também fica em configuracoes.
// Precisa das colunas ganho_fixo_turno e valor_por_entrega. Se elas ainda não existem no banco,
// o app cai para o comportamento anterior (só as metas), sem travar a sincronização,
// e tenta de novo na próxima vez que o app for aberto.
let colunasRemuneracao = true;
const linhaRemuneracao = () => ({ ganho_fixo_turno: remuneracao.fixo > 0 ? remuneracao.fixo : null, valor_por_entrega: remuneracao.porEntrega > 0 ? remuneracao.porEntrega : null });
const linhaConfigCompleta = () => ({ ...linhaConfig(), ...(colunasRemuneracao ? linhaRemuneracao() : {}) });
const erroColunaRemuneracao = (e) => Boolean(e) && e.status === 400 && /ganho_fixo_turno|valor_por_entrega|column|coluna/i.test(e.message || "");

async function enviarConfig(E) {
  const snap = (E.snapshot.configuracoes = E.snapshot.configuracoes || {});
  const l = linhaConfigCompleta(), h = hashTexto(JSON.stringify(l));
  const sujo = snap.hash === undefined ? Object.values(l).some((v) => v !== null) : snap.hash !== h;
  snap.sujo = sujo;
  if (!sujo) return;
  const enviar = (campos) => restFetch("configuracoes?on_conflict=user_id", { metodo: "POST", prefer: "resolution=merge-duplicates,return=minimal", corpo: { user_id: E.usuario, ...campos } });
  try {
    await enviar(l);
    checar();
    snap.hash = h;
  } catch (e) {
    if (!colunasRemuneracao || !erroColunaRemuneracao(e)) throw e;
    colunasRemuneracao = false;               // colunas ainda não existem: segue só com as metas
    const base = linhaConfig();
    await enviar(base);
    checar();
    snap.hash = hashTexto(JSON.stringify(base));
  }
}

/* ---------- 5. Receber (nuvem -> local) ---------- */
// Aplica UMA página de linhas, de forma síncrona (nada do usuário pode se intercalar) e idempotente (mapa por id).
// O snapshot só é atualizado depois que os dados foram gravados.
function aplicarLinhas(t, linhas, E) {
  const snap = (E.snapshot[t.nome] = E.snapshot[t.nome] || {});
  const mapa = new Map(t.lista().map((i) => [i.id, i]));
  const marcas = [];                       // [id, hash | null]: aplicadas ao snapshot só depois de gravar
  let mudou = false;
  linhas.forEach((r) => {
    if (!r || typeof r.id !== "string") { resultadoSync.descartados.push({ tabela: t.nome, id: String(r && r.id), motivo: "registro da nuvem sem id válido" }); return; }
    const local = mapa.get(r.id), hashLocal = local ? hashLinha(t, local) : null;
    if (r.deleted_at) {                    // excluído em outro aparelho
      if (local && (snap[r.id] === undefined || hashLocal !== snap[r.id])) return;   // alteração local ainda não enviada: NÃO é apagada (será reenviada)
      if (mapa.delete(r.id)) mudou = true;
      marcas.push([r.id, null]);
      return;
    }
    let novo;
    try { novo = t.paraLocal(r); } catch (erro) { novo = null; }
    if (!novo || !t.validar(novo)) { resultadoSync.descartados.push({ tabela: t.nome, id: r.id, motivo: "registro da nuvem em formato inválido" }); return; }
    const h = hashLinha(t, novo);
    if (local && snap[r.id] !== undefined && hashLocal !== snap[r.id]) return;   // alteração local pendente vence
    if (!local && snap[r.id] !== undefined) return;                              // exclusão local ainda não confirmada na nuvem: não ressuscita
    if (!local || hashLocal !== h) { mapa.set(r.id, novo); mudou = true; if (!local) contar("recebidos", t.nome, 1); }
    marcas.push([r.id, h]);
  });
  if (mudou) { aplicandoRemoto = true; try { t.gravar([...mapa.values()]); } finally { aplicandoRemoto = false; } }
  marcas.forEach(([id, h]) => { if (h === null) delete snap[id]; else snap[id] = h; });
  return mudou;
}

// Paginação por (updated_at, id): ordem total e determinística. Com mais de LIMITE_PAGINA registros no mesmo
// updated_at a próxima página começa DEPOIS do último (updated_at, id) recebido, sem repetir nem pular nada.
// O cursor gravado (ultimoPull) só avança quando a tabela inteira foi lida e aplicada; falha = nada avança.
async function receberTabela(t, E) {
  const ultimo = E.ultimoPull[t.nome] || "1970-01-01T00:00:00.000Z";
  // Recua alguns segundos: transações que terminaram depois não ficam para trás. Reaplicar é seguro (idempotente).
  const inicio = new Date(Math.max(0, tsParaMs(ultimo) - JANELA_SEGURANCA_MS)).toISOString();
  let ultima = null, mudou = false, maior = ultimo;
  for (;;) {
    checar();
    const filtro = ultima
      ? "&or=" + encodeURIComponent("(updated_at.gt." + ultima.updated_at + ",and(updated_at.eq." + ultima.updated_at + ",id.gt." + aspasFiltro(ultima.id) + "))")
      : "&updated_at=gte." + encodeURIComponent(inicio);
    const linhas = await restFetch(t.nome + "?select=*&order=updated_at.asc,id.asc&limit=" + LIMITE_PAGINA + filtro);
    if (!Array.isArray(linhas)) throw new Error("resposta inesperada do servidor ao receber " + t.nome);
    if (!linhas.length) break;
    if (linhas.some((r) => !r || typeof r.id !== "string" || typeof r.updated_at !== "string")) throw new Error("página sem id/updated_at em " + t.nome + ": não é seguro avançar");
    checar();
    mudou = aplicarLinhas(t, linhas, E) || mudou;
    const fim = linhas[linhas.length - 1];
    if (ultima) { const c = compararTs(fim.updated_at, ultima.updated_at); if (c < 0 || (c === 0 && !(fim.id > ultima.id))) throw new Error("paginação não avançou em " + t.nome); }
    ultima = { updated_at: fim.updated_at, id: fim.id };
    if (compararTs(fim.updated_at, maior) > 0) maior = fim.updated_at;
    if (linhas.length < LIMITE_PAGINA) break;
  }
  E.ultimoPull[t.nome] = maior;
  return mudou;
}

async function receberConfig(E) {
  const snap = E.snapshot.configuracoes;
  if (snap.sujo) { snap.sujo = false; return false; } // acabou de enviar: o local é a verdade
  if (snap.hash !== undefined && hashTexto(JSON.stringify(linhaConfigCompleta())) !== snap.hash) return false;   // metas/remuneração alteradas aqui durante o ciclo: não sobrescrever
  const buscar = () => restFetch("configuracoes?select=meta_semanal,meta_mensal" + (colunasRemuneracao ? ",ganho_fixo_turno,valor_por_entrega" : "") + "&user_id=eq." + encodeURIComponent(E.usuario));
  let linhas;
  try { linhas = await buscar(); }
  catch (e) {
    if (!colunasRemuneracao || !erroColunaRemuneracao(e)) throw e;
    colunasRemuneracao = false;               // colunas ainda não existem: busca só as metas
    linhas = await buscar();
  }
  checar();
  if (!linhas.length) return false;
  if (snap.hash !== undefined && hashTexto(JSON.stringify(linhaConfigCompleta())) !== snap.hash) return false;   // (nada muda entre o await e aqui; mantido por segurança)
  const sem = Number(linhas[0].meta_semanal) > 0 ? Number(linhas[0].meta_semanal) : 0, men = Number(linhas[0].meta_mensal) > 0 ? Number(linhas[0].meta_mensal) : 0;
  const positivo = (v) => (Number(v) > 0 ? arred(Number(v)) : 0);
  const fixo = colunasRemuneracao ? positivo(linhas[0].ganho_fixo_turno) : remuneracao.fixo;
  const porEntrega = colunasRemuneracao ? positivo(linhas[0].valor_por_entrega) : remuneracao.porEntrega;
  let mudou = false;
  aplicandoRemoto = true;
  try {
    if (sem !== metaSemanal) { metaSemanal = sem; sem ? localStorage.setItem(CHAVE_META, String(sem)) : localStorage.removeItem(CHAVE_META); $("campoMeta").value = sem || ""; mudou = true; }
    if (men !== metaMensal) { metaMensal = men; men ? localStorage.setItem(CHAVE_META_MENSAL, String(men)) : localStorage.removeItem(CHAVE_META_MENSAL); $("campoMetaMensal").value = men || ""; mudou = true; }
    if (fixo !== remuneracao.fixo || porEntrega !== remuneracao.porEntrega) {   // vale só para turnos futuros; turnos antigos não são tocados
      remuneracao = { fixo, porEntrega };
      remuneracaoAtiva() ? localStorage.setItem(CHAVE_REMUNERACAO, JSON.stringify(remuneracao)) : localStorage.removeItem(CHAVE_REMUNERACAO);
      $("ganhoFixoTurno").value = fixo || ""; $("valorEntregaTurno").value = porEntrega || "";
      mudou = true;
    }
  } finally { aplicandoRemoto = false; }
  snap.hash = hashTexto(JSON.stringify(linhaConfigCompleta()));
  return mudou;
}

// O veículo padrão vazio criado em cada aparelho novo some quando a nuvem já tem veículos de verdade
function removerVeiculoPadraoVazio() {
  if (extras.veiculos.length < 2) return false;
  const usado = (v) => extras.combustivel.some((c) => c.veiculoId === v.id) || extras.manutencoes.some((m) => m.veiculoId === v.id);
  const sobra = extras.veiculos.find((v) => v.apelido === "Minha moto" && !v.marca && !v.modelo && !v.placa && v.kmAtual === 0 && !usado(v));
  if (!sobra) return false;
  extras.veiculos = extras.veiculos.filter((v) => v.id !== sobra.id);
  aplicandoRemoto = true; try { salvarExtras("veiculos"); } finally { aplicandoRemoto = false; }
  return true;
}

/* ---------- 6. Orquestração ---------- */
function traduzirErroSync(e) {
  if (e.rede) return "";
  if (e.semSessao) return "Sessão indisponível. Entre novamente.";
  if (e.status === 401) return "O servidor não reconheceu a sessão. Entre novamente.";
  if (e.status === 403) return "O servidor negou o acesso (RLS). Confira se o SQL da etapa 3.1 foi executado inteiro.";
  if (e.status === 404) return "Tabela não encontrada no Supabase. Execute o SQL da etapa 3.1.";
  return "Erro do servidor: " + e.message;
}

/* Autorização do backup independente (backup-local.js). FALHA FECHADA: só o valor exato true libera; módulo ausente,
   exceção, undefined ou qualquer outro valor significam "bloqueado". Uma falha do backup nunca vira autorização. */
function backupAutoriza() {
  try { return typeof MovixBackup !== "undefined" && Boolean(MovixBackup) && typeof MovixBackup.syncAutorizada === "function" && MovixBackup.syncAutorizada() === true; }
  catch (erro) { return false; }
}

// Sincronização bloqueada pelo backup: consulta de novo (recuo progressivo) e retoma sozinha quando a autorização volta
function aguardarBackup() {
  if (timerBackup || !podeSincronizar()) return;
  const espera = Math.min(ESPERA_BACKUP_MAX_MS, ESPERA_BACKUP_MS * Math.pow(2, Math.min(tentativasBackup, 4)));
  timerBackup = setTimeout(() => {
    timerBackup = null; tentativasBackup++;
    if (!podeSincronizar()) return;
    if (backupAutoriza()) { tentativasBackup = 0; sincronizar(); } else aguardarBackup();
  }, espera);
}

function cancelarCiclo(motivo) {
  if (!cicloAtual || cicloAtual.cancelado) return;
  cicloAtual.cancelado = motivo;
  try { cicloAtual.ctrl.abort(); } catch (erro) { /* ignora */ }
}

// Revalida, nos pontos críticos do ciclo, que ele ainda pode continuar: mesma conta, mesmo estado, sync ativa e backup autorizado
function checar() {
  const c = cicloAtual;
  if (!c) return;
  if (c.cancelado) throw erroInterrompido(c.cancelado);
  if (estadoSync !== c.estado || !podeSincronizar() || usuarioAtual() !== c.usuario) { c.cancelado = "sessao_ou_estado"; throw erroInterrompido(c.cancelado); }
  if (!backupAutoriza()) { c.cancelado = "backup"; throw erroInterrompido("backup"); }
}

async function sincronizar() {
  if (!podeSincronizar()) return;
  if (!backupAutoriza()) { aguardarBackup(); renderizarSync(); return; }   // nunca contorna a proteção (eventos, timers, botão, auth)
  if (sincronizando) { refazer = true; return; }
  if (!navigator.onLine) { resultadoSync.offline = true; renderizarSync(); return; }
  const E = estadoSync, ciclo = { estado: E, usuario: usuarioAtual(), ctrl: new AbortController(), cancelado: "" };
  cicloAtual = ciclo; sincronizando = true;
  resultadoSync = { erro: "", offline: false, rejeitados: [], descartados: [], enviados: {}, recebidos: {} };
  renderizarSync();
  try {
    for (const t of TABELAS) { checar(); await enviarTabela(t, E); }
    checar(); await enviarConfig(E);
    let mudou = false;
    for (const t of TABELAS) mudou = (await receberTabela(t, E)) || mudou;
    checar(); mudou = (await receberConfig(E)) || mudou;
    checar(); if (removerVeiculoPadraoVazio()) mudou = true;
    E.ultimaSync = Date.now();
    if (mudou) { prepararVeiculos(); atualizarTela(); }
    acumularMigracao(E);
    checar(); await concluirMigracao(E);
  } catch (e) {
    acumularMigracao(E);
    if (e.interrompido) { /* conta trocada, pausa ou backup revogado: não é erro; nada foi aplicado depois da interrupção */ }
    else if (e.rede) resultadoSync.offline = true;
    else { resultadoSync.erro = traduzirErroSync(e); await marcarMigracaoFalha(E, e); }
  } finally {
    sincronizando = false; cicloAtual = null;
    const vigente = estadoSync === E;
    if (vigente) {
      if (resultadoSync.erro && resultadoSync.erro !== ultimoErroAvisado) toast("Sincronização com problema. Veja os detalhes na seção Conta.", true);
      ultimoErroAvisado = resultadoSync.erro;
      salvarEstadoSync();
    }
    renderizarSync();
    if (ciclo.cancelado === "backup") aguardarBackup();
    if (refazer) { refazer = false; agendar(); }
  }
}

function agendar() {
  if (aplicandoRemoto || !podeSincronizar()) return;
  if (!backupAutoriza()) { aguardarBackup(); return; }
  if (sincronizando) { refazer = true; return; }
  clearTimeout(timerSync);
  timerSync = setTimeout(sincronizar, ESPERA_MS);
}

/* ---------- 7. Ativação (com backup preventivo) ---------- */
function baixarJson(nome, objeto) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(objeto, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function criarBackupPreventivo() {
  const pacote = montarPacoteBackup();
  // Cópias COMPLEMENTARES (a proteção que vale é o snapshot independente no IndexedDB, criado antes): falha de espaço
  // ou de download não impede a ativação.
  let copiaInterna = false, arquivo = false;
  try { localStorage.setItem(BACKUP_PREVENTIVO_CHAVE, JSON.stringify({ criadoEm: new Date().toISOString(), usuario: usuarioAtual(), pacote })); copiaInterna = true; } catch (erro) { /* sem espaço */ }
  try { baixarJson("movix-backup-preventivo-" + dataParaTexto(new Date()) + ".json", pacote); arquivo = true; } catch (erro) { /* download bloqueado */ }
  return { pacote, copiaInterna, arquivo };
}

// Pede ao módulo de backup o snapshot independente "pre_ativacao_sync" e AGUARDA. Sem fallback permissivo:
// só segue se o snapshot foi concluído e a autorização de sincronização está de pé.
async function garantirBackupAtivacao() {
  try {
    if (typeof MovixBackup === "undefined" || !MovixBackup) return { ok: false, motivo: "modulo_ausente" };
    let r;
    if (typeof MovixBackup.garantirAtivacaoSync === "function") r = await MovixBackup.garantirAtivacaoSync("ativação da sincronização");
    else if (typeof MovixBackup.garantir === "function") r = await MovixBackup.garantir({ origem: "pre_ativacao_sync", motivo: "ativação da sincronização" });
    else return { ok: false, motivo: "api_indisponivel" };
    if (!r || r.ok !== true) return { ok: false, motivo: (r && r.motivo) || "falha" };
    return backupAutoriza() ? { ok: true } : { ok: false, motivo: "sync_nao_autorizada" };
  } catch (erro) { return { ok: false, motivo: "erro" }; }
}

async function ativarSincronizacao() {
  const uid = usuarioAtual();
  if (!uid || ativando) return;
  ativando = true;
  try {
    const email = sessao.user.email, outraConta = Boolean(estadoSync) && estadoSync.usuario !== uid;
    const mensagem = "Ativar a sincronização?\n\n"
      + "• Antes de tudo, será criada uma cópia de segurança independente deste aparelho (e um arquivo, se o navegador permitir).\n"
      + "• Os dados deste aparelho serão ENVIADOS para a conta " + email + ".\n"
      + "• Os dados que já estiverem nessa conta serão TRAZIDOS para cá.\n"
      + (outraConta ? "\n⚠️ Este aparelho estava sincronizado com OUTRA conta. Os dados que estão aqui serão enviados para ESTA conta (" + email + "). Continue só se forem seus dados.\n" : "")
      + "\nNada é apagado deste aparelho.";
    if (!confirm(mensagem)) return;

    const prot = await garantirBackupAtivacao();
    if (!prot.ok) { toast("Não foi possível criar a cópia de segurança independente. A sincronização NÃO foi ativada e nada foi enviado.", true); renderizarSync(); return; }
    if (usuarioAtual() !== uid) { toast("A conta mudou durante a ativação. Nada foi enviado.", true); return; }
    const { pacote, copiaInterna, arquivo } = criarBackupPreventivo();
    toast(copiaInterna || arquivo ? "Backup de segurança salvo. Sincronizando..." : "Cópia de segurança independente criada. Sincronizando...");

    const local = Object.fromEntries(TABELAS.map((t) => [t.nome, t.lista().length]));
    const migracao = { id: null, checksum: await calcularChecksum(JSON.stringify(pacote)), local, enviados: {}, recebidos: {}, rejeitados: [], descartados: [], jaFeita: false, rodadas: 0, iniciadaEm: new Date().toISOString() };
    if (usuarioAtual() !== uid) { toast("A conta mudou durante a ativação. Nada foi enviado.", true); return; }
    try {                                   // sem internet? o registro é criado na primeira sincronização completa
      const reg = await registrarMigracao("localstorage", migracao.checksum, { local }, uid);
      if (reg.jaFeita) { migracao.jaFeita = true; toast("Estes dados já tinham sido migrados para esta conta. Seguindo com a sincronização normal."); }
      else migracao.id = reg.id;
    } catch (e) { /* tenta de novo depois */ }
    if (usuarioAtual() !== uid) { toast("A conta mudou durante a ativação. Nada foi enviado.", true); return; }
    estadoSync = { ativo: true, usuario: uid, ultimoPull: {}, snapshot: {}, ultimaSync: null, migracao };
    salvarEstadoSync();
    await sincronizar();
  } finally { ativando = false; }
}

function pausarSincronizacao() {
  if (!estadoSync) return;
  estadoSync.ativo = false;
  cancelarCiclo("pausada");
  clearTimeout(timerSync); timerSync = null; clearTimeout(timerBackup); timerBackup = null;
  salvarEstadoSync();
  toast("Sincronização pausada neste aparelho.");
  renderizarSync();
}

/* ---------- 8. Tela ---------- */
function contarPendencias() {
  if (!estadoSync) return 0;
  let n = 0;
  TABELAS.forEach((t) => {
    const snap = estadoSync.snapshot[t.nome] || {}, ids = new Set();
    t.lista().forEach((i) => { ids.add(i.id); if (snap[i.id] !== hashLinha(t, i)) n++; });
    Object.keys(snap).forEach((id) => { if (!ids.has(id)) n++; });
  });
  return n;
}

function renderizarSync() {
  const status = $("statusSync");
  if (!status) return;
  const logado = Boolean(usuarioAtual()), ativo = podeSincronizar();
  const outraConta = estadoSync && estadoSync.usuario !== usuarioAtual();
  status.innerHTML = "";
  $("btnSyncAtivar").hidden = !logado || ativo;
  $("botoesSync").hidden = !ativo;
  const temPreventivo = Boolean(lerJson(BACKUP_PREVENTIVO_CHAVE));
  $("btnDuplicatas").hidden = !ativo;
  $("btnRestaurarPreventivo").hidden = !temPreventivo;
  $("botoesMigracao").hidden = !logado || !(ativo || temPreventivo);
  if (!logado) { $("relatorioMigracao").hidden = $("tituloRelatorio").hidden = $("blocoDuplicatas").hidden = true; return; }
  renderizarRelatorioMigracao();

  let estado = "Desativada neste aparelho";
  if (ativo) estado = !backupAutoriza() ? "Aguardando a cópia de segurança do aparelho" : sincronizando ? "Sincronizando..." : resultadoSync.offline ? "Sem internet (sincroniza ao voltar)" : "Ativa";
  else if (estadoSync && estadoSync.usuario === usuarioAtual()) estado = "Pausada";
  status.append(linhaInfo("Sincronização", estado, ativo && !resultadoSync.erro && backupAutoriza() ? "g" : ""));
  if (ativo) {
    status.append(linhaInfo("Última sincronização", estadoSync.ultimaSync ? new Date(estadoSync.ultimaSync).toLocaleString("pt-BR") : "ainda não"));
    const p = contarPendencias();
    status.append(linhaInfo("Alterações pendentes", String(p), p > 0 ? "d" : "g"));
  }
  if (!ativo) status.append(el("p", "dica", "⚠️ Seus dados ainda NÃO estão na nuvem. Toque em \"Ativar sincronização\" para enviá-los."));
  if (outraConta) status.append(el("p", "dica", "Este aparelho estava sincronizado com outra conta. Ao ativar, os dados que estão aqui serão enviados para esta conta."));
  const rej = resultadoSync.rejeitados, desc = resultadoSync.descartados || [];
  $("erroSync").textContent = resultadoSync.erro || (rej.length ? rej.length + " registro(s) não aceito(s) ou não confirmado(s) pelo servidor (ficam salvos aqui). Primeiro motivo: " + rej[0].motivo
    : desc.length ? desc.length + " registro(s) da nuvem em formato inválido foram ignorados." : "");
}

/* ---------- 10. Migração (Fase 3.5) ---------- */
// Cada migração é registrada na tabela "migracoes" (checksum único por conta),
// gera um relatório e pode ser desfeita localmente com o backup preventivo.
const RELATORIO_CHAVE = "movix:relatorio-migracao";
const BACKUP_ANTES_RESTAURAR_CHAVE = "movix:backup-antes-restauracao";
const NOMES_TABELAS = { veiculos: "Veículos", abastecimentos: "Abastecimentos", manutencoes: "Manutenções", movimentacoes: "Movimentações", turnos: "Turnos", objetivos: "Objetivos" };

const lerJson = (chave) => { try { return JSON.parse(localStorage.getItem(chave)); } catch (erro) { return null; } };
const contar = (tipo, nome, n) => { resultadoSync[tipo][nome] = (resultadoSync[tipo][nome] || 0) + n; };

// "Impressão digital" do conteúdo (SHA-256); se o navegador não oferecer, usa uma alternativa simples
async function calcularChecksum(texto) {
  try {
    if (window.crypto && crypto.subtle) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
      return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (erro) { /* usa a alternativa */ }
  return ("alt" + hashTexto(texto) + hashTexto([...texto].reverse().join("")) + texto.length).padEnd(16, "0");
}

// Já existe uma migração com esse conteúdo? Concluída -> avisa; pendente/parcial -> reaproveita; nova -> cria.
async function registrarMigracao(fonte, checksum, resumo, usuario) {
  const achadas = await restFetch("migracoes?select=id,status,created_at&checksum=eq." + encodeURIComponent(checksum), { usuario });
  if (achadas.length && achadas[0].status === "concluida") return { jaFeita: true, quando: achadas[0].created_at };
  if (achadas.length) {
    await restFetch("migracoes?id=eq." + encodeURIComponent(achadas[0].id), { metodo: "PATCH", prefer: "return=minimal", usuario, corpo: { status: "iniciada", erro: null, resumo } });
    return { id: achadas[0].id };
  }
  const criada = await restFetch("migracoes", { metodo: "POST", prefer: "return=representation", usuario, corpo: { fonte, checksum, status: "iniciada", resumo } });
  return { id: criada[0].id };
}

const finalizarMigracao = (id, status, resumo, erro, usuario, foraDoCiclo = false) => restFetch("migracoes?id=eq." + encodeURIComponent(id), {
  metodo: "PATCH", prefer: "return=minimal", usuario, foraDoCiclo,
  corpo: { status, resumo, erro: erro || null, concluida_em: status === "concluida" ? new Date().toISOString() : null }
});

// Soma as contagens de cada rodada de sincronização enquanto a migração não termina.
// As rejeições NÃO se perdem entre rodadas: ficam em m.rejeitados até serem resolvidas (aceitas depois ou removidas daqui).
function acumularMigracao(E) {
  const m = E && E.migracao;
  if (!m) return;
  ["enviados", "recebidos"].forEach((tipo) => Object.keys(resultadoSync[tipo]).forEach((n) => { m[tipo][n] = (m[tipo][n] || 0) + resultadoSync[tipo][n]; resultadoSync[tipo][n] = 0; }));
  resultadoSync.rejeitados.forEach((r) => {
    const i = m.rejeitados.findIndex((x) => x.id === r.id && x.tabela === r.tabela);
    const reg = { tabela: r.tabela, id: r.id, motivo: r.motivo, tipo: r.tipo || "envio" };
    if (i < 0) m.rejeitados.push(reg); else m.rejeitados[i] = reg;
  });
  m.descartados = m.descartados || [];
  (resultadoSync.descartados || []).forEach((r) => { if (m.descartados.length < 50 && !m.descartados.some((x) => x.id === r.id && x.tabela === r.tabela)) m.descartados.push(r); });
}

// A rejeição continua valendo? (envio: o registro ainda existe aqui e a nuvem ainda não o aceitou; exclusão: ainda pendente)
function rejeicaoPersiste(E, r) {
  const t = TABELAS.find((x) => x.nome === r.tabela);
  if (!t) return false;
  const snap = E.snapshot[r.tabela] || {}, local = t.lista().find((i) => i.id === r.id);
  if (r.tipo === "exclusao") return !local && snap[r.id] !== undefined;
  return Boolean(local) && snap[r.id] !== hashLinha(t, local);
}

// Relatório da migração (guardado só neste aparelho). situacao: concluida | parcial | falhou | pendente | ja_realizada
function montarRelatorioMigracao(E, situacao, erro) {
  const m = E.migracao, rej = m.rejeitados.filter((r) => rejeicaoPersiste(E, r)), motivos = {};
  rej.forEach((r) => { motivos[r.motivo] = (motivos[r.motivo] || 0) + 1; });
  const tabelas = Object.keys(NOMES_TABELAS).filter((n) => (m.enviados[n] || 0) + (m.recebidos[n] || 0) + rej.filter((r) => r.tabela === n).length > 0);
  return { quando: new Date().toISOString(), situacao, rodadas: m.rodadas || 0, iniciadaEm: m.iniciadaEm || null, enviados: m.enviados, recebidos: m.recebidos,
    rejeitados: rej.slice(0, 50), totalRejeitados: rej.length, resolvidos: m.rejeitados.length - rej.length, motivos, tabelas, descartados: (m.descartados || []).slice(0, 50),
    duplicatas: detectarDuplicatas().length, jaMigrado: Boolean(m.jaFeita), erro: erro || null };
}

// Fecha a migração depois de uma sincronização completa. Com registros recusados ela fica PARCIAL (não "concluída")
// e continua sendo acompanhada: se os registros forem aceitos depois, vira concluída.
async function concluirMigracao(E) {
  const m = E && E.migracao;
  if (!m) return;
  m.rodadas = (m.rodadas || 0) + 1;
  if (!m.id && !m.jaFeita) {              // o registro não pôde ser criado na ativação (estava sem internet)
    const r = await registrarMigracao("localstorage", m.checksum, { local: m.local }, E.usuario);
    if (r.jaFeita) m.jaFeita = true; else m.id = r.id;
  }
  const rel = montarRelatorioMigracao(E, "concluida");
  rel.situacao = m.jaFeita ? "ja_realizada" : rel.totalRejeitados > 0 ? "parcial" : "concluida";
  try { localStorage.setItem(RELATORIO_CHAVE, JSON.stringify(rel)); } catch (erro) { /* ignora */ }
  if (m.id && m.situacaoRemota !== rel.situacao) {
    const resumo = { situacao: rel.situacao, enviados: rel.enviados, recebidos: rel.recebidos, rejeitados: rel.totalRejeitados, duplicatas: rel.duplicatas, motivos: rel.motivos };
    // O banco só conhece iniciada/concluida/falhou: a migração parcial fica "iniciada" (continua pendente) e a situação real vai em resumo.situacao
    await finalizarMigracao(m.id, rel.situacao === "concluida" ? "concluida" : "iniciada", resumo, rel.situacao === "parcial" ? rel.totalRejeitados + " registro(s) recusado(s)" : null, E.usuario);
    m.situacaoRemota = rel.situacao;
  }
  if (rel.situacao !== "parcial") E.migracao = null;   // parcial: segue acompanhando as rejeições
  salvarEstadoSync();
}

async function marcarMigracaoFalha(E, e) {
  const m = E && E.migracao;
  if (!m) return;
  try { localStorage.setItem(RELATORIO_CHAVE, JSON.stringify(montarRelatorioMigracao(E, "falhou", e.message))); } catch (erro) { /* ignora */ }
  if (m.id) {
    try {
      await finalizarMigracao(m.id, "falhou", { situacao: "falhou", enviados: m.enviados, recebidos: m.recebidos }, e.message, E.usuario, true);
      m.situacaoRemota = "falhou";
    } catch (erro) { /* mantém a atualização remota pendente para uma nova tentativa */ }
  }
}

/* --- Possíveis duplicatas (nunca remove sozinho) --- */
function detectarDuplicatas() {
  const grupos = [], norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  const agrupar = (tabela, lista, chave, titulo) => {
    const mapa = new Map();
    lista.forEach((i) => { const k = chave(i); mapa.set(k, [...(mapa.get(k) || []), i]); });
    mapa.forEach((itens) => { if (itens.length > 1) grupos.push({ tabela, itens, titulo: titulo(itens[0]) }); });
  };
  // Movimentações ligadas a abastecimento/manutenção ficam de fora (têm vínculo)
  agrupar("movimentacoes", movimentacoes.filter((m) => !m.origem), (m) => [m.tipo, m.data, m.valor, norm(m.categoria), norm(m.descricao)].join("|"),
    (m) => m.descricao + " • " + m.categoria + " • " + formatarMoeda(m.valor) + " • " + formatarData(m.data));
  agrupar("turnos", extras.turnos, (t) => [t.data, t.inicio, t.fim, t.ganhos, t.entregas].join("|"),
    (t) => "Turno " + formatarData(t.data) + " • " + t.inicio + " às " + t.fim + " • " + formatarMoeda(t.ganhos));
  return grupos;
}

async function removerCopias(grupo) {
  const n = grupo.itens.length - 1;
  if (!confirm("Remover " + n + " cópia(s) e manter 1?\n\nSe forem lançamentos legítimos repetidos, cancele.")) return;
  if (!(await protegerAntes("pre_remocao_copias", "remoção de cópias duplicadas"))) return;
  const remover = new Set(grupo.itens.slice(1).map((i) => i.id));
  if (grupo.tabela === "movimentacoes") { movimentacoes = movimentacoes.filter((m) => !remover.has(m.id)); salvarDados(); }
  else { extras.turnos = extras.turnos.filter((t) => !remover.has(t.id)); salvarExtras("turnos"); }
  atualizarTela();
  mostrarDuplicatas();
  toast("Cópias removidas.");
}

function mostrarDuplicatas() {
  const box = $("blocoDuplicatas"), grupos = detectarDuplicatas();
  box.hidden = false;
  box.innerHTML = "";
  if (!grupos.length) { box.append(el("p", "dica", "Nenhuma possível duplicata encontrada. 👍")); return; }
  box.append(el("p", "dica", "Itens com exatamente os mesmos dados. Podem ser repetições legítimas (ex.: duas corridas iguais no mesmo dia), então confira antes de remover."));
  const ul = el("ul", "historico");
  grupos.forEach((g) => {
    const li = criarItem("breve", g.titulo, g.itens.length + " registros idênticos", "");
    const b = el("button", "btn-excluir", "Remover " + (g.itens.length - 1) + (g.itens.length > 2 ? " cópias" : " cópia"));
    b.type = "button";
    b.addEventListener("click", () => removerCopias(g));
    li.append(b);
    ul.append(li);
  });
  box.append(ul);
}

/* --- Restaurar o backup preventivo (somente neste aparelho) --- */
async function restaurarBackupPreventivo() {
  const b = lerJson(BACKUP_PREVENTIVO_CHAVE);
  if (!b || !b.pacote) { toast("Nenhum backup preventivo encontrado.", true); return; }
  const quando = new Date(b.criadoEm).toLocaleString("pt-BR");
  if (!confirm("Restaurar o backup preventivo de " + quando + "?\n\n• Os dados DESTE aparelho voltam ao estado daquele momento.\n• O estado atual é salvo antes (arquivo + cópia interna).\n• A sincronização será pausada; ao reativar, os dados são reunidos de novo com a nuvem.\n\nA nuvem não é alterada.")) return;
  if (!(await protegerAntes("pre_restauracao_preventiva", "restauração do backup preventivo"))) return;
  try {
    const atual = montarPacoteBackup();
    localStorage.setItem(BACKUP_ANTES_RESTAURAR_CHAVE, JSON.stringify({ criadoEm: new Date().toISOString(), pacote: atual }));
    baixarJson("movix-backup-antes-da-restauracao-" + dataParaTexto(new Date()) + ".json", atual);
  } catch (e) { toast("Não foi possível salvar o estado atual. Nada foi alterado.", true); return; }

  if (estadoSync) { estadoSync.ativo = false; cancelarCiclo("restauracao"); estadoSync.snapshot = {}; estadoSync.ultimoPull = {}; estadoSync.migracao = null; salvarEstadoSync(); }
  const p = b.pacote;
  movimentacoes = (Array.isArray(p.movimentacoes) ? p.movimentacoes : []).filter(registroValido);
  salvarDados();
  Object.keys(extras).forEach((nome) => { extras[nome] = (Array.isArray(p[nome]) ? p[nome] : []).filter((i) => itemExtraValido(nome, i)); salvarExtras(nome); });
  metaSemanal = Number(p.metaSemanal) > 0 ? Number(p.metaSemanal) : 0;
  metaMensal = Number(p.metaMensal) > 0 ? Number(p.metaMensal) : 0;
  metaSemanal ? localStorage.setItem(CHAVE_META, String(metaSemanal)) : localStorage.removeItem(CHAVE_META);
  metaMensal ? localStorage.setItem(CHAVE_META_MENSAL, String(metaMensal)) : localStorage.removeItem(CHAVE_META_MENSAL);
  $("campoMeta").value = metaSemanal || "";
  $("campoMetaMensal").value = metaMensal || "";
  prepararVeiculos();
  atualizarTela();
  renderizarSync();
  toast("Backup restaurado. Sincronização pausada neste aparelho.");
}

/* --- Relatório da migração --- */
const SITUACOES_MIGRACAO = { concluida: "Concluída integralmente", parcial: "Concluída parcialmente (há registros recusados)", falhou: "Falhou", pendente: "Pendente", ja_realizada: "Já realizada anteriormente" };
function renderizarRelatorioMigracao() {
  const box = $("relatorioMigracao"), r = lerJson(RELATORIO_CHAVE);
  box.hidden = $("tituloRelatorio").hidden = !r;
  box.innerHTML = "";
  if (!r) return;
  const situacao = r.situacao || ((r.rejeitados || []).length ? "parcial" : "concluida");    // relatórios antigos não tinham "situacao"
  const total = r.totalRejeitados !== undefined ? r.totalRejeitados : (r.rejeitados || []).length;
  box.append(linhaInfo("Situação", SITUACOES_MIGRACAO[situacao] || situacao, situacao === "concluida" || situacao === "ja_realizada" ? "g" : "d"),
    linhaInfo("Data e hora", new Date(r.quando).toLocaleString("pt-BR")));
  Object.keys(NOMES_TABELAS).forEach((n) => {
    const env = (r.enviados && r.enviados[n]) || 0, rec = (r.recebidos && r.recebidos[n]) || 0;
    if (env || rec) box.append(linhaInfo(NOMES_TABELAS[n], env + " enviados • " + rec + " trazidos"));
  });
  box.append(linhaInfo("Recusados pelo servidor", String(total), total ? "d" : "g"), linhaInfo("Possíveis duplicatas", String(r.duplicatas || 0), r.duplicatas ? "d" : "g"));
  Object.keys(r.motivos || {}).forEach((motivo) => box.append(linhaInfo("Motivo", r.motivos[motivo] + "× " + motivo, "d")));
  if (r.erro) box.append(linhaInfo("Erro", r.erro, "d"));
  if (r.jaMigrado) box.append(el("p", "dica", "Estes mesmos dados já tinham sido migrados antes para esta conta."));
}

/* ---------- 9. Inicialização ---------- */
// Observa gravações do app no LocalStorage para agendar o envio. Só as chaves de DADOS disparam; instalada uma única vez;
// um erro aqui nunca pode atrapalhar a gravação do aplicativo (o armazenamento já foi gravado antes de observar).
function instalarObservadorStorage() {
  if (Storage.prototype.setItem.__movixSync) return;
  const setOriginal = Storage.prototype.setItem, removeOriginal = Storage.prototype.removeItem;
  const observar = (alvo, k) => { try { if (alvo === localStorage && CHAVES_DADOS.includes(String(k))) agendar(); } catch (erro) { /* ignora */ } };
  const novoSet = function (k, v) { setOriginal.call(this, k, v); observar(this, k); };
  const novoRemove = function (k) { removeOriginal.call(this, k); observar(this, k); };
  novoSet.__movixSync = novoRemove.__movixSync = true;
  Storage.prototype.setItem = novoSet; Storage.prototype.removeItem = novoRemove;
}

// Mudança de usuário (logout, login de outra conta): cancela o ciclo em andamento, os timers e o "refazer" da conta anterior.
// Renovação de token da MESMA conta não é mudança de usuário.
function aoMudarSessao() {
  const atual = usuarioAtual();
  if (atual !== usuarioVisto) {
    usuarioVisto = atual;
    cancelarCiclo("conta_mudou");
    clearTimeout(timerSync); timerSync = null; clearTimeout(timerBackup); timerBackup = null; tentativasBackup = 0;
    refazer = false; ultimoErroAvisado = "";
  }
  renderizarSync();
  if (podeSincronizar()) sincronizar();
}

function iniciarSync() {
  carregarEstadoSync();
  instalarObservadorStorage();
  usuarioVisto = usuarioAtual();

  $("btnSyncAtivar").addEventListener("click", ativarSincronizacao);
  $("btnSyncAgora").addEventListener("click", () => sincronizar());
  $("btnSyncPausar").addEventListener("click", pausarSincronizacao);
  $("btnDuplicatas").addEventListener("click", mostrarDuplicatas);
  $("btnRestaurarPreventivo").addEventListener("click", restaurarBackupPreventivo);
  // Backup JSON importado: registra a importação na conta (melhor esforço) e avisa se já foi feita
  document.addEventListener("movix:backup-importado", async (ev) => {
    const dono = usuarioAtual();
    if (!dono || !lerConfiguracao().ok || !navigator.onLine) return;
    try {
      const checksum = await calcularChecksum(ev.detail.texto);
      const resumo = { adicionados: ev.detail.adicionados, ignorados: ev.detail.ignorados };
      const r = await registrarMigracao("backup_json", checksum, resumo, dono);
      if (r.jaFeita) toast("Este backup já tinha sido importado nesta conta em " + new Date(r.quando).toLocaleDateString("pt-BR") + ". Nada foi duplicado.");
      else await finalizarMigracao(r.id, "concluida", { ...resumo, situacao: "concluida" }, null, dono);
    } catch (e) { /* registro é opcional */ }
  });
  document.addEventListener("movix:auth", aoMudarSessao);
  window.addEventListener("online", () => sincronizar());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sincronizar(); });
  setInterval(() => { if (!document.hidden) sincronizar(); }, 60000);

  renderizarSync();
  sincronizar();
}

iniciarSync();
