package local.codex.anywhere;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Account controls for the selected computer. Login material stays in memory. */
final class AccountUi {
    interface Sender {
        void send(String action, JSONObject payload);
    }

    private static final long LOGIN_POLL_MS = 2_000;
    private final Activity activity;
    private final DialogUi ui;
    private final Sender sender;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<AccountChoice> choices = new ArrayList<>();
    private final Runnable loginPoll = this::pollLogin;
    private final Runnable restartPoll = this::pollRestart;
    private DialogUi.Sheet sheet;
    private DialogUi.Sheet confirmation;
    private JSONObject accountData;
    private AccountChoice selected;
    private String pendingAction = "";
    private String loginId = "";
    private String loginCode = "";
    private Uri loginUrl;
    private boolean foreground = true;
    private boolean cancelRequested;
    private boolean desktopRestartRequired;
    private boolean desktopRestartSupported;
    private boolean desktopRestartRequested;
    private String restartId = "";
    private String restartStatus = "";
    private String restartError = "";
    private String consumedRestartId = "";

    AccountUi(Activity activity, DialogUi ui, Sender sender) {
        this.activity = activity;
        this.ui = ui;
        this.sender = sender;
    }

    void open() {
        if (isShowing()) return;
        sheet = ui.create("所选电脑", "Codex 账号", "管理这台电脑上已登录的账号和工作区。");
        DialogUi.Sheet current = sheet;
        current.dialog.setOnDismissListener(dialog -> {
            if (sheet == current) {
                sheet = null;
                handler.removeCallbacks(loginPoll);
                handler.removeCallbacks(restartPoll);
                dismissConfirmation();
            }
        });
        current.content.addView(ui.label("正在读取电脑上的账号…"));
        current.setSecondary("关闭", current::dismiss);
        current.show();
        if (!loginId.isEmpty()) {
            showLogin();
            scheduleLoginPoll(0);
        } else if (pendingAction.isEmpty()) {
            request("account.sessions.list", listPayload());
        }
    }

    void setForeground(boolean active) {
        foreground = active;
        handler.removeCallbacks(loginPoll);
        handler.removeCallbacks(restartPoll);
        if (active) {
            scheduleLoginPoll(0);
            scheduleRestartPoll(0);
        }
    }

    void handleResponse(String action, boolean ok, JSONObject data, String error) {
        if (!action.equals(pendingAction)) return;
        pendingAction = "";
        if (!isShowing()) return;
        sheet.setBusy(false, "");
        if (action.equals("account.login.status") && cancelRequested
                && (!ok || "pending".equals(data == null ? "" : jsonString(data, "status")))) {
            request("account.login.cancel", loginPayload());
            return;
        }
        if (!ok) {
            sheet.setError(friendlyError(error));
            if (action.equals("account.desktop.restart") || action.equals("account.desktop.restart.status")) {
                restartStatus = "unknown";
                restartError = "desktop_restart_status_unavailable";
                handler.removeCallbacks(restartPoll);
                showAccounts(accountData);
                sheet.setError(friendlyError(error));
            } else if (action.equals("account.login.status")) {
                String code = error == null ? "" : error;
                if (code.contains("owned_by_other_device") || code.contains("login_stale") || code.contains("unsupported")) {
                    clearLogin();
                    showAccounts(accountData);
                    sheet.setError(friendlyError(error));
                } else {
                    scheduleLoginPoll(5_000);
                }
            } else if (action.equals("account.login.cancel")) {
                cancelRequested = false;
                showLogin();
                sheet.setError("取消登录未确认，可重新检查登录状态。");
                scheduleLoginPoll(5_000);
            } else {
                showAccounts(accountData);
                sheet.setError(friendlyError(error));
            }
            return;
        }
        JSONObject result = data == null ? new JSONObject() : data;
        updateDesktopState(result);
        updateRestartState(result);
        sheet.setError("");
        if (action.equals("account.sessions.list")) {
            showAccounts(result);
            refreshAfterRestartCompletion();
        } else if (action.equals("account.sessions.switch")) {
            if (result.optJSONArray("sessions") != null) showAccounts(result);
            else refreshUpdatedAccount();
        } else if (action.equals("account.login.start")) {
            beginLogin(result);
        } else if (action.equals("account.login.status")) {
            applyLoginStatus(result);
        } else if (action.equals("account.login.cancel")) {
            applyLoginStatus(result);
        } else if (action.equals("account.desktop.restart") || action.equals("account.desktop.restart.status")) {
            showAccounts(accountData);
            refreshAfterRestartCompletion();
        }
    }

    void close() {
        handler.removeCallbacks(loginPoll);
        handler.removeCallbacks(restartPoll);
        dismissConfirmation();
        if (sheet != null) sheet.dismiss();
        sheet = null;
        pendingAction = "";
        accountData = null;
        choices.clear();
        selected = null;
        clearLogin();
        desktopRestartRequired = false;
        desktopRestartSupported = false;
        desktopRestartRequested = false;
        restartId = "";
        restartStatus = "";
        restartError = "";
        consumedRestartId = "";
    }

    private void showAccounts(JSONObject data) {
        if (!isShowing()) return;
        accountData = data;
        selected = null;
        choices.clear();
        sheet.content.removeAllViews();
        addDesktopRestartControls();
        JSONArray sessions = data == null ? null : data.optJSONArray("sessions");
        String activeId = data == null ? "" : jsonString(data, "activeSessionId");
        JSONObject activeAccount = data == null ? null : data.optJSONObject("activeAccount");
        String activePlan = activeAccount == null ? "" : planName(jsonString(activeAccount, "planType"));
        String activeWorkspaceName = activeAccount == null ? "" : displayText(jsonString(activeAccount, "workspaceName"));
        if (!activePlan.isEmpty()) sheet.content.addView(ui.label("已选择订阅 · " + activePlan));
        if (!activeWorkspaceName.isEmpty()) sheet.content.addView(ui.label("已选择工作区 · " + activeWorkspaceName));
        if (sessions != null) {
            for (int i = 0; i < sessions.length(); i++) {
                JSONObject session = sessions.optJSONObject(i);
                if (session == null) continue;
                addSessionChoices(session, activeId, activePlan);
            }
        }
        if (data == null) {
            sheet.content.addView(ui.label("点击“刷新账号列表”读取电脑上的账号。"));
        } else if (choices.isEmpty()) {
            sheet.content.addView(ui.label("电脑上暂无可切换的已登录账号。"));
        }
        LinearLayout accountCards = new LinearLayout(activity);
        accountCards.setOrientation(LinearLayout.VERTICAL);
        sheet.content.addView(accountCards);
        drawChoices(accountCards);
        sheet.content.addView(ui.actionLink("登录其他账号", "授权成功后更新电脑上的登录，重启 Codex 后生效。", () -> {
            if (!pendingAction.isEmpty() || restartPending()) return;
            request("account.login.start", new JSONObject());
        }));
        sheet.content.addView(ui.actionLink("刷新账号列表", "重新读取电脑上的登录状态。", () -> {
            if (!pendingAction.isEmpty()) return;
            request("account.sessions.list", listPayload());
        }));
        sheet.setSecondary("关闭", sheet::dismiss);
        sheet.setPrimary("切换账号 / 工作区", this::confirmSwitch);
        sheet.setPrimaryEnabled(false);
    }

    private void addSessionChoices(JSONObject session, String activeId, String activePlan) {
        String sessionId = jsonString(session, "sessionId");
        if (sessionId.isEmpty()) return;
        String email = displayText(jsonString(session, "email"));
        String displayName = displayText(jsonString(session, "displayName"));
        String title = displayName.isEmpty() ? email : displayName;
        if (title.isEmpty()) title = "ChatGPT 账号";
        boolean activeSession = session.optBoolean("isActive") || sessionId.equals(activeId);
        String activeWorkspace = jsonString(session, "selectedWorkspaceAccountId");
        JSONArray workspaces = session.optJSONArray("workspaces");
        if (workspaces == null || workspaces.length() == 0) {
            sheet.content.addView(ui.label(title + " · 需要重新登录"));
            return;
        }
        for (int i = 0; i < workspaces.length(); i++) {
            JSONObject workspace = workspaces.optJSONObject(i);
            if (workspace == null) continue;
            String accountId = jsonString(workspace, "accountId");
            if (accountId.isEmpty()) continue;
            String workspaceName = displayText(jsonString(workspace, "name"));
            String kindName = workspaceKindName(jsonString(workspace, "kind"));
            boolean current = activeSession && (accountId.equals(activeWorkspace)
                    || activeWorkspace.isEmpty() && workspaces.length() == 1);
            String workspaceLabel = kindName;
            if (!workspaceName.isEmpty() && !workspaceName.equals(kindName)) workspaceLabel += " · " + workspaceName;
            String detail = email.isEmpty() || email.equals(title) ? workspaceLabel : email + "\n" + workspaceLabel;
            if (current) detail += (activePlan.isEmpty() ? "" : " · " + activePlan) + " · 已选择";
            choices.add(new AccountChoice(sessionId, accountId, title, detail, current));
        }
    }

    private void drawChoices(LinearLayout container) {
        container.removeAllViews();
        for (AccountChoice choice : choices) {
            boolean checked = selected == null ? choice.current : selected == choice;
            View card = ui.actionCard(choice.title, choice.detail, checked, () -> {
                if (!pendingAction.isEmpty() || restartPending()) return;
                selected = choice;
                sheet.setError("");
                sheet.setPrimaryEnabled(!choice.current);
                drawChoices(container);
            });
            card.setEnabled(!restartPending());
            card.setAlpha(restartPending() ? .55f : 1f);
            container.addView(card);
        }
    }

    private void confirmSwitch() {
        if (!isShowing() || selected == null || selected.current || !pendingAction.isEmpty() || restartPending()) return;
        final AccountChoice target = selected;
        dismissConfirmation();
        confirmation = ui.create("Codex 账号", "更新账号和工作区？", "保存下面的登录选择。电脑上的 Codex 需要重启后使用此账号和工作区。");
        DialogUi.Sheet confirm = confirmation;
        confirm.content.addView(ui.label(target.title + "\n" + target.detail));
        confirm.setSecondary("取消", confirm::dismiss);
        confirm.setPrimary("确认切换", () -> {
            confirm.dismiss();
            if (!isShowing() || !pendingAction.isEmpty() || restartPending()) return;
            JSONObject payload = new JSONObject();
            try {
                payload.put("sessionId", target.sessionId);
                payload.put("accountId", target.accountId);
                payload.put("allowBrowserLogin", false);
            } catch (JSONException error) {
                sheet.setError("无法准备账号切换，请重新打开账号列表。");
                return;
            }
            request("account.sessions.switch", payload);
        });
        confirm.show();
    }

    private void beginLogin(JSONObject data) {
        String status = jsonString(data, "status");
        if (!status.isEmpty() && !status.equals("pending")) {
            applyLoginStatus(data);
            return;
        }
        String id = jsonString(data, "loginId");
        String code = jsonString(data, "userCode");
        Uri url = verificationUrl(jsonString(data, "verificationUrl"));
        if (id.isEmpty() || id.length() > 512 || !code.matches("[A-Za-z0-9-]{4,32}") || url == null) {
            showAccounts(accountData);
            sheet.setError("电脑返回的登录信息不完整，请重试。");
            return;
        }
        loginId = id;
        loginCode = code;
        loginUrl = url;
        showLogin();
        scheduleLoginPoll(LOGIN_POLL_MS);
    }

    private void showLogin() {
        if (!isShowing() || loginId.isEmpty()) return;
        sheet.content.removeAllViews();
        sheet.content.addView(ui.label("在浏览器中登录目标账号，并输入下面的验证码。"));
        sheet.content.addView(ui.label("授权成功后更新电脑上的登录，重启 Codex 后生效。"));
        TextView code = ui.label(loginCode);
        code.setTextSize(25);
        code.setTextColor(ui.accentColor());
        code.setTextIsSelectable(true);
        code.setContentDescription("登录验证码 " + loginCode);
        sheet.content.addView(code);
        sheet.content.addView(ui.actionLink("复制验证码", "授权完成后返回 App，登录状态会自动更新。", () -> {
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("Codex 登录验证码", loginCode));
        }));
        sheet.setSecondary("取消登录", this::cancelLogin);
        sheet.setPrimary("打开登录页面", this::openLoginBrowser);
        sheet.setPrimaryEnabled(true);
    }

    private void openLoginBrowser() {
        if (!isShowing() || loginUrl == null) return;
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, loginUrl));
        } catch (ActivityNotFoundException error) {
            sheet.setError("没有可用的浏览器，请先安装浏览器后重试。");
        }
    }

    private void applyLoginStatus(JSONObject data) {
        String status = jsonString(data, "status");
        updateDesktopState(data);
        if (status.equals("completed")) {
            clearLogin();
            refreshUpdatedAccount();
        } else if (status.equals("failed")) {
            clearLogin();
            showAccounts(accountData);
            sheet.setError(friendlyError(data.optString("message", "login_failed")));
        } else if (status.equals("pending")) {
            scheduleLoginPoll(LOGIN_POLL_MS);
        } else {
            clearLogin();
            showAccounts(accountData);
            if (status.equals("cancelled")) {
                sheet.content.addView(ui.label("登录已取消。"), 0);
            } else if (status.equals("idle")) {
                sheet.content.addView(ui.label("电脑上已无进行中的登录，可重新发起登录。"), 0);
            } else {
                sheet.setError("登录状态不可用，请重新发起登录。");
            }
        }
    }

    private void refreshUpdatedAccount() {
        accountData = null;
        showAccounts(null);
        request("account.sessions.list", listPayload());
    }

    private void updateDesktopState(JSONObject data) {
        if (data.has("desktopRestartRequired"))
            desktopRestartRequired = data.optBoolean("desktopRestartRequired");
        if (data.has("desktopRestartSupported"))
            desktopRestartSupported = data.optBoolean("desktopRestartSupported");
        if (data.has("desktopRestartRequested"))
            desktopRestartRequested = data.optBoolean("desktopRestartRequested");
    }

    private void updateRestartState(JSONObject data) {
        if (!data.has("restart")) return;
        JSONObject restart = data.optJSONObject("restart");
        restartId = restart == null ? "" : jsonString(restart, "id");
        restartStatus = restart == null ? "" : jsonString(restart, "status");
        restartError = restart == null ? "" : jsonString(restart, "error");
        handler.removeCallbacks(restartPoll);
        scheduleRestartPoll(LOGIN_POLL_MS);
    }

    private void addDesktopRestartControls() {
        if (restartPending()) {
            sheet.content.addView(ui.label("正在重启电脑上的 Codex…"));
            scheduleRestartPoll(LOGIN_POLL_MS);
            return;
        }
        if (restartStatus.equals("completed")) {
            sheet.content.addView(ui.label(desktopRestartRequired
                    ? "上次重启已完成；账号随后有更新，请再次重启 Codex。"
                    : "已确认 Codex 重新启动。"));
            if (!desktopRestartRequired) return;
        }
        if (restartStatus.equals("failed") || restartStatus.equals("unknown")) {
            sheet.content.addView(ui.label(restartMessage()));
            sheet.content.addView(ui.label("请在电脑上退出 Codex 后重新打开，应用已保存的账号选择。"));
            if (desktopRestartSupported) {
                sheet.content.addView(ui.actionLink("重新尝试重启", "重新确认后提交一次重启请求。", this::confirmDesktopRestart));
            }
            return;
        }
        if (!desktopRestartRequired) return;
        if (!restartStatus.equals("completed")) {
            sheet.content.addView(ui.label(desktopRestartRequested
                    ? "已提交重启请求；如电脑仍使用旧账号，请手动重启 Codex。"
                    : "账号已更新，重启电脑上的 Codex 后生效。"));
        }
        if (desktopRestartSupported) {
            sheet.content.addView(ui.actionLink("重启 Codex", "让电脑上的 Codex 使用已选择的账号和工作区。", this::confirmDesktopRestart));
        } else {
            sheet.content.addView(ui.label("请在电脑上退出 Codex 后重新打开，应用已保存的账号选择。"));
        }
    }

    private void confirmDesktopRestart() {
        if (!isShowing() || !pendingAction.isEmpty() || restartPending() || !desktopRestartSupported) return;
        dismissConfirmation();
        confirmation = ui.create("所选电脑", "重启 Codex？", "重启会中断电脑上正在运行的 Codex 任务。重新打开后会读取已保存的账号选择。");
        DialogUi.Sheet confirm = confirmation;
        confirm.setSecondary("取消", confirm::dismiss);
        confirm.setPrimary("确认重启", () -> {
            confirm.dismiss();
            JSONObject payload = new JSONObject();
            try {
                payload.put("confirm", true);
            } catch (JSONException error) {
                if (isShowing()) sheet.setError("无法准备重启请求，请重试。");
                return;
            }
            request("account.desktop.restart", payload);
        });
        confirm.show();
    }

    private boolean restartPending() {
        return restartStatus.equals("pending") || restartStatus.equals("restarting");
    }

    private void pollRestart() {
        if (!foreground || !isShowing() || !restartPending() || restartId.isEmpty()) return;
        if (!pendingAction.isEmpty()) {
            scheduleRestartPoll(LOGIN_POLL_MS);
            return;
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("restartId", restartId);
        } catch (JSONException ignored) {
            return;
        }
        request("account.desktop.restart.status", payload);
    }

    private void scheduleRestartPoll(long delay) {
        handler.removeCallbacks(restartPoll);
        if (foreground && isShowing() && restartPending() && !restartId.isEmpty())
            handler.postDelayed(restartPoll, delay);
    }

    private void refreshAfterRestartCompletion() {
        if (!restartStatus.equals("completed") || restartId.isEmpty() || restartId.equals(consumedRestartId)) return;
        consumedRestartId = restartId;
        request("account.sessions.list", listPayload());
    }

    private String restartMessage() {
        if (restartError.contains("identity_changed")) return "电脑上的 Codex 安装位置已变化，自动重启未完成。";
        if (restartError.contains("target_unavailable")) return "未找到可重启的 Codex 桌面程序，请在电脑上手动打开 Codex。";
        if (restartError.contains("helper_failed")) return "电脑上的重启程序执行失败，请手动重启 Codex。";
        if (restartError.contains("stop_failed")) return "电脑上的 Codex 未能退出，自动重启未完成。";
        if (restartError.contains("start_failed") || restartError.contains("activation_failed"))
            return "电脑上的 Codex 未能重新启动，请在电脑上手动打开 Codex。";
        if (restartError.contains("timeout")) return "等待电脑上的 Codex 重启超时。";
        if (restartStatus.equals("unknown")) return "暂时无法确认电脑上的 Codex 是否已重启。";
        return "电脑上的 Codex 自动重启未完成。";
    }

    private void pollLogin() {
        if (!foreground || !isShowing() || loginId.isEmpty()) return;
        if (!pendingAction.isEmpty()) {
            scheduleLoginPoll(LOGIN_POLL_MS);
            return;
        }
        request("account.login.status", loginPayload());
    }

    private void cancelLogin() {
        if (!isShowing() || loginId.isEmpty()) return;
        handler.removeCallbacks(loginPoll);
        cancelRequested = true;
        sheet.setBusy(true, "正在取消…");
        if (pendingAction.isEmpty()) request("account.login.cancel", loginPayload());
    }

    private void scheduleLoginPoll(long delay) {
        handler.removeCallbacks(loginPoll);
        if (foreground && isShowing() && !loginId.isEmpty()) handler.postDelayed(loginPoll, delay);
    }

    private void request(String action, JSONObject payload) {
        if (!isShowing() || !pendingAction.isEmpty()) return;
        pendingAction = action;
        if (!action.equals("account.login.status") && !action.equals("account.desktop.restart.status"))
            sheet.setBusy(true, action.equals("account.desktop.restart") ? "正在重启…" : "正在处理…");
        try {
            sender.send(action, payload);
        } catch (RuntimeException error) {
            pendingAction = "";
            sheet.setBusy(false, "");
            if (action.equals("account.desktop.restart") || action.equals("account.desktop.restart.status")) {
                restartStatus = "unknown";
                restartError = "desktop_restart_status_unavailable";
                handler.removeCallbacks(restartPoll);
                showAccounts(accountData);
            } else {
                sheet.setError("请求未发出，请检查电脑连接后重试。");
            }
        }
    }

    private JSONObject loginPayload() {
        JSONObject payload = new JSONObject();
        try {
            payload.put("loginId", loginId);
        } catch (JSONException ignored) {
            // loginId is always a non-null in-memory string.
        }
        return payload;
    }

    private static JSONObject listPayload() {
        JSONObject payload = new JSONObject();
        try {
            payload.put("refreshWorkspaceMetadata", true);
        } catch (JSONException ignored) {
            // The key and boolean value are fixed valid JSON fields.
        }
        return payload;
    }

    private void clearLogin() {
        handler.removeCallbacks(loginPoll);
        loginId = "";
        loginCode = "";
        loginUrl = null;
        cancelRequested = false;
    }

    private void dismissConfirmation() {
        if (confirmation == null) return;
        confirmation.dismiss();
        confirmation = null;
    }

    private boolean isShowing() {
        return sheet != null && sheet.dialog.isShowing() && !activity.isFinishing() && !activity.isDestroyed();
    }

    private static Uri verificationUrl(String value) {
        Uri url = Uri.parse(value);
        if (!"https".equals(url.getScheme()) || !"auth.openai.com".equalsIgnoreCase(url.getHost())
                || url.getUserInfo() != null || url.getPort() != -1 && url.getPort() != 443
                || !"/codex/device".equals(url.getPath()) || url.getQuery() != null || url.getFragment() != null) return null;
        return url;
    }

    private static String displayText(String value) {
        String text = value == null ? "" : value.trim();
        return text.length() <= 180 ? text : text.substring(0, 180);
    }

    private static String jsonString(JSONObject value, String key) {
        Object field = value.opt(key);
        return field instanceof String ? (String) field : "";
    }

    private static String workspaceKindName(String value) {
        if (value.equalsIgnoreCase("personal")) return "个人工作区";
        if (value.equalsIgnoreCase("workspace") || value.equalsIgnoreCase("team")) return "团队工作区";
        if (value.equalsIgnoreCase("business")) return "Business 工作区";
        if (value.equalsIgnoreCase("enterprise")) return "企业工作区";
        return "工作区";
    }

    private static String planName(String value) {
        switch (value.toLowerCase(java.util.Locale.ROOT)) {
            case "pro": return "Pro";
            case "plus": return "Plus";
            case "free": return "Free";
            case "team": return "Business（团队）";
            case "business": return "Business";
            case "enterprise": return "Enterprise";
            case "edu": return "Edu";
            default: return displayText(value);
        }
    }

    private static String friendlyError(String value) {
        String error = value == null ? "" : value.toLowerCase(java.util.Locale.ROOT);
        if (error.contains("desktop_restart_unsupported") || error.contains("desktop_restart_failed"))
            return "请在电脑上退出 Codex 后重新打开，应用已保存的账号选择。";
        if (error.contains("operation_in_progress")) return "账号操作正在进行，请稍后重试。";
        if (error.contains("owned_by_other_device"))
            return "另一台已配对设备正在处理登录，请在那台设备上完成或取消。";
        if (error.contains("list_unavailable")) return "电脑暂时无法读取已登录账号，请稍后刷新。";
        if (error.contains("selection_not_available"))
            return "所选账号或工作区已不可用，请刷新账号列表后重新选择。";
        if (error.contains("login_stale")) return "这次登录已失效，请重新发起登录。";
        if (error.contains("unsupported") || error.contains("method not found") || error.contains("unknown action"))
            return "当前电脑上的 Codex 版本暂不支持账号管理，请更新 Codex 后重试。";
        if (error.contains("busy") || error.contains("active_turn"))
            return "电脑上的任务正在运行，请等待任务结束后再切换。";
        if (error.contains("reauth") || error.contains("sso") || error.contains("browser"))
            return "这个账号需要重新验证，请选择“登录其他账号”完成登录。";
        if (error.contains("timeout")) return "电脑响应超时，请检查连接后重试。";
        if (error.contains("expired")) return "登录验证码已过期，请重新登录账号。";
        return "账号操作未完成，请检查电脑连接后重试。";
    }

    private static final class AccountChoice {
        final String sessionId;
        final String accountId;
        final String title;
        final String detail;
        final boolean current;

        AccountChoice(String sessionId, String accountId, String title, String detail, boolean current) {
            this.sessionId = sessionId;
            this.accountId = accountId;
            this.title = title;
            this.detail = detail;
            this.current = current;
        }
    }
}
