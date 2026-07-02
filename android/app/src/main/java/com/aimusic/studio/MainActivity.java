package com.aimusic.studio;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * AI Music Studio — 웹앱을 감싸는 WebView 래퍼.
 * 접속 주소는 res/values/strings.xml 의 app_url 로 바꿀 수 있다.
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // 오디오 자동재생 허용
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);

        web.setWebViewClient(new WebViewClient() {
            // 외부 링크(Suno·유튜브 등)는 기본 브라우저(크롬)로 연다.
            // 구글이 WebView 안에서의 구글 로그인을 차단(403 disallowed_useragent)하기 때문.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                try {
                    Uri url = request.getUrl();
                    // intent:// 스킴(예: Suno 앱 열기) → 해당 앱 실행, 없으면 fallback URL로
                    if ("intent".equals(url.getScheme())) {
                        try {
                            Intent it = Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME);
                            startActivity(it);
                        } catch (Exception notFound) {
                            String fb = null;
                            try {
                                Intent it = Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME);
                                fb = it.getStringExtra("browser_fallback_url");
                            } catch (Exception ignored) { }
                            startActivity(new Intent(Intent.ACTION_VIEW,
                                    Uri.parse(fb != null ? fb : "https://suno.com")));
                        }
                        return true;
                    }
                    String appHost = Uri.parse(getString(R.string.app_url)).getHost();
                    if (url.getHost() != null && url.getHost().equalsIgnoreCase(appHost)) {
                        return false; // 우리 앱 도메인은 웹뷰 안에서 그대로
                    }
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }

            // 메인 페이지 로드 실패 시 흰 화면 대신 원인/재시도 안내를 보여준다.
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient());

        // http(s) 다운로드(MP4 등)는 안드로이드 다운로드 매니저로 저장
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                try {
                    if (!url.startsWith("http")) return; // blob: 등은 무시
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
                    req.setMimeType(mimetype);
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    dm.enqueue(req);
                    Toast.makeText(MainActivity.this, "다운로드 시작: " + name, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "다운로드 실패", Toast.LENGTH_SHORT).show();
                }
            }
        });

        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        setContentView(web);
        web.loadUrl(getString(R.string.app_url));
    }

    private void showError() {
        String url = getString(R.string.app_url);
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "</head><body style=\"font-family:sans-serif;background:#111;color:#eee;padding:28px;line-height:1.6\">"
                + "<h2>연결할 수 없어요</h2>"
                + "<p>주소: <b>" + url + "</b></p>"
                + "<p>휴대폰의 <b>Tailscale</b>가 켜져 있는지, NAS의 컨테이너가 실행 중인지 확인하세요.</p>"
                + "<p style=\"margin-top:20px\"><a href=\"" + url + "\" "
                + "style=\"background:#0066cc;color:#fff;text-decoration:none;padding:12px 20px;border-radius:9999px\">다시 시도</a></p>"
                + "</body></html>";
        web.loadDataWithBaseURL(url, html, "text/html", "utf-8", null);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
