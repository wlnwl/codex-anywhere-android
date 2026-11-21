package local.codex.anywhere;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Local system notifications for events from the paired device's secure channel. */
final class TaskNotifications {
    static final String OPEN_ACTION = "local.codex.anywhere.OPEN_TASK_NOTIFICATION";
    static final int PERMISSION_REQUEST = 62;
    private static final String URI_SCHEME = "codex-anywhere-notification";
    private static final String RESULTS = "task_results_v1";
    private static final String ATTENTION = "task_attention_v1";
    private static final String DEVICES = "device_status_v1";
    private static final String RECORDS = "recent";
    private static final int MAX_RECORDS = 128;
    private static final int NOTIFICATION_ID = 1;

    static final class Target {
        final String relay, device, thread;

        Target(String relay, String device, String thread) {
            this.relay = relay;
            this.device = device;
            this.thread = thread;
        }
    }

    private final Activity activity;
    private final NotificationManager manager;
    private final SharedPreferences prefs;

    TaskNotifications(Activity activity) {
        this.activity = activity;
        manager = activity.getSystemService(NotificationManager.class);
        prefs = activity.getSharedPreferences("task_notifications", Context.MODE_PRIVATE);
    }

    boolean isEnabled() {
        return prefs.getBoolean("enabled", false);
    }

    boolean canNotify() {
        return isEnabled() && hasSystemPermission();
    }

    private boolean hasSystemPermission() {
        return (Build.VERSION.SDK_INT < 33 || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) && manager.areNotificationsEnabled();
    }

    void setEnabled(boolean enabled) {
        prefs.edit().putBoolean("enabled", enabled).apply();
        if (!enabled) {
            clear();
        } else if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_REQUEST);
        }
    }

    boolean onPermissionResult(int requestCode, int[] results) {
        if (requestCode != PERMISSION_REQUEST) return false;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED && isEnabled()) createChannels();
        return true;
    }

    String statusText() {
        if (!isEnabled()) return "通知已关闭";
        if (!hasSystemPermission()) return "系统未允许通知";
        return "通知已开启";
    }

    void openSystemSettings() {
        activity.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()));
    }

    private void createChannels() {
        createChannel(RESULTS, "任务结果", "任务完成或失败", NotificationManager.IMPORTANCE_DEFAULT);
        createChannel(ATTENTION, "需要处理", "任务等待审批或输入", NotificationManager.IMPORTANCE_HIGH);
        createChannel(DEVICES, "电脑状态", "已连接的电脑离线", NotificationManager.IMPORTANCE_LOW);
    }

    private void createChannel(String id, String name, String description, int importance) {
        if (manager.getNotificationChannel(id) != null) return;
        NotificationChannel channel = new NotificationChannel(id, name, importance);
        channel.setDescription(description);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        manager.createNotificationChannel(channel);
    }

    void publish(String relay, String device, String thread, String eventId, String kind) {
        if (!canNotify() || relay.isEmpty() || device.isEmpty() || eventId.isEmpty()) return;
        final String title, message, channel;
        switch (kind) {
            case "completed": title = "Codex 任务已完成"; message = "打开应用查看结果"; channel = RESULTS; break;
            case "failed": title = "Codex 任务未完成"; message = "打开应用查看失败原因"; channel = RESULTS; break;
            case "approval": title = "Codex 正在等待审批"; message = "打开应用查看并处理"; channel = ATTENTION; break;
            case "input": title = "Codex 正在等待输入"; message = "打开应用查看并回复"; channel = ATTENTION; break;
            case "offline": title = "电脑已离线"; message = "打开应用查看连接状态"; channel = DEVICES; break;
            default: return;
        }

        final String group = "device-" + digest(relay, device);
        final String tag = "event-" + digest(relay, device, thread, kind, eventId);
        JSONArray existing = loadRecords();
        for (int index = 0; index < existing.length(); index++) {
            JSONObject item = existing.optJSONObject(index);
            if (item != null && tag.equals(item.optString("tag"))) return;
        }

        createChannels();
        if (manager.getNotificationChannel(channel).getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        String token = UUID.randomUUID().toString();
        JSONObject record = new JSONObject();
        try {
            record.put("relay", relay).put("device", device).put("thread", thread)
                    .put("token", token).put("tag", tag).put("group", group);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }

        PendingIntent tap = openIntent(token);
        Notification notification = base(channel, group, tap).setContentTitle(title).setContentText(message)
                .setAutoCancel(true).setOnlyAlertOnce(true).build();
        try {
            manager.notify(tag, NOTIFICATION_ID, notification);
        } catch (SecurityException denied) {
            // Permission may have been revoked since the preflight check.
            return;
        }

        JSONArray retained = new JSONArray();
        Set<String> evictedGroups = new LinkedHashSet<>(), retainedGroups = new LinkedHashSet<>();
        for (int index = 0; index < existing.length(); index++) {
            JSONObject item = existing.optJSONObject(index);
            if (item == null) continue;
            String itemGroup = item.optString("group");
            if (index < existing.length() - MAX_RECORDS + 1) {
                manager.cancel(item.optString("tag"), NOTIFICATION_ID);
                evictedGroups.add(itemGroup);
            } else {
                retained.put(item);
                retainedGroups.add(itemGroup);
            }
        }
        retained.put(record);
        retainedGroups.add(group);
        persist(retained);
        for (String evicted : evictedGroups) if (!retainedGroups.contains(evicted)) manager.cancel(evicted, NOTIFICATION_ID);

        try {
            Notification summary = base(DEVICES, group, tap).setContentTitle("Codex Anywhere")
                    .setContentText("打开应用查看任务动态").setGroupSummary(true).setAutoCancel(true)
                    .setOnlyAlertOnce(true).build();
            manager.notify(group, NOTIFICATION_ID, summary);
        } catch (SecurityException denied) {
            // The child remains independently actionable if Android allows it.
        }
    }

    private Notification.Builder base(String channel, String group, PendingIntent tap) {
        return new Notification.Builder(activity, channel)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .setContentIntent(tap)
                .setGroup(group)
                .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN);
    }

    private PendingIntent openIntent(String token) {
        Intent open = new Intent(activity, MainActivity.class).setAction(OPEN_ACTION)
                .setData(Uri.fromParts(URI_SCHEME, token, null))
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(activity, 0, open, PendingIntent.FLAG_IMMUTABLE);
    }

    Target readTarget(Intent intent) {
        if (!isEnabled() || intent == null || !OPEN_ACTION.equals(intent.getAction())) return null;
        Uri data = intent.getData();
        if (data == null || !URI_SCHEME.equals(data.getScheme())) return null;
        String token = data.getSchemeSpecificPart();
        if (token == null || token.length() != 36) return null;

        JSONArray records = loadRecords();
        for (int index = records.length() - 1; index >= 0; index--) {
            JSONObject item = records.optJSONObject(index);
            if (item != null && token.equals(item.optString("token"))) {
                return new Target(item.optString("relay"), item.optString("device"), item.optString("thread"));
            }
        }
        return null;
    }

    void clearDevice(String relay, String device) {
        String group = "device-" + digest(relay, device);
        JSONArray existing = loadRecords(), retained = new JSONArray();
        for (int index = 0; index < existing.length(); index++) {
            JSONObject item = existing.optJSONObject(index);
            if (item == null) continue;
            if (group.equals(item.optString("group"))) manager.cancel(item.optString("tag"), NOTIFICATION_ID);
            else retained.put(item);
        }
        manager.cancel(group, NOTIFICATION_ID);
        persist(retained);
    }

    void retainAuthorizedDevices(String relay, Set<String> authorized) {
        Set<String> removed = new LinkedHashSet<>();
        JSONArray records = loadRecords();
        for (int index = 0; index < records.length(); index++) {
            JSONObject item = records.optJSONObject(index);
            if (item == null || !relay.equals(item.optString("relay"))) continue;
            String device = item.optString("device");
            if (!authorized.contains(device)) removed.add(device);
        }
        for (String device : removed) clearDevice(relay, device);
    }

    void clear() {
        JSONArray records = loadRecords();
        Set<String> groups = new LinkedHashSet<>();
        for (int index = 0; index < records.length(); index++) {
            JSONObject item = records.optJSONObject(index);
            if (item == null) continue;
            manager.cancel(item.optString("tag"), NOTIFICATION_ID);
            groups.add(item.optString("group"));
        }
        for (String group : groups) manager.cancel(group, NOTIFICATION_ID);
        prefs.edit().remove(RECORDS).apply();
    }

    private JSONArray loadRecords() {
        try {
            return new JSONArray(prefs.getString(RECORDS, "[]"));
        } catch (JSONException corrupt) {
            return new JSONArray();
        }
    }

    private void persist(JSONArray records) {
        prefs.edit().putString(RECORDS, records.toString()).apply();
    }

    private static String digest(String... values) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // Encode the part boundaries too, so two different tuples cannot share a key.
            for (String value : values) {
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                int length = bytes.length;
                digest.update((byte) (length >>> 24));
                digest.update((byte) (length >>> 16));
                digest.update((byte) (length >>> 8));
                digest.update((byte) length);
                digest.update(bytes);
            }
            return android.util.Base64.encodeToString(digest.digest(), android.util.Base64.URL_SAFE
                    | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
