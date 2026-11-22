package local.codex.anywhere;

import android.view.View;
import android.widget.Button;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Locale;

/** The model editor and summary follow the currently selected computer and thread. */
final class ModelUi {
    interface Sender { String send(String action, JSONObject payload); }

    static final String READ = "session.model-config.read";
    static final String UPDATE = "session.model-config.update";

    private final DialogUi ui;
    private final Sender sender;
    private final Button summary;
    private DialogUi.Sheet sheet;
    private JSONObject config;
    private String threadId = "";
    private String requestId;
    private String model = "";
    private String effort = "";
    private boolean fast;
    private boolean updating;
    private boolean choosingModel;

    ModelUi(DialogUi ui, Sender sender, Button summary) {
        this.ui = ui;
        this.sender = sender;
        this.summary = summary;
        updateSummary();
    }

    void select(String selectedThread, boolean connected) {
        dismiss();
        threadId = connected ? selectedThread : "";
        requestId = null;
        config = null;
        updating = false;
        updateSummary();
        if (!threadId.isEmpty()) read();
    }

    void open() {
        if (threadId.isEmpty() || sheet != null) return;
        sheet = ui.create("当前会话", "模型与思考强度", null);
        DialogUi.Sheet current = sheet;
        current.dialog.setOnDismissListener(dialog -> { if (sheet == current) sheet = null; });
        current.setSecondary("关闭", current::dismiss);
        resetDraft();
        current.show();
        if (config == null) read();
        render();
    }

    boolean isUpdating() { return updating; }

    void ensureSelected(String selectedThread) {
        if (!threadId.equals(selectedThread)) select(selectedThread, true);
    }

    void handle(String id, boolean ok, JSONObject data, String error) {
        if (requestId == null || !requestId.equals(id)) return;
        requestId = null;
        boolean wasUpdate = updating;
        updating = false;
        if (ok && data != null) {
            config = data;
            resetDraft();
            if (wasUpdate) dismiss();
        }
        updateSummary();
        render();
        if (sheet != null) sheet.setError(ok && data != null ? "" : errorText(error, wasUpdate));
    }

    private void read() {
        if (threadId.isEmpty() || requestId != null) return;
        request(READ, null);
    }

    private void save() {
        if (config == null || config.optBoolean("readOnly") || requestId != null) return;
        JSONObject option = findModel(model);
        if (option == null || !supportsEffort(option, effort)) return;
        try {
            JSONObject payload = new JSONObject().put("model", model).put("reasoningEffort", effort)
                    .put("fastMode", fast && fastAvailable(option));
            request(UPDATE, payload);
        } catch (JSONException error) {
            if (sheet != null) sheet.setError("无法准备模型设置，请重新选择后重试。");
        }
    }

    private void request(String action, JSONObject payload) {
        boolean save = UPDATE.equals(action);
        try {
            JSONObject params = (payload == null ? new JSONObject() : payload).put("threadId", threadId);
            requestId = sender.send(action, params);
        } catch (JSONException | RuntimeException error) {
            requestId = null;
        }
        updating = save && requestId != null;
        updateSummary();
        render();
        if (sheet != null) sheet.setError(requestId == null ? errorText("", save) : "");
    }

    private void dismiss() {
        if (sheet != null) sheet.dismiss();
        sheet = null;
    }

    private void resetDraft() {
        choosingModel = false;
        model = value(config, "model");
        JSONObject option = findModel(model);
        if (option == null && config != null && !config.optBoolean("readOnly")) {
            option = defaultModel();
            model = value(option, "model");
        }
        effort = chooseEffort(option, value(config, "reasoningEffort"));
        fast = config != null && config.optBoolean("fastMode") && fastAvailable(option);
    }

    private void updateSummary() {
        summary.setVisibility(threadId.isEmpty() ? View.GONE : View.VISIBLE);
        if (config == null) {
            summary.setText(requestId == null ? "模型与思考强度 ▾" : "正在读取模型…");
            return;
        }
        String id = value(config, "model");
        String title = modelName(findModel(id), id);
        String reasoning = value(config, "reasoningEffort");
        summary.setText(title + (reasoning.isEmpty() ? "" : " · " + effortName(reasoning))
                + (config.optBoolean("fastMode") ? " · 快速" : "") + " ▾");
    }

    private void render() {
        if (sheet == null) return;
        sheet.content.removeAllViews();
        sheet.setBusy(updating, "正在保存…");
        JSONObject option = findModel(model);
        if (config == null || config.optBoolean("readOnly") || option == null) {
            String current = value(config, "model");
            if (!current.isEmpty()) {
                String reasoning = value(config, "reasoningEffort");
                sheet.content.addView(ui.label(modelName(findModel(current), current)
                        + (reasoning.isEmpty() ? "" : " · " + effortName(reasoning))));
            }
            sheet.content.addView(ui.label(requestId != null ? "正在读取模型设置…"
                    : config != null && config.optBoolean("readOnly") ? "当前只读取到了已保存的模型设置。"
                    : "暂时无法读取可选模型。"));
            sheet.setPrimary("重新读取", this::read);
            sheet.setPrimaryEnabled(requestId == null);
            return;
        }
        if (choosingModel) {
            sheet.content.addView(ui.label("选择模型"));
            JSONArray available = config.optJSONArray("models");
            for (int i = 0; i < available.length(); i++) {
                JSONObject candidate = available.optJSONObject(i);
                String id = value(candidate, "model");
                if (id.isEmpty()) continue;
                sheet.content.addView(ui.actionCard(modelName(candidate, id), value(candidate, "description"),
                        id.equals(model), () -> {
                            model = id;
                            effort = chooseEffort(candidate, effort);
                            fast = fast && fastAvailable(candidate);
                            choosingModel = false;
                            render();
                        }));
            }
            sheet.setPrimary("返回", () -> { choosingModel = false; render(); });
            sheet.setPrimaryEnabled(true);
            return;
        }
        if (isDesktopTool()) sheet.content.addView(ui.label("模型和思考强度会在下一次兼容发送时应用。"));
        sheet.content.addView(ui.actionLink("模型 · " + modelName(option, model), null, () -> {
            if (requestId != null) return;
            choosingModel = true;
            render();
        }));
        JSONArray options = option.optJSONArray("supportedReasoningEfforts");
        if (options != null && options.length() > 0) {
            sheet.content.addView(ui.label("思考强度"));
            for (int i = 0; i < options.length(); i++) {
                JSONObject candidate = options.optJSONObject(i);
                String id = value(candidate, "reasoningEffort");
                if (id.isEmpty()) continue;
                sheet.content.addView(ui.actionCard(effortName(id), value(candidate, "description"), id.equals(effort), () -> {
                    if (requestId != null) return;
                    effort = id;
                    render();
                }));
            }
        }
        if (fastAvailable(option)) {
            sheet.content.addView(ui.actionLink("快速模式 · " + (fast ? "开启" : "关闭"), null, () -> {
                if (requestId != null) return;
                fast = !fast;
                render();
            }));
        }
        sheet.content.addView(ui.actionLink("重新读取设置", null, this::read));
        sheet.setPrimary("保存", this::save);
        sheet.setPrimaryEnabled(requestId == null && supportsEffort(option, effort));
    }

    private JSONObject findModel(String id) {
        JSONArray options = config == null ? null : config.optJSONArray("models");
        if (options == null || id.isEmpty()) return null;
        for (int i = 0; i < options.length(); i++) {
            JSONObject item = options.optJSONObject(i);
            if (id.equals(value(item, "model"))) return item;
        }
        return null;
    }

    private JSONObject defaultModel() {
        JSONArray options = config.optJSONArray("models");
        if (options == null) return null;
        JSONObject first = null;
        for (int i = 0; i < options.length(); i++) {
            JSONObject item = options.optJSONObject(i);
            if (value(item, "model").isEmpty()) continue;
            if (item.optBoolean("isDefault")) return item;
            if (first == null) first = item;
        }
        return first;
    }

    private boolean isDesktopTool() { return "desktop_tool".equals(value(config, "source")); }

    private boolean fastAvailable(JSONObject option) {
        if (isDesktopTool() || option == null) return false;
        JSONArray tiers = option.optJSONArray("serviceTiers");
        if (tiers == null) return false;
        for (int i = 0; i < tiers.length(); i++) {
            JSONObject tier = tiers.optJSONObject(i);
            String name = (value(tier, "id") + " " + value(tier, "name")).toLowerCase(Locale.ROOT);
            if (name.contains("fast") || name.contains("priority")) return true;
        }
        return false;
    }

    private static String chooseEffort(JSONObject option, String preferred) {
        if (supportsEffort(option, preferred)) return preferred;
        String standard = value(option, "defaultReasoningEffort");
        if (supportsEffort(option, standard)) return standard;
        JSONArray efforts = option == null ? null : option.optJSONArray("supportedReasoningEfforts");
        return efforts == null ? "" : value(efforts.optJSONObject(0), "reasoningEffort");
    }

    private static boolean supportsEffort(JSONObject option, String id) {
        JSONArray efforts = option == null ? null : option.optJSONArray("supportedReasoningEfforts");
        if (efforts == null || id.isEmpty()) return false;
        for (int i = 0; i < efforts.length(); i++) {
            if (id.equals(value(efforts.optJSONObject(i), "reasoningEffort"))) return true;
        }
        return false;
    }

    private static String modelName(JSONObject model, String id) {
        String name = value(model, "displayName");
        return name.isEmpty() ? (id.isEmpty() ? "模型与思考强度" : id) : name;
    }

    private static String value(JSONObject source, String key) {
        Object field = source == null ? null : source.opt(key);
        return field instanceof String ? (String) field : "";
    }

    private static String effortName(String effort) {
        switch (effort) {
            case "none": return "无";
            case "minimal": return "最低";
            case "low": return "低";
            case "medium": return "中";
            case "high": return "高";
            case "xhigh": return "极高";
            case "max": return "最大";
            case "ultra": return "超强";
            default: return effort;
        }
    }

    private static String errorText(String error, boolean save) {
        if (error.contains("busy") || error.contains("active")) return "会话正在运行，请等这轮完成后再保存。";
        if (error.contains("not_available")) return "所选模型或思考强度已不可用，请重新读取设置。";
        if (error.contains("desktop_input")) return "电脑暂时无法确认模型设置，请重试。";
        return save ? "未能确认模型设置已保存，请重试。" : "暂时无法读取模型设置，请重试。";
    }
}
