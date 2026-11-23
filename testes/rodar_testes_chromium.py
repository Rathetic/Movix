import json, sys, time
# Executa testes/backup-local.teste.html no Chromium. Uso: python3 rodar_testes_chromium.py [http://localhost:8765]
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765").rstrip("/")
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context()
    pg = ctx.new_page()
    erros = []
    pg.on("pageerror", lambda e: erros.append("pageerror: " + str(e)[:300]))
    pg.on("console", lambda m: erros.append("console." + m.type + ": " + m.text[:200]) if m.type == "error" else None)
    pg.goto(BASE + "/testes/backup-local.teste.html#auto")
    t0 = time.time()
    while time.time() - t0 < 280:
        if pg.evaluate("window.__fim === true"): break
        time.sleep(1)
    res = pg.evaluate("window.__resultados")
    print("tempo: %.0fs, testes: %d" % (time.time() - t0, len(res)))
    for r in res:
        print(("OK   " if r["ok"] else "FALHA"), r["n"], r["nome"][:90])
        if not r["ok"]:
            for d in r["detalhes"]: print("      ->", d[:400])
    print("RESUMO:", pg.evaluate("document.getElementById('resumo').textContent"))
    if erros: print("ERROS DE PÁGINA:", erros[:8])
    b.close()
