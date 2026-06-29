package com.aimusic.studio;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
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

        web.setWebViewClient(new WebViewClient()); // 링크를 앱 내부에서 열기
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

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
