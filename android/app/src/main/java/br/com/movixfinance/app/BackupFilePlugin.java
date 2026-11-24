package br.com.movixfinance.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "BackupFile")
public class BackupFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String fileName = call.getString("fileName");
        String content = call.getString("content");

        if (fileName == null || fileName.trim().isEmpty()) {
            call.reject("Nome do arquivo não informado.");
            return;
        }

        if (content == null) {
            call.reject("Conteúdo do backup não informado.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, fileName);

        startActivityForResult(call, intent, "handleSaveResult");
    }

    @ActivityCallback
    private void handleSaveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            JSObject response = new JSObject();
            response.put("saved", false);
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }

        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;

        if (uri == null) {
            call.reject("O Android não retornou o destino do arquivo.");
            return;
        }

        String content = call.getString("content");

        if (content == null) {
            call.reject("Conteúdo do backup não disponível.");
            return;
        }

        try (OutputStream output = getContext()
                .getContentResolver()
                .openOutputStream(uri)) {

            if (output == null) {
                call.reject("Não foi possível abrir o arquivo para gravação.");
                return;
            }

            output.write(content.getBytes(StandardCharsets.UTF_8));
            output.flush();

            JSObject response = new JSObject();
            response.put("saved", true);
            call.resolve(response);

        } catch (Exception error) {
            call.reject("Erro ao gravar o backup: " + error.getMessage());
        }
    }
}