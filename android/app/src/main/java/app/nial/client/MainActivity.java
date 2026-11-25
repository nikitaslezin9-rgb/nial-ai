package app.nial.client;

import android.Manifest;
import android.app.*;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.security.keystore.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

public class MainActivity extends Activity {
 private WebView web;
 private String base = "", password = "";
 private SharedPreferences prefs;
 private PermissionRequest pending;
 private boolean attempted;
 private TextView status;
 private static final String KEY = "nial-login-v1";

 @Override public void onCreate(Bundle state) {
  super.onCreate(state);
  prefs = getSharedPreferences("nial", MODE_PRIVATE);
  LinearLayout root = new LinearLayout(this); root.setOrientation(1);
  root.setPadding(0, getStatusBarHeight(), 0, 0);
  LinearLayout bar = new LinearLayout(this);
  Button home = new Button(this); home.setText("Чат");
  Button voice = new Button(this); voice.setText("Голос");
  Button settings = new Button(this); settings.setText("Настройки");
  bar.addView(home); bar.addView(voice); bar.addView(settings); root.addView(bar);
  status = new TextView(this); status.setPadding(16,8,16,8); root.addView(status);
  web = new WebView(this); root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
  setContentView(root);
  WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
  s.setAllowFileAccess(false); s.setAllowContentAccess(false);
  s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
  CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
  web.setWebViewClient(new WebViewClient() {
   @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return !trusted(r.getUrl()); }
   @Override public void onPageStarted(WebView v,String u,Bitmap icon) { attempted=false; status.setText("Загрузка…"); }
   @Override public void onPageFinished(WebView v,String u) { if(status.getText().toString().equals("Загрузка…")) status.setText(""); }
   @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e) {
    if(r.isForMainFrame()) status.setText("Сервер недоступен: "+e.getDescription()+". Проверь адрес и сеть. APK не обходит блокировку хостинга.");
   }
   @Override public void onReceivedHttpAuthRequest(WebView v,HttpAuthHandler h,String host,String realm) {
    Uri u=Uri.parse(base);
    if(!host.equalsIgnoreCase(u.getHost()) || !trusted(Uri.parse(v.getUrl()==null?"":v.getUrl())) || password.isEmpty() || attempted) {
     h.cancel(); status.setText("Вход не выполнен. Проверь пароль в настройках."); return;
    }
    attempted=true; h.proceed("nial",password);
   }
  });
  web.setWebChromeClient(new WebChromeClient() {
   @Override public void onPermissionRequest(PermissionRequest r) { runOnUiThread(()->{
    if(!trusted(r.getOrigin()) || !trusted(Uri.parse(web.getUrl()==null?"":web.getUrl()))) { r.deny(); return; }
    boolean audio=false; for(String x:r.getResources()) if(x.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) audio=true;
    if(!audio) { r.deny(); return; }
    if(checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED) r.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
    else { if(pending!=null) pending.deny(); pending=r; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO},7); }
   }); }
   @Override public void onPermissionRequestCanceled(PermissionRequest r) { if(pending==r) pending=null; }
  });
  home.setOnClickListener(v->open("/")); voice.setOnClickListener(v->open("/voice")); settings.setOnClickListener(v->configure());
  base=prefs.getString("base","");
  try { password=decrypt(prefs.getString("secret","")); } catch(Exception e) { password=""; }
  if(base.isEmpty()) configure(); else open("/");
 }
 private int getStatusBarHeight() { int id=getResources().getIdentifier("status_bar_height","dimen","android"); return id>0?getResources().getDimensionPixelSize(id):0; }
 private boolean trusted(Uri u) { Uri b=Uri.parse(base); return !base.isEmpty() && "https".equals(u.getScheme()) && b.getHost()!=null && b.getHost().equalsIgnoreCase(u.getHost()) && u.getPort()==b.getPort(); }
 private String normalize(String text) {
  Uri u=Uri.parse(text.trim());
  if(!"https".equals(u.getScheme()) || u.getHost()==null || u.getUserInfo()!=null || u.getQuery()!=null || u.getFragment()!=null || !(u.getPath()==null || u.getPath().isEmpty() || u.getPath().equals("/"))) throw new IllegalArgumentException();
  return "https://"+u.getEncodedAuthority();
 }
 private void open(String path) { if(base.isEmpty()) { configure(); return; } attempted=false; web.loadUrl(base+path); }
 private void configure() {
  LinearLayout box=new LinearLayout(this); box.setOrientation(1); box.setPadding(32,16,32,16);
  TextView info=new TextView(this); info.setText("Один раз укажи доверенный HTTPS-сервер Nial и пароль доступа. Ключи GigaChat и SpeechKit сюда не вводи. Смена хостинга автоматически не выполняется."); box.addView(info);
  EditText address=new EditText(this); address.setSingleLine(true); address.setHint("https://адрес-сервера"); address.setInputType(17); address.setText(base); box.addView(address);
  EditText secret=new EditText(this); secret.setSingleLine(true); secret.setHint("Пароль доступа Nial (логин nial)"); secret.setInputType(129); secret.setText(password); box.addView(secret);
  AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Подключение Nial").setView(box).setNegativeButton("Отмена",null).setPositiveButton("Сохранить",null).create();
  dialog.setOnShowListener(d->dialog.getButton(-1).setOnClickListener(v->{
   try {
    String next=normalize(address.getText().toString()); String pass=secret.getText().toString();
    if(!next.equals(base)) { CookieManager.getInstance().removeAllCookies(null); web.clearCache(true); WebStorage.getInstance().deleteAllData(); }
    String encrypted=encrypt(pass);
    if(!prefs.edit().putString("base",next).putString("secret",encrypted).commit()) throw new IllegalStateException();
    base=next; password=pass; web.clearHistory(); web.clearFormData(); dialog.dismiss(); open("/");
   } catch(Exception e) { Toast.makeText(this,"Не удалось сохранить. Нужен HTTPS-адрес без пути и параметров.",Toast.LENGTH_LONG).show(); }
  })); dialog.show();
 }
 private javax.crypto.SecretKey key() throws Exception {
  KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
  if(!ks.containsAlias(KEY)) { KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore"); g.init(new KeyGenParameterSpec.Builder(KEY,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); g.generateKey(); }
  return (javax.crypto.SecretKey)ks.getKey(KEY,null);
 }
 private String encrypt(String text) throws Exception { Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key()); return Base64.encodeToString(c.getIV(),2)+":"+Base64.encodeToString(c.doFinal(text.getBytes(StandardCharsets.UTF_8)),2); }
 private String decrypt(String text) throws Exception { if(text.isEmpty()) return ""; String[] p=text.split(":",2); Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],2))); return new String(c.doFinal(Base64.decode(p[1],2)),StandardCharsets.UTF_8); }
 @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results) { super.onRequestPermissionsResult(code,permissions,results); if(code==7 && pending!=null) { PermissionRequest r=pending; pending=null; if(results.length>0 && results[0]==PackageManager.PERMISSION_GRANTED && trusted(r.getOrigin()) && trusted(Uri.parse(web.getUrl()==null?"":web.getUrl()))) r.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else r.deny(); } }
 @Override protected void onPause() { web.onPause(); super.onPause(); }
 @Override protected void onResume() { super.onResume(); if(web!=null) web.onResume(); }
 @Override protected void onDestroy() { if(pending!=null) pending.deny(); web.destroy(); super.onDestroy(); }
 @Override public void onBackPressed() { if(web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}
