package local.codex.anywhere;

import org.json.JSONObject;
import java.util.List;

public final class ConversationHistoryTest {
    public static void main(String[] args) throws Exception {
        JSONObject snapshot = new JSONObject("{\"turns\":["
                + "{\"id\":\"new\",\"items\":[{\"type\":\"userMessage\",\"text\":\"same\"},"
                + "{\"type\":\"agentMessage\",\"text\":\"new reply\",\"content\":[{\"type\":\"text\",\"text\":\"duplicate\"}]}]},"
                + "{\"id\":\"old\",\"items\":[{\"type\":\"userMessage\",\"text\":\"same\"},"
                + "{\"type\":\"agentMessage\",\"text\":\"old reply\"},"
                + "{\"type\":\"commandExecution\",\"output\":\"private tool output\"}]}]}");
        List<ConversationHistory.Message> rows = ConversationHistory.parse(snapshot);
        check(rows.size() == 4, "only conversation text, without duplicate fields or tool JSON");
        check(rows.get(1).text.equals("old reply") && rows.get(3).text.equals("new reply"), "descending turns become chronological");
        check(rows.get(0).kind.equals("user") && rows.get(1).kind.equals("assistant"), "message roles");
        check(!rows.get(0).id.equals(rows.get(2).id), "same user text in different turns remains distinct");
        List<ConversationHistory.Message> repeated = ConversationHistory.parse(snapshot);
        check(rows.get(0).id.equals(repeated.get(0).id), "stable snapshot IDs");
        JSONObject expanded = new JSONObject(snapshot.toString());
        expanded.getJSONArray("turns").getJSONObject(0).getJSONArray("items").put(new JSONObject("{\"type\":\"agentMessage\",\"text\":\"later reply\"}"));
        check(rows.get(2).id.equals(ConversationHistory.parse(expanded).get(2).id), "adding assistant output preserves user identity");
        JSONObject legacy = new JSONObject("{\"thread\":{\"turns\":[{\"id\":\"legacy\",\"items\":["
                + "{\"type\":\"userMessage\",\"content\":[{\"type\":\"input_text\",\"text\":\"part one\"},{\"type\":\"image\",\"url\":\"secret\"},{\"type\":\"text\",\"text\":\"part two\"}]},"
                + "{\"type\":\"assistantMessage\",\"content\":[{\"type\":\"text\",\"text\":\"legacy reply\"}]}]}]}}");
        List<ConversationHistory.Message> legacyRows = ConversationHistory.parse(legacy);
        check(legacyRows.size() == 2 && legacyRows.get(0).text.equals("part one\npart two"), "legacy text-only content");
        check(ConversationHistory.parse(new JSONObject()).isEmpty(), "missing turns");
        check(ConversationHistory.parse(new JSONObject("{\"turns\":[null,{}, {\"items\":[null,{}, {\"type\":\"agentMessage\",\"text\":\"\"}]}]}")).isEmpty(), "malformed/empty items");
        JSONObject rollout = new JSONObject("{\"turns\":[{\"id\":\"rollout:t:0:100\",\"items\":[{\"type\":\"userMessage\",\"text\":\"rollout user\",\"completedAt\":100}]}]}");
        String rolloutId = ConversationHistory.parse(rollout).get(0).id;
        rollout.getJSONArray("turns").getJSONObject(0).put("id", "rollout:t:20:200");
        check(rolloutId.equals(ConversationHistory.parse(rollout).get(0).id), "rollout window byte offsets don't churn IDs");
        System.out.println("ConversationHistoryTest: all checks passed");
    }

    static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
