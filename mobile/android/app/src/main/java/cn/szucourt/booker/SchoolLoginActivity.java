package cn.szucourt.booker;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/** A separate, bridge-free WebView. The school page never gets access to the
 * Capacitor bridge, saved accounts, file system, or booking executor. */
public class SchoolLoginActivity extends AppCompatActivity {
    private static final String APP_URL = "https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/index.do#/sportVenue";
    private static final String COOKIE_URL = "https://ehall.szu.edu.cn/qljfwapp/sys/lwSzuCgyy/modules/sportVenue/getOpeningRoom.do";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView browser;
    private TextView status;
    private Button retry;
    private boolean completed;
    private boolean resumed;
    private boolean clearing;
    private boolean pageLoaded;
    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (completed || !resumed) return;
            capture();
            if (!completed && resumed) handler.postDelayed(this, 500);
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(Activity.RESULT_CANCELED);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        LinearLayout toolbar = new LinearLayout(this);
        Button close = new Button(this); close.setText("取消"); close.setOnClickListener(v -> finish());
        retry = new Button(this); retry.setText("换号"); retry.setOnClickListener(v -> startFresh());
        Button refresh = new Button(this); refresh.setText("刷新"); refresh.setOnClickListener(v -> {
            if (!clearing && !completed) { pageLoaded = false; browser.loadUrl(APP_URL); }
        });
        toolbar.addView(close, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        toolbar.addView(retry, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        toolbar.addView(refresh, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(toolbar);
        status = new TextView(this); status.setTextSize(13); status.setTextColor(Color.rgb(25, 44, 36));
        int padding = (int) (12 * getResources().getDisplayMetrics().density);
        status.setPadding(padding, padding / 2, padding, padding / 2);
        root.addView(status);
        browser = new WebView(this);
        root.addView(browser, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSaveFormData(false); settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, true);
        browser.setWebChromeClient(new WebChromeClient());
        browser.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) { pageLoaded = false; }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !allowNavigation(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !allowNavigation(Uri.parse(url));
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (completed || clearing) return;
                Uri uri = Uri.parse(url);
                pageLoaded = trusted(uri);
                if (trusted(uri)) status.setText("学校页面：" + uri.getHost() + "\n获取登录后自动返回。");
                capture();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { pageLoaded = false; status.setText("页面加载失败，请检查网络后点击“刷新”，或返回使用登录 JSON 导入。"); }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
                pageLoaded = false; sslHandler.cancel(); status.setText("学校页面证书校验失败，已停止加载。请检查手机时间和网络。");
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                finish();
            }
        });
        status.setText("正在打开学校页面，获取登录后自动返回；如需切换账号，请点击“换号”。");
        if (getIntent().getBooleanExtra("fresh", false)) startFresh(); else browser.loadUrl(APP_URL);
    }

    private static boolean trusted(Uri uri) {
        String host = uri.getHost();
        return "https".equals(uri.getScheme()) && (uri.getPort() == -1 || uri.getPort() == 443)
            && host != null && (host.equals("szu.edu.cn") || host.endsWith(".szu.edu.cn"));
    }
    private boolean allowNavigation(Uri uri) {
        if (trusted(uri)) return true;
        status.setText("此登录步骤需要跳转到学校域名以外的页面，当前未打开。请使用学校账号密码登录，或返回导入 Cookie。");
        return false;
    }
    private void startFresh() {
        if (clearing || completed) return;
        clearing = true; pageLoaded = false; retry.setEnabled(false); browser.stopLoading();
        browser.loadUrl("about:blank"); browser.clearHistory(); browser.clearCache(true); browser.clearFormData();
        status.setText("正在清理登录窗口的旧会话；已保存的预约账号不会被删除。");
        // This only clears the app WebView cookie jar. Account credentials live
        // independently in the native state file and OkHttp has NO_COOKIES.
        CookieManager.getInstance().removeAllCookies(removed -> {
            if (isFinishing() || isDestroyed()) return;
            clearing = false; retry.setEnabled(true);
            status.setText("请登录本次要保存的学校账号，密码仅在学校页面填写。");
            browser.loadUrl(APP_URL);
        });
    }
    private void capture() {
        if (completed || clearing || !resumed || browser == null) return;
        if (!pageLoaded) return;
        String current = browser.getUrl();
        Uri uri = Uri.parse(current == null ? "" : current);
        if (!trusted(uri) || !"ehall.szu.edu.cn".equals(uri.getHost()) || uri.getPath() == null
            || !uri.getPath().startsWith("/qljfwapp/sys/lwSzuCgyy/")) {
            return;
        }
        String cookie = CookieManager.getInstance().getCookie(COOKIE_URL);
        boolean cas = false, weu = false;
        if (cookie != null) for (String pair : cookie.split(";")) {
            String[] parts = pair.trim().split("=", 2);
            if (parts.length != 2 || parts[1].isEmpty()) continue;
            if (parts[0].equals("MOD_AUTH_CAS")) cas = true;
            if (parts[0].equals("_WEU")) weu = true;
        }
        if (!cas || !weu) return;
        if (cookie.length() > 64000) { status.setText("登录信息异常过长，请换号重试。"); return; }
        CookieManager.getInstance().flush();
        completed = true; handler.removeCallbacks(poll);
        Intent data = new Intent(); data.putExtra("cookie", cookie);
        data.putExtra("userAgent", browser.getSettings().getUserAgentString());
        setResult(Activity.RESULT_OK, data); finish();
    }
    @Override protected void onResume() { super.onResume(); resumed = true; handler.post(poll); }
    @Override protected void onPause() { resumed = false; handler.removeCallbacks(poll); super.onPause(); }
    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (browser != null) { browser.stopLoading(); ((ViewGroup) browser.getParent()).removeView(browser); browser.destroy(); browser = null; }
        super.onDestroy();
    }
}
