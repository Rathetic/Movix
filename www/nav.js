/* =====================================================
   Movix – Navegação por páginas (etapa 2)
   O que este arquivo faz:
     1. Roteamento por hash: #/inicio, #/jornada, #/frete, #/financeiro ...
        Cada seção do index.html tem data-pagina="rota"; aqui só se mostra a página escolhida.
        Funciona no GitHub Pages (não precisa de servidor) e com Voltar/Avançar do navegador.
     2. Marca o item ativo (aria-current="page") na barra lateral, na barra inferior e no "Mais".
     3. Celular: abre e fecha o painel "Mais".
     4. Computador: botão para recolher a barra lateral (a escolha vale só nesta sessão do navegador).
     5. Tablet / barra recolhida: dica com o nome do destino.
   O que este arquivo NÃO faz: não mexe em login, Lobby, sincronização, cálculos, banco
   nem LocalStorage. Só mostra/esconde seções que já existem.
   Depende apenas do HTML (não usa funções dos outros .js). Carregado por último, depois do lobby.js.
   ===================================================== */
(function () {
  "use strict";

  // Páginas que existem (rota -> nome). Cada rota precisa ter ao menos uma seção com data-pagina="rota".
  const ROTAS = {
    inicio: "Início",
    jornada: "Jornada",
    frete: "Frete",
    financeiro: "Financeiro",
    graficos: "Gráficos",
    combustivel: "Combustível",
    garagem: "Garagem",
    cofrinho: "Cofrinho",
    recordes: "Recordes",
    conta: "Conta",
    backup: "Backup"
  };
  const ROTA_PADRAO = "inicio";
  // Rotas que no celular ficam dentro do botão "Mais" (para ele ficar destacado quando uma delas está aberta)
  const ROTAS_DO_MAIS = ["graficos", "combustivel", "garagem", "cofrinho", "recordes", "conta", "backup"];
  // Endereços antigos (#sec-...) continuam funcionando: levam para a página que hoje contém a seção
  const ENDERECOS_ANTIGOS = {
    "sec-resumo": "inicio", "sec-alertas": "inicio", "sec-hoje": "inicio",
    "sec-graficos": "graficos", "sec-combustivel": "combustivel", "sec-frete": "frete",
    "sec-manutencao": "garagem", "sec-jornada": "jornada", "sec-cofrinho": "cofrinho",
    "sec-recordes": "recordes", "sec-conta": "conta", "sec-backup": "backup"
  };
  const CHAVE_MENU_RECOLHIDO = "movix-menu-recolhido";   // sessionStorage (não é LocalStorage)

  const raiz = document.documentElement;
  let rotaAtual = null;
  let eraLobby = raiz.classList.contains("lobby-ativo");
  let temporizadorDica = null;

  const emLobby = () => raiz.classList.contains("lobby-ativo");
  const porId = (id) => document.getElementById(id);

  /* ---------- 1. Endereço (hash) ---------- */

  // Lê o hash e diz o que ele significa: rota válida, endereço antigo, link de e-mail ou nada
  function lerEndereco() {
    const h = location.hash;
    if (/access_token|error_description/.test(h)) return { tipo: "email" };   // link de confirmação/recuperação: não mexer!
    const m = /^#\/([a-z]+)\/?$/.exec(h);
    if (m && ROTAS[m[1]]) return { tipo: "rota", rota: m[1] };
    const a = /^#(sec-[a-z-]+)$/.exec(h);
    if (a && ENDERECOS_ANTIGOS[a[1]]) return { tipo: "antigo", rota: ENDERECOS_ANTIGOS[a[1]] };
    return { tipo: "nenhum" };
  }

  // Troca o endereço SEM criar nova entrada no histórico (preserva o state usado pelo Lobby)
  function gravarEndereco(rota) {
    try { history.replaceState(history.state, "", "#/" + rota); } catch (erro) { /* ignora */ }
  }

  /* ---------- 2. Mostrar a página ---------- */

  function mostrarRota(rota) {
    const mudou = rota !== rotaAtual;
    rotaAtual = rota;
    document.querySelectorAll("[data-pagina]").forEach((el) => el.classList.toggle("pagina-ativa", el.dataset.pagina === rota));
    document.querySelectorAll("[data-rota]").forEach((el) => {
      if (el.dataset.rota === rota) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    });
    const botaoMais = porId("btnMais");
    if (botaoMais) botaoMais.classList.toggle("tem-ativo", ROTAS_DO_MAIS.indexOf(rota) !== -1);
    raiz.dataset.rota = rota;
    document.title = ROTAS[rota] + " – Movix";
    fecharMais(false);
    esconderDica();
    if (mudou) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // O gráfico mede a largura da tela ao desenhar; escondido ele mede 0. Ao abrir a página, pede para redesenhar.
    if (rota === "graficos") requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  // Segue o endereço atual. "corrigir" = escrever a rota certa no endereço quando ele estiver vazio/antigo/inválido
  function seguirEndereco(corrigir) {
    const e = lerEndereco();
    if (e.tipo === "email") { mostrarRota(rotaAtual || "conta"); return; }   // o auth.js limpa o hash sozinho
    const rota = e.tipo === "nenhum" ? ROTA_PADRAO : e.rota;
    mostrarRota(rota);
    if (corrigir && e.tipo !== "rota" && !emLobby()) gravarEndereco(rota);
  }

  /* ---------- 3. Painel "Mais" (celular) ---------- */

  function maisAberto() { const p = porId("menuMais"); return Boolean(p) && !p.hidden; }

  function abrirMais() {
    const painel = porId("menuMais"), botao = porId("btnMais");
    if (!painel || !botao) return;
    painel.hidden = false;
    porId("maisFundo").hidden = false;
    botao.setAttribute("aria-expanded", "true");
    const primeiro = painel.querySelector("a");
    if (primeiro) primeiro.focus();
  }

  function fecharMais(devolverFoco) {
    const painel = porId("menuMais"), botao = porId("btnMais");
    if (!painel || painel.hidden) return;
    painel.hidden = true;
    porId("maisFundo").hidden = true;
    botao.setAttribute("aria-expanded", "false");
    if (devolverFoco) botao.focus();
  }

  // Mantém o Tab dentro do painel enquanto ele está aberto
  function prenderFoco(ev) {
    const itens = porId("menuMais").querySelectorAll("a");
    if (!itens.length) return;
    const primeiro = itens[0], ultimo = itens[itens.length - 1];
    if (ev.shiftKey && document.activeElement === primeiro) { ev.preventDefault(); ultimo.focus(); }
    else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primeiro.focus(); }
  }

  /* ---------- 4. Barra lateral recolhível (computador) ---------- */

  function aplicarMenuRecolhido(recolhido, guardar) {
    raiz.classList.toggle("menu-recolhido", recolhido);
    const botao = porId("btnMenuRecolher");
    if (botao) {
      botao.setAttribute("aria-expanded", String(!recolhido));
      botao.setAttribute("aria-label", recolhido ? "Expandir menu" : "Recolher menu");
      const rotulo = botao.querySelector(".rotulo");
      if (rotulo) rotulo.textContent = recolhido ? "Expandir menu" : "Recolher menu";
    }
    esconderDica();
    if (guardar) { try { sessionStorage.setItem(CHAVE_MENU_RECOLHIDO, recolhido ? "1" : "0"); } catch (erro) { /* ignora */ } }
  }

  /* ---------- 5. Dica com o nome do destino (barra compacta) ---------- */

  // A barra está só com ícones? (tablet, ou computador com a barra recolhida)
  function barraCompacta() {
    if (window.matchMedia("(min-width: 701px) and (max-width: 1023px)").matches) return true;
    return window.matchMedia("(min-width: 1024px)").matches && raiz.classList.contains("menu-recolhido");
  }

  function dicaElemento() {
    let d = porId("dicaMenu");
    if (!d) { d = document.createElement("div"); d.id = "dicaMenu"; d.className = "dica-menu"; d.setAttribute("aria-hidden", "true"); document.body.appendChild(d); }
    return d;
  }

  function mostrarDica(alvo, tempoMs) {
    if (!barraCompacta()) return;
    const rotulo = alvo.querySelector(".rotulo");
    if (!rotulo) return;
    const d = dicaElemento(), r = alvo.getBoundingClientRect();
    d.textContent = rotulo.textContent;
    d.style.left = Math.round(r.right + 10) + "px";
    d.style.top = Math.round(r.top + r.height / 2) + "px";
    d.classList.add("mostrar");
    clearTimeout(temporizadorDica);
    if (tempoMs) temporizadorDica = setTimeout(esconderDica, tempoMs);   // toque: some sozinha
  }

  function esconderDica() {
    clearTimeout(temporizadorDica);
    const d = porId("dicaMenu");
    if (d) d.classList.remove("mostrar");
  }

  /* ---------- 6. Ligações ---------- */

  function iniciarNavegacao() {
    // Clique em qualquer link de rota: fecha o "Mais"; se já está nessa página, só volta ao topo
    document.addEventListener("click", (ev) => {
      const link = ev.target.closest && ev.target.closest("a[data-rota]");
      if (link) {
        fecharMais(false);
        if (link.dataset.rota === rotaAtual) { ev.preventDefault(); window.scrollTo({ top: 0, left: 0, behavior: "smooth" }); }
        return;
      }
      if (ev.target.closest && ev.target.closest("#btnMais")) { maisAberto() ? fecharMais(true) : abrirMais(); return; }
      if (ev.target === porId("maisFundo")) fecharMais(true);
    });

    // "Preencher no formulário" (resumo do turno) rola até o formulário da Jornada: garante que a página Jornada esteja aberta
    document.addEventListener("click", (ev) => {
      if (ev.target.closest && ev.target.closest("#btnResumoFormulario") && rotaAtual !== "jornada") {
        mostrarRota("jornada");
        try { history.pushState(history.state, "", "#/jornada"); } catch (erro) { /* ignora */ }
      }
    }, true);

    document.addEventListener("keydown", (ev) => {
      if (!maisAberto()) return;
      if (ev.key === "Escape") { ev.preventDefault(); fecharMais(true); }
      else if (ev.key === "Tab") prenderFoco(ev);
    });

    // Voltar / Avançar do navegador e links com #/rota
    window.addEventListener("hashchange", () => seguirEndereco(true));

    // Girar o celular / redimensionar: o painel "Mais" só existe no layout de celular
    window.matchMedia("(max-width: 700px)").addEventListener("change", (mq) => { if (!mq.matches) fecharMais(false); esconderDica(); });

    // Dicas (mouse e teclado)
    const menu = porId("menuLateral");
    menu.addEventListener("mouseover", (ev) => { const a = ev.target.closest("a, button"); if (a && menu.contains(a)) mostrarDica(a); });
    menu.addEventListener("mouseleave", esconderDica);
    menu.addEventListener("focusin", (ev) => { const a = ev.target.closest("a, button"); if (a) mostrarDica(a); });
    menu.addEventListener("focusout", esconderDica);
    menu.addEventListener("scroll", esconderDica);
    // Dica ao toque (tablet): aparece por instantes ao tocar
    menu.addEventListener("pointerdown", (ev) => { if (ev.pointerType === "touch") { const a = ev.target.closest("a, button"); if (a) mostrarDica(a, 1400); } });

    // Botão de recolher
    porId("btnMenuRecolher").addEventListener("click", () => aplicarMenuRecolhido(!raiz.classList.contains("menu-recolhido"), true));
    let guardado = null;
    try { guardado = sessionStorage.getItem(CHAVE_MENU_RECOLHIDO); } catch (erro) { /* ignora */ }
    aplicarMenuRecolhido(guardado === "1", false);

    // Saiu do Lobby/login e entrou no app (login, criar conta, "Usar sem conta"): começa no Início
    new MutationObserver(() => {
      const agora = emLobby();
      if (eraLobby && !agora) { mostrarRota(ROTA_PADRAO); gravarEndereco(ROTA_PADRAO); }
      eraLobby = agora;
    }).observe(raiz, { attributes: true, attributeFilter: ["class"] });

    // Primeira página. Se abriu por link de e-mail (confirmação/recuperação), o app mostra a página Conta.
    raiz.classList.add("nav-pronta");
    if (window.__movixLinkEmail) {
      mostrarRota("conta");
      if (!emLobby() && !/access_token|error_description/.test(location.hash)) gravarEndereco("conta");
    } else {
      seguirEndereco(true);
    }
  }

  iniciarNavegacao();
})();
