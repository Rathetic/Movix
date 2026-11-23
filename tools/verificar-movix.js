#!/usr/bin/env node
/* =====================================================
   Movix – verificador estático de regressão (rede de segurança do redesign)
   Uso (na pasta do projeto, com Node instalado):
     node tools/verificar-movix.js                  -> compara o projeto com tools/baseline.json
     node tools/verificar-movix.js --gerar-baseline -> grava o estado atual como referência
   O que confere (nada é executado no navegador, nada é alterado):
     1. Sintaxe de todos os .js (node --check)
     2. Nenhum id do HTML da referência foi removido ou renomeado
     3. Todo id usado pelo JS ($("x"), getElementById, #x) existe no HTML
     4. Nenhuma chave de LocalStorage (motograna:* e movix:*) foi alterada
     5. Toda classe que o JS aplica continua definida no CSS
     6. Seletores críticos do Lobby/login continuam no CSS
     7. Links do menu (#sec-...) apontam para ids existentes
     8. Arquivos .js que mudaram desde a referência (informativo)
   Código de saída: 0 = tudo certo; 1 = há falhas.
   ===================================================== */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const ARQ_JS = ["script.js", "auth.js", "sync.js", "frete.js", "lobby.js", "config.js", "nav.js"];   // nav.js: etapa 2
const BASELINE = path.join(__dirname, "baseline.json");
const ler = (f) => fs.readFileSync(path.join(RAIZ, f), "utf8");
const unicos = (a) => [...new Set(a)].sort();
const todos = (re, texto, g = 1) => [...texto.matchAll(re)].map((m) => m[g]);

// Ids que o redesign PODE remover de propósito, com etapa e aprovação (preencher só quando autorizado)
const REMOCOES_AUTORIZADAS = [];

// Seletores/trechos que precisam continuar no CSS (fluxo Lobby e login)
const CSS_CRITICO = [
  "html.lobby-ativo:not(.tela-auth) #lobby",
  "html.lobby-ativo .menu",
  "html.lobby-ativo.tela-auth .container > :not(#sec-conta)",
  "html.tela-auth .auth-logo",
  "html.tela-auth .so-lobby",
  ".so-lobby { display: none; }",
  ".toast.mostrar",
  "[hidden] { display: none !important; }",
  "html.nav-pronta:not(.lobby-ativo) .container > [data-pagina]:not(.pagina-ativa)",
  "html.lobby-ativo .menu-inferior"
];

function coletar() {
  const html = ler("index.html");
  const css = ler("style.css");
  const js = ARQ_JS.map((f) => ler(f)).join("\n");
  const idsHtml = unicos(todos(/\bid="([^"]+)"/g, html));
  const idsUsadosJs = unicos([
    ...todos(/\$\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g, js),
    ...todos(/getElementById\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g, js),
    ...todos(/["']#([A-Za-z][A-Za-z0-9_-]*)(?:[\s.>"'\[:])/g, js)
  ]).filter((i) => !/^[0-9a-f]{3,8}$/i.test(i));   // ignora cores hex como "#a78bfa"
  const chaves = unicos(todos(/["']((?:motograna|movix):[A-Za-z0-9_:-]+)["']/g, js));
  const classesJs = unicos([
    ...todos(/className\s*=\s*"([^"]+)"/g, js).flatMap((s) => s.trim().split(/\s+/)),
    ...todos(/\bel\(\s*"[a-z0-9]+"\s*,\s*"([^"]+)"/g, js).flatMap((s) => s.trim().split(/\s+/)),
    ...todos(/classList\.(?:add|toggle|remove)\(\s*"([^"]+)"/g, js)
  ]).filter((c) => /^[a-z][a-z0-9-]*$/i.test(c));
  const classesSemCss = classesJs.filter((c) => !new RegExp("\\." + c.replace(/-/g, "\\-") + "(?![\\w-])").test(css));
  const idsFaltando = idsUsadosJs.filter((i) => !idsHtml.includes(i));
  const ancoras = unicos(todos(/href="#(sec-[^"]+)"/g, html));
  const hashes = {};
  ARQ_JS.forEach((f) => { hashes[f] = crypto.createHash("sha256").update(fs.readFileSync(path.join(RAIZ, f))).digest("hex").slice(0, 16); });
  const cssAusente = CSS_CRITICO.filter((s) => !css.includes(s));
  // Rotas (etapa 2)
  const paginasHtml = unicos(todos(/\bdata-pagina="([a-z]+)"/g, html));
  const rotasMenu = unicos(todos(/href="#\/([a-z]+)"/g, html));
  const navJs = fs.existsSync(path.join(RAIZ, "nav.js")) ? ler("nav.js") : "";
  const blocoRotas = /const ROTAS = \{([\s\S]*?)\};/.exec(navJs);
  const rotasNavJs = blocoRotas ? unicos(todos(/([a-z]+)\s*:/g, blocoRotas[1])) : [];
  const secoesSemPagina = unicos(todos(/<[a-z]+\b[^>]*\bid="(sec-[^"]+)"[^>]*>/g, html).filter((id) => !new RegExp("<[a-z]+\\b[^>]*\\bdata-pagina=\"[a-z]+\"[^>]*\\bid=\"" + id + "\"|<[a-z]+\\b[^>]*\\bid=\"" + id + "\"[^>]*\\bdata-pagina=").test(html)));
  const miolo = html.slice(html.indexOf('<main class="container">'), html.indexOf("</main>", html.indexOf('<main class="container">')));
  const filhosSemPagina = miolo.split("\n").filter((l) => /^    <(section|p|div|details|form)\b/.test(l) && !/data-pagina=/.test(l)).map((l) => l.trim().slice(0, 70));
  return { idsHtml, idsUsadosJs, idsFaltando, chaves, classesJs, classesSemCss, ancoras, hashes, cssAusente, paginasHtml, rotasMenu, rotasNavJs, secoesSemPagina, filhosSemPagina };
}

if (process.argv.includes("--gerar-baseline")) {
  const c = coletar();
  fs.writeFileSync(BASELINE, JSON.stringify({
    gerado: new Date().toISOString(), idsHtml: c.idsHtml, idsFaltando: c.idsFaltando,
    chaves: c.chaves, classesSemCss: c.classesSemCss, hashes: c.hashes
  }, null, 2));
  console.log("Baseline gravado em tools/baseline.json");
  console.log("  ids no HTML: " + c.idsHtml.length + " | chaves de armazenamento: " + c.chaves.length + " | arquivos JS: " + ARQ_JS.length);
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) { console.error("Sem tools/baseline.json. Rode antes: node tools/verificar-movix.js --gerar-baseline"); process.exit(1); }
const ref = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const c = coletar();
let falhas = 0;
const ok = (t) => console.log("  [OK]    " + t);
const ruim = (t, itens) => { falhas++; console.log("  [FALHA] " + t); (itens || []).forEach((i) => console.log("            - " + i)); };
const aviso = (t, itens) => { console.log("  [AVISO] " + t); (itens || []).forEach((i) => console.log("            - " + i)); };

console.log("Verificando o Movix contra a referência de " + ref.gerado + "\n");

// 1. Sintaxe
const errosSintaxe = [];
ARQ_JS.forEach((f) => { try { execFileSync(process.execPath, ["--check", path.join(RAIZ, f)], { stdio: "pipe" }); } catch (e) { errosSintaxe.push(f + ": " + String(e.stderr || e.message).split("\n")[0]); } });
errosSintaxe.length ? ruim("Erro de sintaxe em JavaScript", errosSintaxe) : ok("Sintaxe de " + ARQ_JS.length + " arquivos JS");

// 2. Ids da referência
const removidos = ref.idsHtml.filter((i) => !c.idsHtml.includes(i) && !REMOCOES_AUTORIZADAS.includes(i));
removidos.length ? ruim("Ids da referência removidos ou renomeados", removidos) : ok("Todos os " + ref.idsHtml.length + " ids da referência continuam no HTML");
const novos = c.idsHtml.filter((i) => !ref.idsHtml.includes(i));
const novosIcones = novos.filter((i) => i.startsWith("i-")), novosOutros = novos.filter((i) => !i.startsWith("i-"));
if (novosIcones.length) ok(novosIcones.length + " símbolos de ícone no sprite (ids i-*)");
if (novosOutros.length) aviso(novosOutros.length + " id(s) novo(s) (permitido, só conferir se são intencionais)", novosOutros);

// 3. Ids usados pelo JS
const novosFaltando = c.idsFaltando.filter((i) => !ref.idsFaltando.includes(i));
novosFaltando.length ? ruim("O JS usa ids que não existem no HTML", novosFaltando) : ok("Todo id usado pelo JS existe no HTML");
if (ref.idsFaltando.length) aviso("Já faltavam na referência (ids criados por JS ou seletores genéricos; ignorados)", ref.idsFaltando);

// 4. Chaves de armazenamento
const chavesPerdidas = ref.chaves.filter((k) => !c.chaves.includes(k));
const chavesNovas = c.chaves.filter((k) => !ref.chaves.includes(k));
(chavesPerdidas.length || chavesNovas.length)
  ? ruim("Chaves de LocalStorage diferentes da referência", [...chavesPerdidas.map((k) => "sumiu: " + k), ...chavesNovas.map((k) => "nova: " + k)])
  : ok(ref.chaves.length + " chaves de LocalStorage idênticas");

// 5. Classes aplicadas pelo JS
const classesNovasSemCss = c.classesSemCss.filter((k) => !ref.classesSemCss.includes(k));
classesNovasSemCss.length ? ruim("Classes aplicadas pelo JS sem regra no CSS", classesNovasSemCss) : ok("Classes aplicadas pelo JS continuam estilizadas");

// 6. CSS crítico
c.cssAusente.length ? ruim("Trechos críticos do Lobby/login sumiram do CSS", c.cssAusente) : ok("Seletores críticos do Lobby/login presentes");

// 7. Âncoras
const htmlIds = new Set(c.idsHtml);
const ancorasQuebradas = c.ancoras.filter((a) => !htmlIds.has(a));
if (ancorasQuebradas.length) ruim("Links do menu apontam para ids inexistentes", ancorasQuebradas); else if (c.ancoras.length) ok(c.ancoras.length + " links #sec-... apontam para ids existentes");

// 8. JS alterado
const mudados = ARQ_JS.filter((f) => ref.hashes[f] !== c.hashes[f]);
mudados.length ? aviso("Arquivos JS diferentes da referência (esperado só se a etapa autorizou)", mudados) : ok("Nenhum arquivo JS foi alterado desde a referência");

// 9. Rotas da navegação (etapa 2)
const rotasSemPagina = c.rotasMenu.filter((r) => !c.paginasHtml.includes(r));
const rotasForaDoNav = c.rotasMenu.filter((r) => !c.rotasNavJs.includes(r));
const paginasSemLink = c.paginasHtml.filter((r) => !c.rotasMenu.includes(r));
const rotasNavSemPagina = c.rotasNavJs.filter((r) => !c.paginasHtml.includes(r));
(rotasSemPagina.length || rotasForaDoNav.length || paginasSemLink.length || rotasNavSemPagina.length)
  ? ruim("Rotas inconsistentes entre menu, páginas (data-pagina) e nav.js", [
      ...rotasSemPagina.map((r) => "link #/" + r + " sem nenhuma seção data-pagina=\"" + r + "\""),
      ...rotasForaDoNav.map((r) => "link #/" + r + " não está em ROTAS (nav.js)"),
      ...paginasSemLink.map((r) => "página \"" + r + "\" sem link no menu (inalcançável)"),
      ...rotasNavSemPagina.map((r) => "rota \"" + r + "\" em nav.js sem seção")])
  : ok(c.rotasMenu.length + " rotas (#/...) consistentes entre menu, páginas e nav.js");
(c.secoesSemPagina.length || c.filhosSemPagina.length)
  ? ruim("Conteúdo do app sem data-pagina (apareceria em todas as páginas)", [...c.secoesSemPagina.map((i) => "#" + i), ...c.filhosSemPagina])
  : ok("Todas as seções do app pertencem a uma página");

console.log("\n" + (falhas ? falhas + " falha(s). Não siga para a próxima etapa." : "Tudo certo."));
process.exit(falhas ? 1 : 0);
