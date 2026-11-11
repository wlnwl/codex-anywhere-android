package local.codex.anywhere;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Reads the connector's session snapshot; does not render arbitrary JSON fields. */
final class ConversationHistory {
    static final class Message {
        final String id;
        final String kind;
        final String text;

        Message(String id, String kind, String text) {
            this.id = id;
            this.kind = kind;
            this.text = text;
        }
    }

    static List<Message> parse(JSONObject sessionData) {
        List<Message> rows = new ArrayList<>();
        if (sessionData == null) return rows;
        JSONObject container = sessionData;
        JSONArray turns = container.optJSONArray("turns");
        if (turns == null && container.optJSONObject("thread") != null) {
            container = container.optJSONObject("thread");
            turns = container.optJSONArray("turns");
        }
        if (turns == null && sessionData.optJSONObject("history") != null) {
            turns = sessionData.optJSONObject("history").optJSONArray("turns");
        }
        if (turns == null) return rows;
        Map<String, Integer> occurrences = new HashMap<>();
        // session.read uses thread/turns/list with sortDirection=desc. The
        // upstream web historyItems() reverses turns, but never each turn's items.
        for (int turnIndex = turns.length() - 1; turnIndex >= 0; turnIndex--) {
            JSONObject turn = turns.optJSONObject(turnIndex);
            if (turn == null) continue;
            JSONArray items = turn.optJSONArray("items");
            if (items == null) continue;
            for (int itemIndex = 0; itemIndex < items.length(); itemIndex++) {
                JSONObject item = items.optJSONObject(itemIndex);
                if (item == null) continue;
                String kind = messageKind(item);
                if (kind == null) continue;
                String text = messageText(item);
                if (text.trim().isEmpty()) continue;
                String explicit = string(item, "id");
                String turnId = string(item, "turnId");
                if (turnId.isEmpty()) turnId = string(turn, "id");
                // Rollout page identifiers include byte offsets and change as the
                // file grows. Stable item turn IDs/timestamps take precedence.
                if (turnId.startsWith("rollout:") || turnId.startsWith("tail:")) turnId = "";
                String timestamp = string(item, "completedAt");
                if (timestamp.isEmpty()) timestamp = string(item, "timestamp");
                if (timestamp.isEmpty()) timestamp = string(item, "createdAt");
                String key = !explicit.isEmpty() ? "item:" + explicit
                        : "message:" + turnId + ":" + kind + ":" + timestamp + ":" + digest(text);
                int occurrence = occurrences.containsKey(key) ? occurrences.get(key) + 1 : 1;
                occurrences.put(key, occurrence);
                rows.add(new Message(key + ":" + occurrence, kind, text));
            }
        }
        return rows;
    }

    private static String messageKind(JSONObject item) {
        String type = string(item, "type").toLowerCase(Locale.ROOT);
        String role = string(item, "role").toLowerCase(Locale.ROOT);
        if (type.contains("user") || role.equals("user")) return "user";
        if (type.contains("agentmessage") || type.contains("assistant") || role.equals("assistant")) return "assistant";
        if (type.equals("reasoning") || type.equals("progress")) return "progress";
        if (type.equals("systemmessage") || type.equals("system") || role.equals("system")) return "system";
        return null;
    }

    private static String messageText(JSONObject item) {
        // Normalized text already contains parsed user content. Never combine
        // it with legacy content/input and duplicate the same message.
        Object normalized = item.opt("text");
        if (normalized instanceof String && !((String) normalized).trim().isEmpty()) return (String) normalized;
        String content = contentText(item.opt("content"));
        if (!content.trim().isEmpty()) return content;
        return contentText(item.opt("input"));
    }

    private static String contentText(Object content) {
        if (content instanceof String) return (String) content;
        if (content instanceof JSONObject) {
            Object text = ((JSONObject) content).opt("text");
            return text instanceof String ? (String) text : "";
        }
        if (!(content instanceof JSONArray)) return "";
        JSONArray pieces = (JSONArray) content;
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < pieces.length(); i++) {
            Object piece = pieces.opt(i);
            String text = "";
            if (piece instanceof String) text = (String) piece;
            else if (piece instanceof JSONObject) {
                JSONObject object = (JSONObject) piece;
                String type = string(object, "type").toLowerCase(Locale.ROOT);
                if (type.isEmpty() || type.contains("text")) {
                    Object value = object.opt("text");
                    if (value instanceof String) text = (String) value;
                }
            }
            if (text.isEmpty()) continue;
            if (joined.length() > 0) joined.append('\n');
            joined.append(text);
        }
        return joined.toString();
    }

    private static String string(JSONObject object, String key) {
        Object value = object.opt(key);
        return value == null || value == JSONObject.NULL ? "" : String.valueOf(value);
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 12; i++) out.append(String.format(Locale.ROOT, "%02x", bytes[i] & 255));
            return out.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
