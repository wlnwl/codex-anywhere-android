package local.codex.anywhere;
import android.app.*;import android.os.*;import android.content.*;import android.webkit.*;import android.widget.*;import android.view.*;import org.json.*;import java.util.*;import java.io.*;
public class MainActivity extends Activity {

 final Handler syncHandler=new Handler(android.os.Looper.getMainLooper());
 final SendLedger sends=new SendLedger();
 final Map<String,Integer> requestGenerations=new HashMap<>();
 final Map<String,String> requestDevices=new HashMap<>();
 List<ConversationHistory.Message> historyMessages=new ArrayList<>();
 ScrollView historyScroll;Button sendButton;
 String historyRequestId="",historySignature="",conversationTitle="",streamText="",streamTurnId="";
 boolean foreground=true,historyLoaded=false,historyDirty=false,selectingDevice=false,forceHistoryBottom=false;
 boolean relayAuthenticated=false;
 Dialog deviceSheet;
 AccountUi accounts;
 private static final long HISTORY_SYNC_INTERVAL_MS=1_000;
 private static final long HISTORY_RETRY_INTERVAL_MS=15_000;
 long historyReadStartedAt=0,historyPollAt=0;
 final Runnable historyPoll=()->{historyPollAt=0;readHistory(false);};
 JSONObject permissionConfig;Map<String,String> requestThreads=new HashMap<>();JSONArray sessionCatalog=new JSONArray();Dialog sessionDrawer;LinearLayout sessionRows;Button deviceButton;String scannedPair="";DialogUi popupUi;DialogUi.Sheet connectionDialog;String selectedDeviceId="", connectionServerDraft="", connectionPairDraft="";String pendingPairCredential=null;boolean connectionBusy=false, engineLoaded=false, connectAfterLoad=true;Runnable completeConnection;int connectionAttempt=0;WebView engine; LinearLayout root,body;TextView status;EditText draft;String server,thread="";boolean ready=false;int generation=0;long lastRefresh=0;Map<String,String> pending=new HashMap<>();android.content.SharedPreferences prefs;
 private AppPalette palette;
 private TextView appTitle;
 private Button connectionButton;
 private LinearLayout mainTools;

 @Override public void onCreate(Bundle b) {
   super.onCreate(b);
   palette = AppPalette.read(this);
   popupUi = new DialogUi(this, palette);
   accounts = new AccountUi(this, popupUi, (action, payload) -> {
     if (!ready) throw new IllegalStateException("computer_not_connected");
     call(action, payload);
   });
   prefs = getPreferences(0);
   selectedDeviceId = prefs.getString("selectedDevice", "");
   thread = prefs.getString("thread:" + selectedDeviceId, "");
   conversationTitle = prefs.getString("title:" + selectedDeviceId, "");
   server=prefs.getString("server","");

   root = new LinearLayout(this);
   root.setOrientation(LinearLayout.VERTICAL);
   root.setPadding(dp(18), dp(12), dp(18), dp(12));
   setContentView(root);

   LinearLayout bar = new LinearLayout(this);
   bar.setGravity(Gravity.CENTER_VERTICAL);
   appTitle = text("Codex", 19);
   appTitle.setTextIsSelectable(false);
   appTitle.setPadding(dp(6), dp(12), dp(8), dp(12));
   bar.addView(appTitle, new LinearLayout.LayoutParams(-2, dp(64)));
   deviceButton = button(selectedDeviceId.isEmpty() ? "选择设备 ▾"
       : prefs.getString("deviceName:" + selectedDeviceId, "选择设备") + " ▾", this::devices);
   deviceButton.setSingleLine();
   deviceButton.setEllipsize(android.text.TextUtils.TruncateAt.END);
   deviceButton.setMinWidth(0);
   LinearLayout.LayoutParams deviceLayout = (LinearLayout.LayoutParams) deviceButton.getLayoutParams();
   deviceLayout.width = 0;
   deviceLayout.weight = 1f;
   bar.addView(deviceButton);
   connectionButton = button("连接", this::connection);
   bar.addView(connectionButton);
   ThemeSwitch themeSwitch = new ThemeSwitch(this, palette.day, day -> {
     AppPalette choice = day ? AppPalette.DAY : AppPalette.NIGHT;
     choice.save(this);
     applyPalette(choice);
   });
   bar.addView(themeSwitch, new LinearLayout.LayoutParams(dp(76), dp(48)));
   root.addView(bar);

   status = text("请连接服务器并选择电脑", 13);
   root.addView(status);
   mainTools = new LinearLayout(this);
   addTool(mainTools, "☰ 会话", this::openSessions);
   addTool(mainTools, "权限", this::readPermissions);
   addTool(mainTools, "账号", () -> {
     if (ready) accounts.open();
     else notice("请先连接电脑");
   });
   addTool(mainTools, "刷新", this::refresh);
   addTool(mainTools, "停止", () -> {
     if (!thread.isEmpty()) {
       try { call("turn.stop", new JSONObject().put("threadId", thread)); }
       catch (JSONException ignored) {}
     }
   });
   mainTools.setPadding(0, dp(12), 0, dp(12));
   root.addView(mainTools);

   historyScroll = new ScrollView(this);
   body = new LinearLayout(this);
   body.setOrientation(LinearLayout.VERTICAL);
   historyScroll.addView(body);
   body.setContentDescription("会话消息区域");
   root.addView(historyScroll, new LinearLayout.LayoutParams(-1, 0, 1));

   draft = new EditText(this);
   draft.setHint("写下你的想法…");
   draft.setMinLines(2);
   draft.setTextSize(15);
   draft.setPadding(dp(16), dp(12), dp(16), dp(12));
   root.addView(draft);
   sendButton = button("发送指令  ↗", this::submit);
   root.addView(sendButton, new LinearLayout.LayoutParams(-1, dp(56)));
   body.addView(text("随时继续你的工作", 25));
   body.addView(text("连接电脑，查看会话与跟进任务", 14));
   applyPalette(palette);

 engine=new WebView(this);engine.getSettings().setJavaScriptEnabled(true);engine.getSettings().setAllowFileAccess(false);engine.getSettings().setAllowContentAccess(false);engine.addJavascriptInterface(new Bridge(),"Native");engine.setWebViewClient(new WebViewClient(){public WebResourceResponse shouldInterceptRequest(WebView w,WebResourceRequest r){String path=r.getUrl().getPath();if(path==null||!path.startsWith("/__native/"))return new WebResourceResponse("text/plain","UTF-8",403,"Forbidden",null,new ByteArrayInputStream(new byte[0]));try{return new WebResourceResponse(path.endsWith(".js")?"application/javascript":"text/html","UTF-8",getAssets().open(path.endsWith(".js")?"protocol.js":"engine.html"));}catch(Exception e){return null;}}public boolean shouldOverrideUrlLoading(WebView w,WebResourceRequest r){return true;}public void onPageFinished(WebView w,String u){engineLoaded=true;js("setForeground("+foreground+")");if(!connectAfterLoad)return;connectAfterLoad=false;if(server.isEmpty())return;String pair=pendingPairCredential;pendingPairCredential=null;if(pair==null)pair=getIntent().getStringExtra("pairing");getIntent().removeExtra("pairing");js("connect("+JSONObject.quote(server)+","+JSONObject.quote(pair==null?"":pair)+")");}});engine.loadUrl((server.isEmpty()?"https://appassets.androidplatform.net":server.replaceAll("/+$",""))+"/__native/engine.html");}
 int dp(int value) {
   return Math.round(value * getResources().getDisplayMetrics().density);
 }

 private android.graphics.drawable.GradientDrawable surface(int color, int radius) {
   android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
   shape.setColor(color);
   shape.setCornerRadius(dp(radius));
   shape.setStroke(dp(1), palette.softBorder);
   return shape;
 }

 private TextView text(String value, int size) {
   TextView view = new TextView(this);
   view.setText(value);
   view.setTextSize(size);
   view.setPadding(dp(12), dp(12), dp(12), dp(12));
   view.setLineSpacing(dp(4), 1f);
   view.setTextIsSelectable(true);
   colorHistory(view);
   return view;
 }

 private Button button(String label, Runnable action) {
   Button view = new Button(this);
   view.setText(label);
   view.setTextSize(13);
   view.setAllCaps(false);
   view.setMinHeight(dp(48));
   view.setMinimumWidth(0);
   view.setPadding(dp(12), dp(10), dp(12), dp(10));
   view.setStateListAnimator(null);
   LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(-2, -2);
   layout.setMargins(dp(3), dp(5), dp(3), dp(5));
   view.setLayoutParams(layout);
   view.setOnClickListener(ignored -> action.run());
   styleButton(view);
   return view;
 }

 private void styleButton(Button view) {
   view.setTextColor(palette.text);
   view.setBackground(surface(palette.buttonSurface, 14));
 }

 private void applyPalette(AppPalette choice) {
   palette = choice;
   popupUi.setPalette(choice);
   root.setBackground(new android.graphics.drawable.GradientDrawable(
       android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
       new int[]{choice.canvasStart, choice.canvasEnd}));
   choice.applySystemBars(getWindow());
   colorHistory(appTitle);
   status.setTextColor(choice.muted);
   status.setBackground(surface(choice.statusSurface, 14));
   styleButton(deviceButton);
   styleButton(connectionButton);
   for (int i = 0; i < mainTools.getChildCount(); i++) {
     styleButton((Button) mainTools.getChildAt(i));
   }
   draft.setTextColor(choice.text);
   draft.setHintTextColor(choice.hint);
   draft.setHighlightColor(choice.highlight);
   draft.setBackground(surface(choice.inputSurface, 18));
   if (Build.VERSION.SDK_INT >= 29) {
     android.graphics.drawable.GradientDrawable cursor = new android.graphics.drawable.GradientDrawable();
     cursor.setColor(choice.accent);
     cursor.setSize(dp(2), dp(24));
     draft.setTextCursorDrawable(cursor);
   }
   sendButton.setBackground(surface(choice.accent, 16));
   sendButton.setTextColor(choice.onAccent);
   colorHistory(body);
 }

 private enum HistoryTone { USER_CARD, ASSISTANT_CARD, MUTED, ACCENT, ERROR }

 private void colorHistory(View view) {
   Object tone = view.getTag();
   if (view instanceof TextView) {
     TextView label = (TextView) view;
     int color = tone == HistoryTone.MUTED ? palette.muted
         : tone == HistoryTone.ACCENT ? palette.accent
         : tone == HistoryTone.ERROR ? palette.error : palette.text;
     label.setTextColor(color);
     label.setHighlightColor(palette.highlight);
   }
   if (tone == HistoryTone.USER_CARD || tone == HistoryTone.ASSISTANT_CARD) {
     view.setBackground(surface(tone == HistoryTone.USER_CARD
         ? palette.selectedSurface : palette.cardSurface, 16));
   }
   if (view instanceof ViewGroup) {
     ViewGroup container = (ViewGroup) view;
     for (int i = 0; i < container.getChildCount(); i++) colorHistory(container.getChildAt(i));
   }
 }

 void js(String code){engine.evaluateJavascript(code,null);}
 void notice(String s){if(!s.contentEquals(status.getText()))status.setText(s);}
 JSONArray inventory=new JSONArray();

 class Bridge {@JavascriptInterface public String identity(){return prefs.getString("identity","");}@JavascriptInterface public void saveIdentity(String s){prefs.edit().putString("identity",s).apply();}@JavascriptInterface public void emit(String s){runOnUiThread(()->event(s));}}

 void event(String raw) {
   try {
     JSONObject e=new JSONObject(raw);String type=e.optString("type");
     if(type.equals("status")){notice(e.optString("message"));return;}
     if(type.equals("authenticated")) {
       relayAuthenticated=true;
       android.util.Log.i("CodexSync","relay authenticated");
       if(connectionBusy&&completeConnection!=null)completeConnection.run();
       if(!ready&&!selectingDevice)notice("认证成功，请选择电脑");return;
     }
     if(type.equals("devices")) {
       inventory=e.optJSONArray("devices");
       relayAuthenticated=e.optBoolean("relayAuthenticated",relayAuthenticated);
       if(!relayAuthenticated){dismissDeviceSheet();return;}
       if(!ready&&!selectingDevice&&e.optString("selectedDeviceId").isEmpty())restoreDevice();
       return;
     }
     if(type.equals("ready")) {
       if(!relayAuthenticated||!selectedDeviceId.equals(e.optString("deviceId")))return;
       ready=true;selectingDevice=false;historyRequestId="";
       notice("已连接，正在同步会话…");call("sessions.list",new JSONObject());
       if(!thread.isEmpty())readHistory(!historyLoaded);return;
     }
     if(type.equals("disconnected")||type.equals("error")) {
       if("relay".equals(e.optString("scope"))) {
         invalidateRelay();
         android.util.Log.i("CodexSync","relay unavailable code="+e.optInt("code")+" retrying="+e.optBoolean("retrying"));
       } else invalidateDeviceConnection();
       renderConversation(false);String message=connectionError(e);notice(message);
       if(connectionBusy&&!e.optBoolean("retrying")&&connectionDialog!=null&&connectionDialog.dialog.isShowing())finishConnectionError(message);
       return;
     }
     if(type.equals("requestFailed")) {
       failRequest(e.optString("requestId"),e.optString("message","请求未发出"),false);return;
     }
     if(!type.equals("frame"))return;
     JSONObject frame=e.getJSONObject("frame");String frameType=frame.optString("type");
     String id=frame.optString("requestId");
     if(frameType.equals("ack")){if("turn.start".equals(pending.get(id))){sends.acknowledge(id);if(thread.equals(requestThreads.get(id))&&selectedDeviceId.equals(requestDevices.get(id)))renderConversation(false);}return;}
     if(frameType.equals("event")){handleLiveEvent(frame);return;}
     if(!frameType.equals("response"))return;
     String action=pending.remove(id),target=requestThreads.remove(id),device=requestDevices.remove(id);
     Integer requestGeneration=requestGenerations.remove(id);
     if(action==null)return;
     android.util.Log.i("CodexSync","response "+action+" ok="+frame.optBoolean("ok"));
     if(action.startsWith("account.")) {
       if(selectedDeviceId.equals(device)) {
         accounts.handleResponse(action,frame.optBoolean("ok"),frame.optJSONObject("data"),frame.optString("error"));
         if(action.equals("account.sessions.switch")&&frame.optBoolean("ok")) {
           call("sessions.list",new JSONObject());
           if(!thread.isEmpty())scheduleHistory(0);
         }
       }
       return;
     }
     if(action.equals("turn.start")) {
       if(frame.optBoolean("ok"))sends.succeed(id);else {String error=frame.optString("error","电脑未接受指令");if(error.contains("timeout")||error.contains("uncertain")||error.contains("unconfirmed"))sends.uncertain(id,error);else sends.fail(id,error);}
       if(selectedDeviceId.equals(device)&&thread.equals(target)) {
         renderConversation(false);
         notice(frame.optBoolean("ok")?"指令已送达，正在同步回复…":"发送失败："+frame.optString("error"));
         scheduleHistory(150);
       }
       return;
     }
     boolean historyRead=action.equals("session.read");
     if(historyRead&&id.equals(historyRequestId))historyRequestId="";
     if(!selectedDeviceId.equals(device)||requestGeneration==null||requestGeneration!=generation)return;
     if((historyRead||action.startsWith("session.permissions."))&&!thread.equals(target))return;
     if(!frame.optBoolean("ok")) {
       String error=frame.optString("error","请求失败");
       if(historyRead){if(!historyLoaded)showHistoryPlaceholder("会话暂未加载",friendlyError(error));scheduleHistory(HISTORY_RETRY_INTERVAL_MS);}
       notice(friendlyError(error));return;
     }
     Object data=frame.has("data")?frame.opt("data"):frame.opt("result");
     if(action.equals("session.read")) {
       if(!(data instanceof JSONObject)){if(!historyLoaded)showHistoryPlaceholder("会话暂未加载","服务器返回的记录格式不完整，请重试。");scheduleHistory(HISTORY_RETRY_INTERVAL_MS);return;}
       JSONObject document=(JSONObject)data;
       if(document.has("id")&&!thread.equals(document.optString("id"))){notice("会话返回不匹配，已忽略旧记录");scheduleHistory(HISTORY_RETRY_INTERVAL_MS);return;}
       List<ConversationHistory.Message> rows=ConversationHistory.parse(document);
       String signature=historyFingerprint(rows);
       boolean changed=!signature.equals(historySignature);
       historyMessages=rows;historySignature=signature;historyLoaded=true;
       conversationTitle=document.optString("title",conversationTitle);
       reconcileOutgoing();
       if(!streamText.isEmpty())for(ConversationHistory.Message row:rows)
         if("assistant".equals(row.kind)&&row.text.contains(streamText)){streamText="";streamTurnId="";break;}
       if(changed||forceHistoryBottom){renderConversation(forceHistoryBottom);forceHistoryBottom=false;}
       android.util.Log.i("CodexSync","history rows="+rows.size()+" changed="+changed);
       if(streamText.isEmpty())notice(rows.isEmpty()?"会话暂无文字记录":"已同步 "+rows.size()+" 条消息 · 自动更新中");
       boolean trailing=historyDirty;historyDirty=false;
       if(trailing)scheduleHistory(200);else scheduleNextHistory();
     } else if(action.equals("sessions.list")&&data instanceof JSONObject) {
       showSessions(((JSONObject)data).optJSONArray("sessions"));
     } else if(action.equals("session.permissions.read")&&data instanceof JSONObject) {
       permissionConfig=(JSONObject)data;showPermissions();
     } else if(action.equals("session.permissions.update")&&data instanceof JSONObject) {
       permissionConfig=(JSONObject)data;notice("权限已保存："+permissionName(permissionConfig.optString("mode")));
     }
   } catch(Exception error) {
     historyRequestId="";notice("会话同步失败，请点击刷新重试。");
     android.util.Log.w("CodexSync","Could not apply frame: "+error.getClass().getSimpleName());
     scheduleHistory(HISTORY_RETRY_INTERVAL_MS);
   }
 }

 String call(String action,JSONObject payload) {
   if(!ready){notice("请先连接并选择电脑");return null;}
   String id=UUID.randomUUID().toString();pending.put(id,action);requestThreads.put(id,thread);
   requestDevices.put(id,selectedDeviceId);requestGenerations.put(id,generation);
   android.util.Log.i("CodexSync","request "+action);
   js("request("+JSONObject.quote(id)+","+JSONObject.quote(action)+","+payload.toString()+")");
   syncHandler.postDelayed(()->{
     if(pending.containsKey(id))failRequest(id,"请求尚未确认，请查看同步状态；不会自动重复发送。",true);
   },action.equals("session.read")?25000:60000);
   return id;
 }

 void addTool(LinearLayout row,String label,Runnable action){Button b=button(label,action);b.setMinWidth(0);b.setPadding(dp(3),dp(8),dp(3),dp(8));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,dp(50),1);lp.setMargins(dp(3),dp(5),dp(3),dp(5));row.addView(b,lp);}

 void failRequest(String id,String message,boolean uncertain) {
   String action=pending.remove(id),target=requestThreads.remove(id),device=requestDevices.remove(id);
   requestGenerations.remove(id);if(action==null)return;
   if(action.startsWith("account.")) {
     if(selectedDeviceId.equals(device))accounts.handleResponse(action,false,null,"账号操作未确认，请刷新账号状态。");
     return;
   }
   if(action.equals("turn.start")) {
     if(uncertain)sends.uncertain(id,message);else sends.fail(id,message);
     if(thread.equals(target)&&selectedDeviceId.equals(device)){renderConversation(false);notice(message);}
   } else if(id.equals(historyRequestId)) {
     historyRequestId="";
     if(thread.equals(target)&&selectedDeviceId.equals(device)) {
       if(!historyLoaded)showHistoryPlaceholder("记录加载失败",message);
       notice(message);scheduleHistory(HISTORY_RETRY_INTERVAL_MS);
     }
   } else if(selectedDeviceId.equals(device)&&thread.equals(target))notice(message);
 }

 void restoreDevice() {
   if(selectedDeviceId.isEmpty()||inventory==null){if(!ready)notice("认证成功，请选择电脑");return;}
   for(int i=0;i<inventory.length();i++) {
     JSONObject item=inventory.optJSONObject(i);
     String id=item==null?inventory.optString(i):item.optString("id");
     if(id.equals(selectedDeviceId)&&(item==null||item.optBoolean("online",true))) {
       selectingDevice=true;notice("正在恢复电脑连接…");js("selectDevice("+JSONObject.quote(id)+")");return;
     }
   }
   notice("所选电脑暂时离线，已有记录已保留");
 }

 void invalidateDeviceConnection() {
   ready=false;selectingDevice=false;generation++;
   if(accounts!=null)accounts.close();
   cancelHistoryPoll();historyRequestId="";historyDirty=false;
   sends.disconnect(selectedDeviceId);pending.clear();requestThreads.clear();requestDevices.clear();requestGenerations.clear();
 }

 void invalidateRelay() {
   relayAuthenticated=false;inventory=new JSONArray();dismissDeviceSheet();invalidateDeviceConnection();
 }

 void dismissDeviceSheet() {
   if(deviceSheet!=null){Dialog previous=deviceSheet;deviceSheet=null;previous.dismiss();}
 }

 boolean deviceIsOnline(String id) {
   if(!relayAuthenticated||inventory==null)return false;
   for(int i=0;i<inventory.length();i++) {
     JSONObject item=inventory.optJSONObject(i);
     if(item==null){if(id.equals(inventory.optString(i)))return true;}
     else if(id.equals(item.optString("id")))return item.optBoolean("online",true);
   }
   return false;
 }

 String friendlyError(String error) {
   if(error.contains("workspace_outside_allowed_root"))return "当前项目目录尚未允许访问，请检查电脑连接器的工作目录配置。";
   if(error.contains("timeout"))return "读取超时，正在等待下一次同步。";
   if(error.contains("history_unavailable"))return "这段会话记录暂不可用，请确认电脑上的原始记录仍存在。";
   return "操作失败："+error;
 }

 void devices() {
   dismissDeviceSheet();
   DialogUi.Sheet sheet=popupUi.create("工作设备", "选择电脑", "选择一台在线电脑，继续你的工作。");
   deviceSheet=sheet.dialog;
   JSONArray devices=inventory==null?new JSONArray():inventory;
   if(devices.length()==0) {
     sheet.content.addView(popupUi.label(relayAuthenticated?"尚未发现在线设备\n请确认电脑连接器已启动。":"手机尚未连接中继\n已配对时可直接重新连接。"));
     sheet.setSecondary("取消",sheet::dismiss);
     sheet.setPrimary("配置连接",()->{sheet.dismiss();connection();});
     sheet.show();return;
   }
   String[] ids=new String[devices.length()], labels=new String[devices.length()];
   boolean[] online=new boolean[devices.length()];
   int initial=-1;
   for(int i=0;i<devices.length();i++) {
     JSONObject item=devices.optJSONObject(i);
     ids[i]=item==null?devices.optString(i):item.optString("id");
     labels[i]=item==null?ids[i]:item.optString("label",ids[i]);
     online[i]=item==null||item.optBoolean("online",true);
     if(ids[i].equals(selectedDeviceId))initial=i;
   }
   final int[] selected={initial};
   LinearLayout cards=new LinearLayout(this);cards.setOrientation(1);sheet.content.addView(cards);
   final Runnable[] draw=new Runnable[1];
   draw[0]=()->{
     cards.removeAllViews();
     for(int i=0;i<ids.length;i++) {
       final int index=i;
       String detail=online[i]?"在线 · 可连接":"离线 · 请检查电脑连接器";
       if(ids[i].equals(selectedDeviceId)&&ready)detail="在线 · 当前连接";
       View card=popupUi.actionCard(labels[i],detail,selected[0]==i,()->{
         if(!online[index]){sheet.setError("这台电脑暂时离线，请稍后重试。");return;}
         selected[0]=index;sheet.setError("");draw[0].run();
       });
       card.setAlpha(online[i]?1f:.55f);cards.addView(card);
     }
     sheet.setPrimaryEnabled(selected[0]>=0&&online[selected[0]]);
   };
   sheet.setSecondary("取消",sheet::dismiss);
   sheet.setPrimary("连接设备",()->{
     int n=selected[0];if(n<0||!online[n])return;
     if(!deviceIsOnline(ids[n])){sheet.setError(relayAuthenticated?"这台电脑暂时离线，请稍后重试。":"手机尚未连接中继，请重新连接。");return;}
     if(ready&&ids[n].equals(selectedDeviceId)){sheet.dismiss();return;}
     prefs.edit().putString(draftKey(),draft.getText().toString()).apply();
     accounts.close();sends.disconnect(selectedDeviceId);generation++;cancelHistoryPoll();historyRequestId="";historyDirty=false;
     selectedDeviceId=ids[n];selectingDevice=true;deviceButton.setText(labels[n]+" ▾");
     prefs.edit().putString("selectedDevice",selectedDeviceId).putString("deviceName:"+selectedDeviceId,labels[n]).apply();
     historyMessages=new ArrayList<>();historySignature="";historyLoaded=false;streamText="";streamTurnId="";
     sessionCatalog=new JSONArray();permissionConfig=null;ready=false;thread=prefs.getString("thread:"+selectedDeviceId,"");conversationTitle=prefs.getString("title:"+selectedDeviceId,"");
     draft.setText(prefs.getString(draftKey(),""));body.removeAllViews();pending.clear();requestThreads.clear();requestDevices.clear();requestGenerations.clear();
     notice("正在连接 "+labels[n]+"…");sheet.dismiss();
     js("selectDevice("+JSONObject.quote(ids[n])+")");
   });
   draw[0].run();sheet.show();
 }

 void showSessions(JSONArray sessions){sessionCatalog=sessions==null?new JSONArray():sessions;if(sessionDrawer!=null&&sessionDrawer.isShowing())filterSessions("");}
 void openSessions(){sessionDrawer=new Dialog(this);LinearLayout panel=new LinearLayout(this);panel.setOrientation(1);panel.setPadding(dp(16),dp(20),dp(16),dp(16));panel.setBackgroundColor(palette.sidebarSurface);LinearLayout heading=new LinearLayout(this);TextView label=text("工作会话",23);heading.addView(label,new LinearLayout.LayoutParams(0,-2,1));heading.addView(button("关闭",()->sessionDrawer.dismiss()));panel.addView(heading);EditText search=new EditText(this);search.setSingleLine(true);search.setTextColor(palette.text);search.setHintTextColor(palette.hint);search.setHighlightColor(palette.highlight);search.setBackgroundTintList(android.content.res.ColorStateList.valueOf(palette.border));search.setHint("搜索会话");panel.addView(search);ScrollView list=new ScrollView(this);sessionRows=new LinearLayout(this);sessionRows.setOrientation(1);list.addView(sessionRows);panel.addView(list,new LinearLayout.LayoutParams(-1,0,1));panel.addView(button("刷新列表",()->call("sessions.list",new JSONObject())));search.addTextChangedListener(new android.text.TextWatcher(){public void beforeTextChanged(CharSequence v,int st,int c,int after){}public void onTextChanged(CharSequence v,int st,int before,int count){filterSessions(v.toString());}public void afterTextChanged(android.text.Editable e){}});sessionDrawer.setContentView(panel);Window w=sessionDrawer.getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setGravity(Gravity.LEFT|Gravity.TOP);w.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);WindowManager.LayoutParams attrs=w.getAttributes();attrs.dimAmount=.55f;w.setAttributes(attrs);}sessionDrawer.show();if(w!=null)w.setLayout((int)(getResources().getDisplayMetrics().widthPixels*.86),-1);filterSessions("");if(ready)call("sessions.list",new JSONObject());}
 void filterSessions(String query){if(sessionRows==null)return;sessionRows.removeAllViews();String q=query.toLowerCase(java.util.Locale.ROOT);int count=0;for(int i=0;i<sessionCatalog.length();i++){JSONObject item=sessionCatalog.optJSONObject(i);if(item==null)continue;String name=item.optString("name",item.optString("title",item.optString("id")));if(!name.toLowerCase(java.util.Locale.ROOT).contains(q))continue;count++;Button row=button(name,()->{openConversation(item);sessionDrawer.dismiss();});row.setGravity(Gravity.START|Gravity.CENTER_VERTICAL);row.setMaxLines(2);if(item.optString("id").equals(thread))row.setBackground(surface(palette.selectedSurface,14));sessionRows.addView(row,new LinearLayout.LayoutParams(-1,-2));}if(count==0)sessionRows.addView(text(ready?"暂无匹配会话":"连接电脑后显示会话",14));}

 String permissionName(String mode){return "full".equals(mode)?"完全访问":"auto".equals(mode)?"自动审核":"ask".equals(mode)?"需要审批":"自定义权限";}
 void readPermissions(){if(thread.isEmpty()){notice("请先在侧边栏选择会话");return;}try{notice("正在读取当前会话权限…");call("session.permissions.read",new JSONObject().put("threadId",thread));}catch(Exception ex){notice("权限读取失败");}}

 void showPermissions() {
   final String target=thread;final JSONObject config=permissionConfig;
   if(config==null)return;
   DialogUi.Sheet sheet=popupUi.create("会话设置", "执行权限", "当前："+permissionName(config.optString("mode"))+" · 仅应用于这个会话");
   if(!config.optBoolean("editable")) {
     sheet.content.addView(popupUi.label("当前会话暂时无法修改权限。请在任务结束后重试，或在电脑端调整。"));
     sheet.setPrimary("知道了",sheet::dismiss);sheet.show();return;
   }
   String[] modes=config.optBoolean("allowFullAccess")?new String[]{"ask","auto","full"}:new String[]{"ask","auto"};
   String[] details={"需要授权时由你确认，再继续执行。", "由 Codex 自动审核权限请求。", "允许在电脑用户权限范围内执行命令和访问文件。"};
   int initial=-1;
   for(int i=0;i<modes.length;i++)if(modes[i].equals(config.optString("mode")))initial=i;
   final int[] selected={initial};
   LinearLayout cards=new LinearLayout(this);cards.setOrientation(1);sheet.content.addView(cards);
   final Runnable[] draw=new Runnable[1];
   draw[0]=()->{
     cards.removeAllViews();
     for(int i=0;i<modes.length;i++) {
       final int n=i;
       cards.addView(popupUi.actionCard(permissionName(modes[i]),details[i],selected[0]==i,()->{selected[0]=n;draw[0].run();}));
     }
     sheet.setPrimaryEnabled(selected[0]>=0);
   };
   if(!config.optBoolean("allowFullAccess"))sheet.content.addView(popupUi.label("此电脑尚未开放完全访问。"));
   sheet.setSecondary("取消",sheet::dismiss);
   sheet.setPrimary("保存权限",()->{
     if(!thread.equals(target)){sheet.setError("当前会话已切换，请重新打开权限设置。");return;}
     if(!ready){sheet.setError("电脑连接已断开，请重新连接后再保存。");return;}
     if(selected[0]<0)return;
     String mode=modes[selected[0]];
     if(mode.equals(config.optString("mode"))){sheet.dismiss();return;}
     Runnable save=()->{
       if(!thread.equals(target))return;
       if(!ready){sheet.setError("电脑连接已断开，请重新连接后再保存。");return;}
       try {
         JSONObject payload=new JSONObject().put("threadId",target).put("mode",mode);
         if(config.has("settingsToken"))payload.put("settingsToken",config.get("settingsToken"));
         sheet.dismiss();call("session.permissions.update",payload);notice("正在保存权限…");
       } catch(Exception ex){sheet.setError("无法保存权限，请重试。");}
     };
     if("full".equals(mode)) {
       DialogUi.Sheet confirm=popupUi.create("权限确认", "启用完全访问？", "此设置仅应用于当前会话。");
       confirm.content.addView(popupUi.label("Codex 将能在当前电脑用户的权限范围内执行命令和访问文件。"));
       confirm.setSecondary("返回",confirm::dismiss);
       confirm.setPrimary("确认启用",()->{confirm.dismiss();save.run();});confirm.show();
     } else save.run();
   });
   draw[0].run();sheet.show();
 }


 void openConversation(JSONObject item) {
   prefs.edit().putString(draftKey(),draft.getText().toString()).apply();
   generation++;thread=item.optString("id");conversationTitle=item.optString("title",item.optString("name","会话"));
   prefs.edit().putString("thread:"+selectedDeviceId,thread).putString("title:"+selectedDeviceId,conversationTitle).apply();
   draft.setText(prefs.getString(draftKey(),""));
   historyRequestId="";historyDirty=false;historyLoaded=false;historySignature="";
   historyMessages=new ArrayList<>();streamText="";streamTurnId="";
   cancelHistoryPoll();forceHistoryBottom=true;
   showHistoryPlaceholder("正在加载会话…","正在从电脑读取最新记录");readHistory(true);
 }

 String draftKey(){return "draft:"+selectedDeviceId+":"+thread;}

 void refresh() {
   if(thread.isEmpty()){call("sessions.list",new JSONObject());return;}
   readHistory(false);
 }

 void readHistory(boolean initial) {
   if(!ready||thread.isEmpty()||!foreground)return;
   if(!historyRequestId.isEmpty()&&pending.containsKey(historyRequestId)){historyDirty=true;return;}
   cancelHistoryPoll();historyReadStartedAt=SystemClock.uptimeMillis();historyDirty=false;
   try {
     if(initial&&!historyLoaded)showHistoryPlaceholder("正在加载会话…","正在从电脑读取最新记录");
     historyRequestId=call("session.read",new JSONObject().put("threadId",thread));
     if(historyRequestId==null)historyRequestId="";
   }catch(Exception error){notice("无法请求会话记录，请重试。");scheduleHistory(HISTORY_RETRY_INTERVAL_MS);}
 }

 void cancelHistoryPoll() {
   syncHandler.removeCallbacks(historyPoll);historyPollAt=0;
 }

 void scheduleNextHistory() {
   // Keep the normal cadence while leaving a gap after unusually slow reads.
   long elapsed=SystemClock.uptimeMillis()-historyReadStartedAt;
   scheduleHistory(Math.max(200,HISTORY_SYNC_INTERVAL_MS-elapsed));
 }

 void scheduleHistory(long delay) {
   if(!foreground||!ready||thread.isEmpty())return;
   long due=SystemClock.uptimeMillis()+delay;
   if(historyPollAt!=0&&historyPollAt<=due)return;
   cancelHistoryPoll();historyPollAt=due;syncHandler.postAtTime(historyPoll,due);
 }

 void handleLiveEvent(JSONObject frame) {
   JSONObject payload=frame.optJSONObject("payload");
   String target=payload==null?"":payload.optString("threadId");
   if(!target.isEmpty()&&!target.equals(thread))return;
   if(thread.isEmpty())return;
   String event=frame.optString("event");
   if(event.equals("turn.delta")&&payload!=null) {
     String turn=payload.optString("turnId");
     if(!turn.equals(streamTurnId)){streamTurnId=turn;streamText="";}
     streamText+=payload.optString("delta");renderConversation(false);notice("Codex 正在回复…");
   } else if(event.equals("turn.final")&&payload!=null) {
     streamTurnId=payload.optString("turnId");streamText=payload.optString("text",streamText);
     renderConversation(false);
   }
   // Coalesce events without postponing an earlier sync.
   scheduleHistory(event.equals("turn.delta")?800:250);
 }

 String historyFingerprint(List<ConversationHistory.Message> rows) {
   StringBuilder result=new StringBuilder();
   for(ConversationHistory.Message row:rows)result.append(row.id).append('\u0000').append(row.kind).append('\u0000').append(row.text).append('\u0001');
   return result.toString();
 }

 void reconcileOutgoing() {
   List<SendLedger.SeenUser> users=new ArrayList<>();
   for(ConversationHistory.Message row:historyMessages)if("user".equals(row.kind))users.add(new SendLedger.SeenUser(row.id,row.text));
   sends.reconcile(selectedDeviceId,thread,users);
 }

 boolean hasPendingSend() {
   for(SendLedger.Entry entry:sends.entries(selectedDeviceId,thread))
     if(entry.state.equals("pending")||entry.state.equals("receipt"))return true;
   return false;
 }

 void showHistoryPlaceholder(String title,String detail) {
   body.removeAllViews();
   body.addView(text(conversationTitle.isEmpty()?"会话":conversationTitle,20));
   body.addView(text(title,16));body.addView(text(detail,13));
 }

 void renderConversation(boolean forceBottom) {
   if(thread.isEmpty())return;
   int oldY=historyScroll.getScrollY();
   boolean following=forceBottom||body.getHeight()-oldY-historyScroll.getHeight()<dp(100);
   body.removeAllViews();body.addView(text(conversationTitle.isEmpty()?"会话":conversationTitle,19));
   for(ConversationHistory.Message row:historyMessages)addMessage(row.kind,row.text,"");
   for(SendLedger.Entry entry:sends.entries(selectedDeviceId,thread)) {
     if(entry.state.equals("confirmed"))continue;
     String label=entry.state.equals("pending")?"发送中…":entry.state.equals("receipt")?"电脑已收到，等待确认…":entry.state.equals("accepted")?"已发送，等待记录同步":entry.state.equals("failed")?"发送失败："+entry.detail:"结果待确认，请先同步记录，勿重复发送";
     addMessage("user",entry.text,label);
   }
   if(!streamText.isEmpty())addMessage("assistant",streamText,"正在回复…");
   if(historyLoaded&&historyMessages.isEmpty()&&sends.entries(selectedDeviceId,thread).isEmpty())body.addView(text("这个会话暂无文字消息",14));
   historyScroll.post(()->{if(following)historyScroll.fullScroll(View.FOCUS_DOWN);else historyScroll.scrollTo(0,oldY);});
 }

 void addMessage(String kind,String value,String state) {
   if(value==null||value.isEmpty())return;
   LinearLayout card=new LinearLayout(this);card.setOrientation(1);
   boolean user=kind.equals("user");
   card.setTag(user ? HistoryTone.USER_CARD : HistoryTone.ASSISTANT_CARD);
   TextView role=text(user?"你":kind.equals("assistant")?"Codex":kind.equals("progress")?"任务进度":"会话提示",12);
   role.setTag(user ? HistoryTone.ACCENT : HistoryTone.MUTED);card.addView(role);
   card.addView(text(value,16));
   if(!state.isEmpty()){TextView badge=text(state,12);badge.setTag(state.startsWith("发送失败") ? HistoryTone.ERROR : HistoryTone.MUTED);card.addView(badge);}
   colorHistory(card);
   LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.setMargins(user?dp(18):0,dp(8),user?0:dp(12),dp(8));body.addView(card,layout);
 }

 void submit() {
   String value=draft.getText().toString().trim();
   if(value.isEmpty()||thread.isEmpty()){notice("先选择会话并输入指令");return;}
   if(!ready){notice("电脑连接已断开，草稿已保留");return;}
   if(!historyLoaded){notice("正在读取会话，请加载完成后发送");return;}
   if(hasPendingSend()){notice("上一条指令尚未确认，请稍候");return;}
   try {
     Set<String> baseline=new HashSet<>();for(ConversationHistory.Message row:historyMessages)if("user".equals(row.kind))baseline.add(row.id);
     String id=call("turn.start",new JSONObject().put("threadId",thread).put("text",value));
     if(id==null)return;
     sends.begin(id,selectedDeviceId,thread,value,baseline);
     draft.setText("");prefs.edit().putString(draftKey(),"").apply();
     renderConversation(true);notice("正在发送到电脑…");scheduleHistory(400);
   }catch(Exception error){notice("消息未发出，草稿已保留");}
 }

 protected void onActivityResult(int req,int result,Intent data) {
   super.onActivityResult(req,result,data);
   if(req!=88)return;
   if(result==RESULT_OK&&data!=null) {
     String value=data.getStringExtra("pairing");if(value==null)return;
     connectionPairDraft=value;scannedPair=value;
     if(server.isEmpty()&&connectionServerDraft.isEmpty()) {
       android.net.Uri pair=android.net.Uri.parse(value);
       if("https".equals(pair.getScheme())&&pair.getHost()!=null&&pair.getUserInfo()==null)
         connectionServerDraft="https://"+pair.getAuthority()+"/";
     }
   }
   connection();
   if(result==RESULT_OK&&connectionDialog!=null) {
     try {
       android.net.Uri u=validatedServer(connectionServerDraft.isEmpty()?server:connectionServerDraft);
       android.net.Uri pair=android.net.Uri.parse(scannedPair);
       if(!u.getHost().equalsIgnoreCase(pair.getHost())||u.getPort()!=pair.getPort())
         connectionDialog.setError("二维码来自其他服务器，请核对上面的服务器地址。");
       else connectionDialog.setError("");
     } catch(Exception ignored){}
   }
 }

 android.net.Uri validatedServer(String value) {
   android.net.Uri uri=android.net.Uri.parse(value);
   if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getHost().isEmpty()||uri.getUserInfo()!=null
      ||uri.getQuery()!=null||uri.getFragment()!=null||(!"".equals(uri.getPath())&&!"/".equals(uri.getPath())))
     throw new IllegalArgumentException("请输入 HTTPS 服务器地址，例如 https://example.com:8443/");
   return uri;
 }

 String connectionError(JSONObject event) {
   int code=event.optInt("code");
   if(code==4003)return "配对链接无效、已使用或已过期，请重新扫码。";
   if(code==4403||code==4407)return "这台手机尚未授权，请扫码完成配对。";
   if(code==4429)return "尝试次数过多，请稍后使用新链接重试。";
   if(code==4001)return "连接超时，请检查网络后重试。";
   return event.optString("message","连接失败，请检查网络和服务器地址。");
 }

 void finishConnectionError(String message) {
   if(connectionBusy){connectAfterLoad=false;pendingPairCredential=null;js("cancelConnection()");}
   connectionBusy=false;connectionAttempt++;
   connectionDialog.setError(message);
   connectionDialog.setBusy(false, "");connectionDialog.setPrimaryEnabled(true);
 }

 void connection() {
   if(connectionDialog!=null&&connectionDialog.dialog.isShowing())return;
   DialogUi.Sheet sheet=popupUi.create("连接设置", "连接你的电脑", "已配对的手机可直接连接；首次使用请扫码配对。");
   connectionDialog=sheet;
   final boolean[] completed={false};
   completeConnection=()->{completed[0]=true;connectionBusy=false;connectionAttempt++;scannedPair="";connectionServerDraft="";connectionPairDraft="";sheet.dismiss();};
   sheet.content.addView(popupUi.label("服务器地址"));
   EditText url=popupUi.field("https://example.com:8443/",connectionServerDraft.isEmpty()?server:connectionServerDraft,false);
   url.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);
   sheet.content.addView(url);
   sheet.content.addView(popupUi.actionLink("扫码配对", "扫描电脑提供的二维码，自动填入配对信息。",()->{
     connectionServerDraft=url.getText().toString().trim();connectionPairDraft="";
     scannedPair="";sheet.dismiss();
     startActivityForResult(new Intent(this,ScanActivity.class),88);
   }));
   sheet.content.addView(popupUi.label("或粘贴配对链接"));
   EditText pair=popupUi.field("粘贴完整链接，已配对可留空",connectionPairDraft.isEmpty()?scannedPair:connectionPairDraft,true);
   pair.setMaxLines(3);
   pair.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
   sheet.content.addView(pair);
   sheet.setSecondary("取消",sheet::dismiss);
   sheet.setPrimary("连接电脑",()->{
     if(connectionBusy)return;
     String target=url.getText().toString().trim(),credential=pair.getText().toString().trim();
     android.net.Uri uri;
     try {uri=validatedServer(target);}catch(Exception error){sheet.setError(error.getMessage());url.requestFocus();return;}
     if(!credential.isEmpty()) {
       android.net.Uri pairing=android.net.Uri.parse(credential);
       String fragment=pairing.getFragment();
       if(!"https".equals(pairing.getScheme())||pairing.getUserInfo()!=null||pairing.getHost()==null
          ||fragment==null||!fragment.matches("pair=v1\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{43}")) {
         sheet.setError("配对链接格式不完整，请重新扫码或粘贴完整链接。");pair.requestFocus();return;
       }
       if(!uri.getHost().equalsIgnoreCase(pairing.getHost())||uri.getPort()!=pairing.getPort()) {
         sheet.setError("配对链接与服务器地址不一致，请核对后重试。");return;
       }
     }
     if(!engineLoaded){sheet.setError("连接组件正在准备，请稍后重试。");return;}
     connectionServerDraft=target;connectionPairDraft=credential;connectionBusy=true;
     sheet.setError("");sheet.setBusy(true,"正在连接…");
     notice("正在连接并验证设备…");
     android.view.inputmethod.InputMethodManager keyboard=(android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE);
     if(keyboard!=null)keyboard.hideSoftInputFromWindow(pair.getWindowToken(),0);
     invalidateRelay();renderConversation(false);
     String normalized="https://"+uri.getAuthority()+"/";
     if(!server.equals(normalized)) {
       server=normalized;prefs.edit().putString("server",server).apply();
       engineLoaded=false;connectAfterLoad=true;pendingPairCredential=credential;
       engine.loadUrl(server+"__native/engine.html");
     } else js("connect("+JSONObject.quote(server)+","+JSONObject.quote(credential)+")");
     final int attempt=++connectionAttempt;
     new Handler().postDelayed(()->{
       if(connectionBusy&&attempt==connectionAttempt&&connectionDialog==sheet)
         finishConnectionError("连接未确认，请检查网络后重试。");
     },20000);
   });
   sheet.dialog.setOnDismissListener(dialog->{
     if(completed[0])return;
     if(connectionBusy&&connectionDialog==sheet){connectAfterLoad=false;pendingPairCredential=null;connectionAttempt++;js("cancelConnection()");notice("已取消连接");}
     connectionBusy=false;
     connectionServerDraft=url.getText().toString().trim();
     connectionPairDraft=pair.getText().toString().trim();
   });
   sheet.show();
 }

protected void onResume(){super.onResume();foreground=true;if(accounts!=null)accounts.setForeground(true);if(engine!=null){engine.onResume();if(engineLoaded)js("setForeground(true)");}if(ready&&!thread.isEmpty())scheduleHistory(0);}
protected void onPause(){foreground=false;if(accounts!=null)accounts.setForeground(false);if(engineLoaded)js("setForeground(false)");cancelHistoryPoll();if(draft!=null&&prefs!=null)prefs.edit().putString(draftKey(),draft.getText().toString()).apply();super.onPause();}
protected void onDestroy(){if(accounts!=null)accounts.close();syncHandler.removeCallbacksAndMessages(null);dismissDeviceSheet();if(connectionDialog!=null)connectionDialog.dismiss();engine.destroy();super.onDestroy();}
}
