package cn.szucourt.booker;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.app.Activity;
import androidx.activity.result.ActivityResult;
import android.util.AtomicFile;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Only foreground execution. No scheduler, service, alarm, or background permission. */
@CapacitorPlugin(name = "CourtDevice")
public class CourtDevicePlugin extends Plugin {
    private final ExecutorService network = Executors.newFixedThreadPool(4);
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS).callTimeout(8, TimeUnit.SECONDS).build();
    private volatile boolean foreground = true;
    private volatile String executionToken;
    private boolean loginPending;

    @PluginMethod public void login(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!foreground || executionToken != null) { call.reject("请先停止预约，再在前台登录"); return; }
            if (loginPending) { call.reject("登录窗口已经打开"); return; }
            loginPending = true;
            try { startActivityForResult(call, new Intent(getContext(), SchoolLoginActivity.class), "loginResult"); }
            catch (Exception error) { loginPending = false; call.reject("无法打开学校登录窗口", error); }
        });
    }
    @ActivityCallback private void loginResult(PluginCall call, ActivityResult result) {
        loginPending = false;
        if (call == null) return; // Activity was recreated; do not silently store credentials.
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) { call.reject("已取消登录，原账号未改动", "LOGIN_CANCELLED"); return; }
        String cookie = data.getStringExtra("cookie"), agent = data.getStringExtra("userAgent");
        if (cookie == null || agent == null) { call.reject("登录信息不完整，请重试"); return; }
        JSObject captured = new JSObject(); captured.put("cookie", cookie); captured.put("userAgent", agent);
        call.resolve(captured);
    }

    private AtomicFile stateFile() { return new AtomicFile(new File(getContext().getFilesDir(), "court-state-v1.json")); }

    @PluginMethod public void readState(PluginCall call) {
        storage.execute(() -> {
            try {
                AtomicFile file = stateFile();
                JSObject result = new JSObject();
                result.put("value", file.getBaseFile().exists() ? new String(file.readFully(), StandardCharsets.UTF_8) : null);
                call.resolve(result);
            } catch (Exception error) { call.reject("读取本地数据失败", error); }
        });
    }

    @PluginMethod public void writeState(PluginCall call) {
        final String value = call.getString("value");
        if (value == null || value.length() > 20_000_000) { call.reject("本地数据过大或为空"); return; }
        storage.execute(() -> {
            AtomicFile file = stateFile(); FileOutputStream out = null;
            try {
                new JSObject(value); // Do not overwrite valid storage with malformed JSON.
                out = file.startWrite(); out.write(value.getBytes(StandardCharsets.UTF_8));
                file.finishWrite(out); call.resolve();
            } catch (Exception error) { if (out != null) file.failWrite(out); call.reject("保存本地数据失败，已停止后续预约", error); }
        });
    }

    @PluginMethod public void copy(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            manager.setPrimaryClip(ClipData.newPlainText("场馆预约登录信息", call.getString("text", "")));
            call.resolve();
        });
    }

    @PluginMethod public void setExecution(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            String token = call.getString("token");
            if (enabled && (!foreground || token == null || loginPending)) { call.reject("App 不在前台或正在登录，不能执行"); return; }
            executionToken = enabled ? token : null;
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod public void request(PluginCall call) {
        final String token = call.getString("token");
        network.execute(() -> {
            try {
                if (token != null && (!foreground || !token.equals(executionToken))) throw new IllegalStateException("本次执行已中断，未发送请求");
                HttpUrl url = HttpUrl.parse(call.getString("url", ""));
                if (url == null || !url.isHttps() || !url.host().equals("ehall.szu.edu.cn") || url.port() != 443
                    || !url.encodedPath().startsWith("/qljfwapp/")) throw new IllegalArgumentException("只允许学校场馆 HTTPS 接口");
                String method = call.getString("method", "GET");
                if (!method.equals("GET") && !method.equals("POST")) throw new IllegalArgumentException("请求方法无效");
                if (url.encodedPath().endsWith("insertVenueBookingInfo.do") && token == null) throw new IllegalStateException("预约必须在前台执行中发起");
                Request.Builder builder = new Request.Builder().url(url);
                JSObject headers = call.getObject("headers", new JSObject());
                for (Iterator<String> it = headers.keys(); it.hasNext();) {
                    String key = it.next(); builder.header(key, headers.getString(key));
                }
                if (method.equals("POST")) builder.post(RequestBody.create(
                    call.getString("body", ""), MediaType.get("application/x-www-form-urlencoded; charset=UTF-8")));
                else builder.get();
                // Check again immediately before dispatch. onPause invalidates the token permanently.
                if (token != null && (!foreground || !token.equals(executionToken))) throw new IllegalStateException("本次执行已中断，未发送请求");
                try (Response response = http.newCall(builder.build()).execute()) {
                    JSObject result = new JSObject(); JSObject responseHeaders = new JSObject();
                    for (String key : response.headers().names()) responseHeaders.put(key, new JSArray(response.headers().values(key)));
                    result.put("status", response.code()); result.put("headers", responseHeaders);
                    result.put("body", response.body() == null ? "" : response.body().string()); call.resolve(result);
                }
            } catch (Exception error) { call.reject(error.getMessage() == null ? "网络请求失败" : error.getMessage(), error); }
        });
    }

    @Override protected void handleOnPause() {
        foreground = false; executionToken = null;
        getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        JSObject state = new JSObject(); state.put("active", false); notifyListeners("foreground", state, true);
    }
    @Override protected void handleOnResume() {
        foreground = true;
        JSObject state = new JSObject(); state.put("active", true); notifyListeners("foreground", state, true);
    }
    @Override protected void handleOnDestroy() { executionToken = null; network.shutdown(); storage.shutdown(); }
}
