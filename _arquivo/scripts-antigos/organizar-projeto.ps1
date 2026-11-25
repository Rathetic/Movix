# Movix - organiza docs e arquivos soltos (Opcao A: o app continua na raiz).
# Nada e apagado: tudo e movido. Rode na RAIZ do repositorio, numa branch que NAO seja a main.
$ErrorActionPreference = "Continue"
if (-not (Test-Path ".git")) { Write-Host "ERRO: rode na raiz do repositorio (pasta com .git)."; exit 1 }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -eq "main") { Write-Host "ERRO: voce esta na main. Rode antes: git switch -c reorganizacao"; exit 1 }

function Mover($origem, $destino) {
  if (-not (Test-Path -LiteralPath $origem)) { Write-Host "ignorado (nao existe): $origem"; return }
  $dir = Split-Path $destino
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  git ls-files --error-unmatch -- $origem 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { git mv -- $origem $destino } else { Move-Item -LiteralPath $origem -Destination $destino }
  Write-Host "movido: $origem -> $destino"
}

# 1) Documentacao
Mover "AUDITORIA-CORRECOES-24-11.md"  "docs/historico/AUDITORIA-CORRECOES-24-11.md"
Mover "CORRECAO-MANUTENCAO-DESPESAS.md" "docs/historico/CORRECAO-MANUTENCAO-DESPESAS.md"
Mover "LEIA-ME-km-gps.md"             "docs/historico/LEIA-ME-km-gps.md"
Mover "LEIA-ME-vinculo-veiculos.md"   "docs/historico/LEIA-ME-vinculo-veiculos.md"
Mover "RELATORIO-TECNICO-movix.md"    "docs/historico/RELATORIO-TECNICO-movix.md"
Mover "LEIA-ME.txt"                   "docs/historico/LEIA-ME-E1-carregamento.txt"
Mover "RESULTADO-testes.txt"          "docs/historico/RESULTADO-testes-raiz-antigo.txt"

# 2) Analise anterior de assinaturas ("sp movix")
Mover "sp movix/LEIA-ME.md"        "docs/assinaturas/LEIA-ME-fundacao.md"
Mover "sp movix/STATUS-ANALISE.md" "docs/assinaturas/STATUS-ANALISE-anterior.md"
Mover "sp movix/testes-base.txt"   "docs/assinaturas/testes-base-ambiente-sem-jsdom.txt"
if ((Test-Path -LiteralPath "sp movix") -and -not (Get-ChildItem -LiteralPath "sp movix" -Force)) { Remove-Item -LiteralPath "sp movix" }

# 3) Arquivo morto (_arquivo): patches, zips antigos, script ja usado
Get-ChildItem -File -Filter "*.patch" | ForEach-Object { Mover $_.Name ("_arquivo/patches/" + $_.Name) }
Get-ChildItem -File -Filter "movix*.zip" | ForEach-Object { Mover $_.Name ("_arquivo/pacotes-antigos/" + $_.Name) }
Mover "organizar-imagens.sh" "_arquivo/scripts-antigos/organizar-imagens.sh"

# 4) Arquivos com nome quebrado (sobra de comandos do PowerShell)
Get-ChildItem -File | Where-Object { $_.Name -like "t *PACKAGE JSON*" -or $_.Name -like "t *ULTIMO COMMIT*" -or $_.Name -like "* Select-Object -Skip 100*" } |
  ForEach-Object { Mover $_.Name ("_arquivo/descartados-powershell/" + $_.Name) }

Write-Host ""
Write-Host "Pronto. Copie tambem docs/README.md e docs/assinaturas/AUDITORIA-ETAPA-1.md (arquivos que acompanham este script)."
Write-Host "Depois rode: node tools/verificar-movix.js ; npm test ; git status"
