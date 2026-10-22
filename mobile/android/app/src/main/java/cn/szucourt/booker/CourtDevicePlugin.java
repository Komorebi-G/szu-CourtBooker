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
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;

/** Only foreground execution. No scheduler, service, alarm, or background permission. */
@CapacitorPlugin(name = "CourtDevice")
public class CourtDevicePlugin extends Plugin {
    // JS serializes each account. Ready independent accounts must not queue
    // behind an unrelated four-account batch of slow network calls.
    private final ExecutorService network = Executors.newCachedThreadPool();
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final CourtHttp http = new CourtHttp(new OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS).callTimeout(8, TimeUnit.SECONDS).build());
    private final CourtExecutionGate execution = new CourtExecutionGate();
    private boolean loginPending;
    private boolean textExportPending;
    private final Map<String, CourtRequestCancellation> readRequests = new ConcurrentHashMap<>();
    private final Map<String, String> readRequestTokens = new ConcurrentHashMap<>();
    private File dispatchDirectory() { return new File(getContext().getFilesDir(), "court-dispatch-v1"); }
    private static boolean requestIdValid(String id) { return id != null && id.matches("[a-fA-F0-9-]{36}"); }
    private void markDispatched(String requestId, String token, PluginCall call) {
        if (!requestIdValid(requestId) || !requestIdValid(token)) throw new CourtExecutionGate.NotSent("请求记录标识异常，未发送预约");
        File directory = dispatchDirectory();
        AtomicFile file = new AtomicFile(new File(directory, requestId + ".json")); FileOutputStream out = null;
        try {
            if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) throw new java.io.IOException("无法创建请求记录目录");
            JSObject marker = new JSObject(); marker.put("requestId", requestId); marker.put("runId", token);
            marker.put("sentAt", System.currentTimeMillis());
            marker.put("accountId", call.getString("accountId"));
            JSObject metadata = call.getObject("requestMetadata", new JSObject());
            for (String key : new String[]{"planId", "plan", "project"}) if (metadata.has(key)) marker.put(key, metadata.get(key));
            Map<String, String> form = new java.util.HashMap<>();
            for (String pair : call.getString("body", "").split("&")) {
                String[] parts = pair.split("=", 2);
                if (parts.length == 2) form.put(java.net.URLDecoder.decode(parts[0], "UTF-8"), java.net.URLDecoder.decode(parts[1], "UTF-8"));
            }
            marker.put("date", form.get("YYRQ")); marker.put("time", form.get("KYYSJD")); marker.put("courtId", form.get("CDWID"));
            marker.put("venueCode", form.get("CGDM")); marker.put("sportCode", form.get("XMDM"));
            marker.put("campusCode", form.get("XQWID")); marker.put("modeCode", form.get("YYLX"));
            marker.put("accountIdentityId", form.get("YYRGH"));
            out = file.startWrite(); out.write(marker.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out);
        } catch (Exception error) {
            if (out != null) file.failWrite(out);
            throw new CourtExecutionGate.NotSent("发送前保存请求标记失败，未发送预约：" + error.getMessage());
        }
    }

    @PluginMethod public void login(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!execution.canLogin()) { call.reject("请先停止预约，再在前台登录"); return; }
            if (loginPending) { call.reject("登录窗口已经打开"); return; }
            loginPending = true;
            try {
                Intent intent = new Intent(getContext(), SchoolLoginActivity.class);
                intent.putExtra("fresh", call.getBoolean("fresh", false));
                startActivityForResult(call, intent, "loginResult");
            }
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
    private File archiveDirectory() { return new File(getContext().getFilesDir(), "court-run-history-v1"); }

    @PluginMethod public void archiveRuns(PluginCall call) {
        final JSArray runs = call.getArray("runs", new JSArray());
        storage.execute(() -> {
            try {
                File directory = archiveDirectory();
                if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("无法创建历史目录");
                for (int i = 0; i < runs.length(); i++) {
                    org.json.JSONObject run = runs.getJSONObject(i); String id = run.optString("id");
                    if (!requestIdValid(id) || !run.has("finishedAt")) throw new IllegalArgumentException("归档执行记录不完整");
                    java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT);
                    format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
                    long startedAt = format.parse(run.getString("startedAt")).getTime();
                    AtomicFile file = new AtomicFile(new File(directory, startedAt + "-" + id + ".json")); FileOutputStream out = null;
                    try { out = file.startWrite(); out.write(run.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
                    catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
                }
                call.resolve();
            } catch (Exception error) { call.reject("保存历史归档失败，原记录仍保留", error); }
        });
    }

    @PluginMethod public void readRunArchives(PluginCall call) {
        final String before = call.getString("before", ""); final int limit = Math.max(1, Math.min(50, call.getInt("limit", 20)));
        storage.execute(() -> {
            try {
                File[] files = archiveDirectory().listFiles((dir, name) -> name.matches("[0-9]+-[a-fA-F0-9-]{36}\\.json"));
                if (files == null) files = new File[0];
                java.util.Arrays.sort(files, (a, b) -> b.getName().compareTo(a.getName()));
                JSArray runs = new JSArray(); String cursor = ""; boolean hasMore = false;
                for (File entry : files) {
                    String key = entry.getName().replace(".json", "");
                    if (!before.isEmpty() && key.compareTo(before) >= 0) continue;
                    if (runs.length() >= limit) { hasMore = true; break; }
                    runs.put(new JSObject(new String(new AtomicFile(entry).readFully(), StandardCharsets.UTF_8))); cursor = key;
                }
                JSObject result = new JSObject(); result.put("runs", runs); result.put("cursor", cursor);
                result.put("hasMore", hasMore); result.put("count", files.length); call.resolve(result);
            } catch (Exception error) { call.reject("读取历史归档失败", error); }
        });
    }

    @PluginMethod public void readState(PluginCall call) {
        storage.execute(() -> {
            try {
                AtomicFile file = stateFile();
                JSObject result = new JSObject();
                result.put("value", CourtStateRecovery.read(file.getBaseFile(), file::readFully));
                JSObject markers = new JSObject();
                File[] pending = dispatchDirectory().listFiles((dir, name) -> name.endsWith(".json"));
                if (pending != null) for (File entry : pending) {
                    try { markers.put(entry.getName().replace(".json", ""), new JSObject(new String(new AtomicFile(entry).readFully(), StandardCharsets.UTF_8))); }
                    catch (Exception error) { throw new java.io.IOException("请求发送记录损坏，请保留原数据后核对学校订单", error); }
                }
                result.put("dispatchedRequests", markers); result.put("dispatchJournalAvailable", true);
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
                JSObject data = new JSObject(value); // Do not overwrite valid storage with malformed JSON.
                out = file.startWrite(); out.write(value.getBytes(StandardCharsets.UTF_8));
                file.finishWrite(out);
                // Cleanup failures occur after commit. Older AtomicFile.failWrite
                // deletes the committed base when its backup is already gone.
                out = null;
                java.util.Set<String> retained = new java.util.HashSet<>();
                org.json.JSONArray runs = data.optJSONArray("runs");
                if (runs != null) for (int i = 0; i < runs.length(); i++) {
                    org.json.JSONObject run = runs.optJSONObject(i); if (run == null) continue;
                    org.json.JSONObject requests = run.optJSONObject("pendingRequests");
                    if (requests != null) for (Iterator<String> it = requests.keys(); it.hasNext();) retained.add(it.next());
                    org.json.JSONObject legacy = run.optJSONObject("inFlight");
                    if (legacy != null) retained.add(legacy.optString("requestId"));
                }
                File[] markers = dispatchDirectory().listFiles((dir, name) -> name.endsWith(".json"));
                if (markers != null) for (File entry : markers) if (!retained.contains(entry.getName().replace(".json", ""))) {
                    new AtomicFile(entry).delete();
                    if (entry.exists()) throw new java.io.IOException("已保存结果，但发送标记清理失败，已停止后续预约");
                }
                call.resolve();
            } catch (Exception error) { if (out != null) file.failWrite(out); call.reject("保存本地数据失败，已停止后续预约", error); }
        });
    }

    @PluginMethod public void copy(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                String text = call.getString("text", "");
                ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                manager.setPrimaryClip(ClipData.newPlainText("深大场馆预约", text));
                ClipData saved = manager.getPrimaryClip();
                if (saved == null || saved.getItemCount() == 0 || !text.contentEquals(saved.getItemAt(0).getText())) {
                    call.reject("剪贴板未保留完整内容，请重试复制"); return;
                }
                call.resolve();
            } catch (Exception error) { call.reject("无法写入剪贴板", error); }
        });
    }

    @PluginMethod public void saveText(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!execution.canLogin() || loginPending) { call.reject("请等预约和登录结束后再保存文件"); return; }
            if (textExportPending) { call.reject("保存窗口已经打开"); return; }
            if (call.getString("text") == null) { call.reject("没有可保存的内容"); return; }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE, call.getString("fileName", "court-diagnostics.json"));
            textExportPending = true;
            try { startActivityForResult(call, intent, "textExportResult"); }
            catch (Exception error) { textExportPending = false; call.reject("无法打开文件保存窗口", error); }
        });
    }
    @ActivityCallback private void textExportResult(PluginCall call, ActivityResult result) {
        textExportPending = false;
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return;
        }
        android.net.Uri destination = data.getData();
        storage.execute(() -> {
            try {
                try (java.io.OutputStream out = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                    if (out == null) throw new java.io.IOException("文件位置不可写入");
                    out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8)); out.flush();
                }
                JSObject saved = new JSObject(); saved.put("cancelled", false); call.resolve(saved);
            } catch (Exception error) { call.reject("保存文件失败，请重新选择位置", error); }
        });
    }

    @PluginMethod public void setExecution(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            String token = call.getString("token");
            if (enabled && loginPending) { call.reject("正在登录，不能执行"); return; }
            try { if (enabled) execution.enable(token); else execution.disable(token); }
            catch (CourtExecutionGate.NotSent error) { call.reject(error.getMessage(), "REQUEST_NOT_SENT", error); return; }
            if (!enabled && token != null) for (Map.Entry<String, String> entry : readRequestTokens.entrySet()) {
                CourtRequestCancellation request = readRequests.get(entry.getKey());
                if (token.equals(entry.getValue()) && request != null) request.cancel();
            }
            if (execution.active()) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod public void request(PluginCall call) {
        final long queuedAt = System.nanoTime();
        final String token = call.getString("token");
        final String requestId = call.getString("requestId");
        HttpUrl initialUrl = HttpUrl.parse(call.getString("url", ""));
        boolean isMutation = initialUrl != null && (initialUrl.encodedPath().endsWith("insertVenueBookingInfo.do")
            || initialUrl.encodedPath().endsWith("cancelSelectBookingInfo.do"));
        final CourtRequestCancellation cancellation = isMutation || !requestIdValid(requestId) ? null : new CourtRequestCancellation();
        if (cancellation != null) { readRequests.put(requestId, cancellation); if (token != null) readRequestTokens.put(requestId, token); }
        final long timeoutMs = Math.max(1, Math.min(8000, call.getInt("timeoutMs", 8000)));
        Object deadlineValue = call.getData().opt("deadlineMs");
        final Long deadlineMs = deadlineValue instanceof Number ? ((Number) deadlineValue).longValue() : null;
        network.execute(() -> {
            final long nativeQueueMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - queuedAt);
            try {
                execution.check(token, deadlineMs, System.currentTimeMillis());
                HttpUrl url = HttpUrl.parse(call.getString("url", ""));
                if (url == null || !url.isHttps() || !url.host().equals("ehall.szu.edu.cn") || url.port() != 443
                    || !url.encodedPath().startsWith("/qljfwapp/sys/lwSzuCgyy/")) throw new IllegalArgumentException("只允许学校场馆 HTTPS 接口");
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
                CourtHttp.Result response = http.execute(builder.build(), () -> {
                    // Check every attempt. onPause invalidates the token permanently.
                    execution.check(token, deadlineMs, System.currentTimeMillis());
                }, timeoutMs, deadlineMs, cancellation, () -> markDispatched(requestId, token, call));
                JSObject result = new JSObject(); JSObject responseHeaders = new JSObject();
                for (String key : response.headers.names()) responseHeaders.put(key, new JSArray(response.headers.values(key)));
                result.put("status", response.status); result.put("headers", responseHeaders);
                JSObject timing = new JSObject(); timing.put("nativeQueueMs", nativeQueueMs);
                timing.put("dispatchPreparationMs", response.dispatchPreparationMs);
                timing.put("networkStartedAt", response.networkStartedAt); timing.put("networkEndedAt", response.networkEndedAt);
                timing.put("networkHeadersEndedAt", response.networkHeadersEndedAt);
                timing.put("networkDurationMs", response.networkDurationMs); result.put("timing", timing);
                result.put("body", response.body); call.resolve(result);
            } catch (CourtExecutionGate.NotSent error) {
                call.reject(error.getMessage(), "REQUEST_NOT_SENT", error);
            } catch (java.io.IOException error) {
                HttpUrl failedUrl = HttpUrl.parse(call.getString("url", ""));
                String path = failedUrl == null ? "" : failedUrl.encodedPath();
                boolean mutation = path.endsWith("insertVenueBookingInfo.do") || path.endsWith("cancelSelectBookingInfo.do");
                call.reject((mutation ? "提交响应未完整收到，结果待核对" : "学校接口网络请求失败，请检查网络后重试")
                    + " [" + path + "]：" + error.getClass().getSimpleName(), "NETWORK_ERROR", error);
            } catch (Exception error) { call.reject(error.getMessage() == null ? "网络请求失败" : error.getMessage(), error); }
            finally { if (cancellation != null) { readRequests.remove(requestId, cancellation); readRequestTokens.remove(requestId); } }
        });
    }

    @PluginMethod public void cancelRequest(PluginCall call) {
        CourtRequestCancellation cancellation = readRequests.get(call.getString("requestId", ""));
        if (cancellation != null) cancellation.cancel();
        call.resolve();
    }

    @Override protected void handleOnPause() {
        execution.pause();
        for (CourtRequestCancellation request : readRequests.values()) request.cancel();
        getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        JSObject state = new JSObject(); state.put("active", false); notifyListeners("foreground", state, true);
    }
    @Override protected void handleOnResume() {
        execution.resume();
        JSObject state = new JSObject(); state.put("active", true); notifyListeners("foreground", state, true);
    }
    @Override protected void handleOnDestroy() {
        execution.pause(); for (CourtRequestCancellation request : readRequests.values()) request.cancel();
        network.shutdown(); storage.shutdown();
    }
}
