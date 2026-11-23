"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { SupabaseFake } = require("./_supabase_fake"); const { appLogado, mov } = require("./_app");
test("harness: app real carrega, envia 3 movimentações e recebe de volta (referência de sanidade)", async () => {
  const srv = new SupabaseFake();
  const app = appLogado(srv, "u1", { seed: { "motograna:movimentacoes": [mov(1), mov(2), mov(3)] } });
  await app.ocioso();
  assert.equal(srv.linhas("movimentacoes", "u1").length, 3);
  assert.equal(app.json("movimentacoes.length"), 3);
  app.fechar();
});
