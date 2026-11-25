# Movix – km automático pelo GPS (fases 1 e 2)

Este pacote é completo: substitui o anterior (movix-km-automatico.zip).

## O que muda
- Ao **iniciar o turno**, o app liga o GPS e soma os km sozinho. No card aparece "📍 X km • GPS ativo".
- **Pausar** para a contagem (o trecho da pausa não entra); **retomar** volta a contar.
- Ao **encerrar**, o campo "Km rodados" do resumo já vem preenchido com o km medido. Dá para ajustar.
- **No app Android a contagem continua com o app em segundo plano ou a tela apagada** (serviço nativo com uma
  notificação "Movix: turno em andamento"). No site (navegador) conta só com a página aberta.
- Se a localização for negada ou o aparelho não tiver GPS, tudo funciona como antes (km manual).
- O app guarda só o **total** e o **último ponto**, nunca o trajeto.

## Arquivos (copiar por cima, preservando as pastas)
    script.js, index.html, capacitor.config.json              -> raiz do projeto
    www/script.js, www/index.html                             -> pasta www/
    android/app/src/main/AndroidManifest.xml                  -> permissões
    android/app/src/main/res/values/strings.xml               -> texto/ícone/cor da notificação
    android/app/src/main/res/drawable/ic_tracking.xml         -> ícone da notificação (novo)
    testes/km-auto.teste.js, testes/km-auto-segundo-plano.teste.js

## Aplicar (nesta ordem, no PowerShell, na pasta do projeto)
    npm install @capgo/background-geolocation@8     # versão 8 = Capacitor 8 (precisa de internet)
    npm test                                        # 86 testes
    npx cap sync android                            # deve listar o plugin background-geolocation
Depois rode pelo Android Studio.

## Testar
1. Inicie um turno. O Android pede **localização** (escolha "Ao usar o app") e **notificações** (permitir).
2. No emulador: "..." > Location > Routes, carregue um GPX/KML e clique em Play. O km sobe no card.
3. Aperte Home (app em segundo plano), espere 1–2 minutos, volte ao Movix: o km deve ter continuado subindo.
4. Pause, retome, encerre: o resumo vem com o km.
5. Em celular de verdade: configure a bateria do Movix como "Sem restrições" (alguns aparelhos, como Xiaomi e Samsung,
   encerram apps em segundo plano por economia de bateria).

## Limites
- Se você **fechar o app deslizando-o para fora** da lista de apps recentes, o Android encerra a contagem. Ao reabrir, o turno
  continua e o GPS volta; o trecho sem sinal soma em linha reta e o resumo avisa que o km pode estar menor que o real.
- Em túnel/garagem o GPS pode falhar por alguns minutos. Pontos com sinal ruim são descartados.
- Ajuste sempre o km no resumo se você sabe que está diferente.

## Play Store (só quando for publicar)
O serviço de localização em primeiro plano costuma exigir uma declaração no Google Play Console (App content > permissões
de serviço em primeiro plano), com a explicação de uso, e a política de privacidade deve citar a localização.
Para instalar o APK direto nos celulares isso não é necessário.

## Observação técnica
O plugin nativo não pôde ser instalado nem compilado no ambiente em que preparei este pacote (sem internet). A parte do
app (JavaScript) foi testada com um plugin simulado; a parte nativa precisa ser conferida no seu emulador/celular.
