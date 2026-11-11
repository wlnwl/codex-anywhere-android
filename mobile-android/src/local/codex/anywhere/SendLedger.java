package local.codex.anywhere;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Delivery state for locally submitted messages. This class never sends requests.
 * A relay receipt is distinct from the connector accepting the instruction, and
 * both are distinct from finding the message in authoritative conversation history.
 */
final class SendLedger {
    static final String PENDING = "pending";
    static final String RECEIPT = "receipt";
    static final String ACCEPTED = "accepted";
    static final String FAILED = "failed";
    static final String UNCERTAIN = "uncertain";
    static final String CONFIRMED = "confirmed";

    static final class Entry {
        final String id;
        final String deviceId;
        final String threadId;
        final String text;
        String state = PENDING;
        String detail = "";
        private final Set<String> baselineUserIds;

        private Entry(String id, String deviceId, String threadId, String text,
                      Collection<String> baselineUserIds) {
            this.id = id;
            this.deviceId = deviceId;
            this.threadId = threadId;
            this.text = text;
            this.baselineUserIds = new HashSet<>();
            if (baselineUserIds != null) {
                for (String userId : baselineUserIds) {
                    if (userId != null && !userId.isEmpty()) this.baselineUserIds.add(userId);
                }
            }
        }
    }

    /** Root supplies only user-message rows, with stable authoritative row IDs. */
    static final class SeenUser {
        final String id;
        final String text;

        SeenUser(String id, String text) {
            this.id = id;
            this.text = text;
        }
    }

    private static final class Scope {
        final String deviceId;
        final String threadId;

        Scope(String deviceId, String threadId) {
            this.deviceId = deviceId;
            this.threadId = threadId;
        }

        @Override public boolean equals(Object other) {
            if (!(other instanceof Scope)) return false;
            Scope scope = (Scope) other;
            return Objects.equals(deviceId, scope.deviceId) && Objects.equals(threadId, scope.threadId);
        }

        @Override public int hashCode() {
            return Objects.hash(deviceId, threadId);
        }
    }

    private final Map<String, Entry> submissions = new LinkedHashMap<>();
    // Reservations survive history refresh/page changes: one remote row confirms one send.
    private final Map<Scope, Set<String>> consumedRemoteIds = new HashMap<>();

    synchronized Entry begin(String requestId, String deviceId, String threadId,
                             String text, Collection<String> baselineUserIds) {
        if (requestId == null || requestId.isEmpty()) throw new IllegalArgumentException("request_id_required");
        Objects.requireNonNull(deviceId, "deviceId");
        Objects.requireNonNull(threadId, "threadId");
        Objects.requireNonNull(text, "text");
        Entry existing = submissions.get(requestId);
        if (existing != null) {
            if (!existing.deviceId.equals(deviceId) || !existing.threadId.equals(threadId)
                    || !existing.text.equals(text)) {
                throw new IllegalArgumentException("request_id_reused");
            }
            return existing;
        }
        Entry entry = new Entry(requestId, deviceId, threadId, text, baselineUserIds);
        submissions.put(requestId, entry);
        return entry;
    }

    synchronized List<Entry> entries(String deviceId, String threadId) {
        List<Entry> result = new ArrayList<>();
        for (Entry entry : submissions.values()) {
            if (Objects.equals(entry.deviceId, deviceId) && Objects.equals(entry.threadId, threadId)) {
                result.add(entry);
            }
        }
        return Collections.unmodifiableList(result);
    }

    synchronized void acknowledge(String id) {
        Entry entry = submissions.get(id);
        if (entry != null && PENDING.equals(entry.state)) entry.state = RECEIPT;
    }

    synchronized void succeed(String id) {
        Entry entry = submissions.get(id);
        if (entry != null && !CONFIRMED.equals(entry.state)) {
            entry.state = ACCEPTED;
            entry.detail = "";
        }
    }

    synchronized void fail(String id, String reason) {
        Entry entry = submissions.get(id);
        // A later timeout/transport error cannot undo a known delivery or history match.
        if (entry != null && !CONFIRMED.equals(entry.state) && !ACCEPTED.equals(entry.state)) {
            entry.state = FAILED;
            entry.detail = reason == null ? "" : reason;
        }
    }

    /** A timeout is not proof of rejection; authoritative history can still resolve it. */
    synchronized void uncertain(String id, String reason) {
        Entry entry = submissions.get(id);
        if (entry != null && !CONFIRMED.equals(entry.state) && !ACCEPTED.equals(entry.state)
                && !FAILED.equals(entry.state)) {
            entry.state = UNCERTAIN;
            entry.detail = reason == null ? "" : reason;
        }
    }

    synchronized void disconnect(String deviceId) {
        for (Entry entry : submissions.values()) {
            if (Objects.equals(entry.deviceId, deviceId)
                    && (PENDING.equals(entry.state) || RECEIPT.equals(entry.state))) {
                entry.state = UNCERTAIN;
                entry.detail = "";
            }
        }
    }

    /**
     * Reconcile chronological user rows against local submissions in submission order.
     * Previously visible IDs are excluded even if their text equals a new instruction.
     * Matching a remote row changes only presentation state; it never triggers a send.
     */
    synchronized void reconcile(String deviceId, String threadId, List<SeenUser> remoteUsers) {
        if (remoteUsers == null || remoteUsers.isEmpty()) return;
        Scope scope = new Scope(deviceId, threadId);
        Set<String> consumed = consumedRemoteIds.get(scope);
        if (consumed == null) {
            consumed = new HashSet<>();
            consumedRemoteIds.put(scope, consumed);
        }
        for (Entry entry : submissions.values()) {
            if (!Objects.equals(entry.deviceId, deviceId) || !Objects.equals(entry.threadId, threadId)
                    || CONFIRMED.equals(entry.state) || FAILED.equals(entry.state)) continue;
            for (SeenUser remote : remoteUsers) {
                if (remote == null || remote.id == null || remote.id.isEmpty() || remote.text == null
                        || consumed.contains(remote.id) || entry.baselineUserIds.contains(remote.id)
                        || !entry.text.trim().equals(remote.text.trim())) continue;
                consumed.add(remote.id);
                entry.state = CONFIRMED;
                entry.detail = "";
                break;
            }
        }
    }
}
