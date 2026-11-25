# Movix — correções da revisão do pacote

## Aplicado nesta revisão

- O histórico de jornadas agora mostra o apelido do veículo vinculado. Jornadas antigas ou sem vínculo mostram “Sem veículo associado”.
- Adicionado teste automatizado cobrindo os dois cenários. A suíte `testes/turno-veiculo.teste.js` passou 11/11.
- `script.js`, `www/script.js` e `android/app/src/main/assets/public/script.js` foram sincronizados e possuem o mesmo SHA-256.
- `sync.js`, `www/sync.js` e o asset Android também foram sincronizados e possuem o mesmo SHA-256.
- `npx cap sync android` (executado via `node node_modules/@capacitor/cli/bin/capacitor sync android`) concluiu com sucesso.
- Android configurado com `versionCode 2` e `versionName 1.1.0`, partindo dos valores 1/1.0 presentes no pacote. Antes de enviar à Play Store, confirme que 2 é maior que o maior versionCode já publicado no Play Console.
- `.gitignore` ampliado para ignorar dependências, caches, builds, configuração local, artefatos APK/AAB, IDE e arquivos temporários.
- Relatório técnico e instruções do vínculo atualizados.

## Validação

- `testes/turno-veiculo.teste.js`: 11/11 aprovados.
- `_smoke.teste.js`: 1/1 aprovado.
- `backup-real.teste.js`: 8/8 aprovados.
- `funcionalidades.teste.js`: 14/14 aprovados.
- `km-auto-segundo-plano.teste.js`: 10/10 aprovados.
- `km-auto.teste.js`: 10/10 aprovados.
- A suíte `sync.teste.js` não terminou dentro do limite de execução desta sessão. A execução completa de 96 testes enviada pelo usuário permanece como linha de base anterior; a nova contagem esperada é 97.
- O registro `testes/RESULTADO-testes.txt` informa 47/47 testes Chromium do módulo e 87/87 de integração aprovados. Não foram reexecutados nesta sessão.

## Pendências externas que não podem ser concluídas só com o ZIP

1. **Supabase real:** precisa de sessão/ambiente de homologação autorizado. Os testes existentes usam Supabase simulado; nenhum banco foi acessado ou alterado nesta revisão.
2. **APK:** `cap sync` foi concluído, mas o Gradle não conseguiu baixar a distribuição `8.14.3` porque o ambiente desta sessão não tem acesso a `services.gradle.org`. Portanto, nenhum APK novo foi gerado.
3. **Play Store:** conferir o maior `versionCode` publicado antes de distribuir.
4. **Aparelho físico:** validar GPS em segundo plano, permissões, instalação/atualização e sincronização entre dois dispositivos.

## Gerar APK no Windows

No PowerShell, na pasta do projeto:

```powershell
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

O APK debug será gerado em `android\app\build\outputs\apk\debug\app-debug.apk`. Para publicação, gerar build release assinado com o keystore privado do responsável; nunca incluir keystore ou senhas no ZIP/repositório.
