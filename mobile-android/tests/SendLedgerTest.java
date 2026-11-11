package local.codex.anywhere;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Standalone JVM regressions: no Android runtime, server or real messages involved. */
public final class SendLedgerTest {
    private static int assertions;

    public static void main(String[] args) {
        deliveryLifecycle();
        disconnectIsNotFailure();
        timeoutCanBeResolvedByHistory();
        baselineAndRepeatedText();
        scopesAreIndependent();
        confirmedIsTerminal();
        duplicateIdsDoNotDuplicateMessages();
        System.out.println("SendLedgerTest: " + assertions + " assertions passed");
    }

    private static void deliveryLifecycle() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry message = ledger.begin("a", "pc", "chat", " keep spacing \n", Collections.emptyList());
        equal("pending", message.state, "begin appears immediately");
        equal(" keep spacing \n", message.text, "original text is preserved");
        ledger.acknowledge("a");
        equal("receipt", message.state, "receipt does not claim accepted");
        ledger.succeed("a");
        equal("accepted", message.state, "success confirms delivery");
        ledger.acknowledge("a");
        equal("accepted", message.state, "late receipt cannot downgrade delivery");
        ledger.fail("a", "late timeout");
        equal("accepted", message.state, "late timeout cannot undo known delivery");
        SendLedger.Entry rejected = ledger.begin("b", "pc", "chat", "denied", null);
        ledger.fail("b", "not allowed");
        equal("failed", rejected.state, "explicit rejection is visible");
        equal("not allowed", rejected.detail, "failure detail remains visible");
        ledger.acknowledge("b");
        equal("failed", rejected.state, "late receipt cannot hide rejection");
    }

    private static void disconnectIsNotFailure() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry pending = ledger.begin("a", "pc", "chat", "one", null);
        SendLedger.Entry received = ledger.begin("b", "pc", "chat", "two", null);
        SendLedger.Entry accepted = ledger.begin("c", "pc", "chat", "three", null);
        SendLedger.Entry other = ledger.begin("d", "other", "chat", "four", null);
        ledger.acknowledge("b");
        ledger.succeed("c");
        ledger.disconnect("pc");
        equal("uncertain", pending.state, "disconnect leaves pending outcome uncertain");
        equal("uncertain", received.state, "receipt is not delivery confirmation");
        equal("accepted", accepted.state, "accepted delivery survives disconnect");
        equal("pending", other.state, "other device unaffected");
        ledger.acknowledge("a");
        equal("uncertain", pending.state, "late receipt is not a reconnect");
        ledger.reconcile("pc", "chat", users("new", "one"));
        equal("confirmed", pending.state, "history can resolve uncertain outcome");
        equal(3, ledger.entries("pc", "chat").size(), "disconnect retains all messages");
    }

    private static void baselineAndRepeatedText() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry first = ledger.begin("a", "pc", "chat", "same", Arrays.asList("old"));
        SendLedger.Entry second = ledger.begin("b", "pc", "chat", "same", Arrays.asList("old"));
        ledger.reconcile("pc", "chat", users("old", "same"));
        equal("pending", first.state, "old identical message cannot hide new send");
        equal("pending", second.state, "baseline applies to each send");
        ledger.reconcile("pc", "chat", Arrays.asList(
                new SendLedger.SeenUser("old", "same"),
                new SendLedger.SeenUser("new-one", "same"),
                new SendLedger.SeenUser("new-one", "same")));
        equal("confirmed", first.state, "first fresh row confirms first send");
        equal("pending", second.state, "duplicate remote ID cannot confirm second send");
        ledger.reconcile("pc", "chat", users("new-one", "same"));
        equal("pending", second.state, "reservation survives separate refreshes");
        ledger.reconcile("pc", "chat", users("new-two", "same"));
        equal("confirmed", second.state, "second send requires distinct fresh row");
        SendLedger.Entry noId = ledger.begin("c", "pc", "chat", "empty id", null);
        ledger.reconcile("pc", "chat", users("", "empty id"));
        equal("pending", noId.state, "missing stable ID cannot safely reconcile");
    }

    private static void timeoutCanBeResolvedByHistory() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry message = ledger.begin("a", "pc", "chat", "hello", null);
        ledger.uncertain("a", "result not confirmed");
        equal("uncertain", message.state, "timeout remains uncertain");
        equal("result not confirmed", message.detail, "timeout reason is retained");
        ledger.reconcile("pc", "chat", users("new", "hello"));
        equal("confirmed", message.state, "history can resolve timeout");
        ledger.uncertain("a", "late timeout");
        equal("confirmed", message.state, "late timeout cannot undo history");
        SendLedger.Entry accepted = ledger.begin("b", "pc", "chat", "two", null);
        ledger.succeed("b");
        ledger.uncertain("b", "late timeout");
        equal("accepted", accepted.state, "late timeout cannot undo acceptance");
    }

    private static void scopesAreIndependent() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry device = ledger.begin("a", "pc", "chat", "hello", null);
        ledger.reconcile("other", "chat", users("row", "hello"));
        ledger.reconcile("pc", "different-chat", users("row", "hello"));
        equal("pending", device.state, "other device/chat cannot confirm message");
        equal(0, ledger.entries("pc", "different-chat").size(), "entries filter by chat");
        equal(0, ledger.entries("other", "chat").size(), "entries filter by device");
        SendLedger.Entry other = ledger.begin("b", "other", "chat", "hello", null);
        ledger.reconcile("pc", "chat", users("row", "hello"));
        ledger.reconcile("other", "chat", users("row", "hello"));
        equal("confirmed", device.state, "first scope can use own row");
        equal("confirmed", other.state, "remote IDs are scoped, not global");
    }

    private static void confirmedIsTerminal() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry message = ledger.begin("a", "pc", "chat", "hello", null);
        ledger.reconcile("pc", "chat", users("remote", " hello "));
        equal("confirmed", message.state, "history may arrive before response");
        ledger.acknowledge("a");
        ledger.succeed("a");
        ledger.fail("a", "late error");
        ledger.disconnect("pc");
        equal("confirmed", message.state, "late callbacks cannot downgrade confirmed history");
        equal("", message.detail, "late error does not leak into confirmed presentation");
        ledger.acknowledge("unknown");
        ledger.succeed("unknown");
        ledger.fail("unknown", "irrelevant");
    }

    private static void duplicateIdsDoNotDuplicateMessages() {
        SendLedger ledger = new SendLedger();
        SendLedger.Entry first = ledger.begin("a", "pc", "chat", "hello", null);
        SendLedger.Entry same = ledger.begin("a", "pc", "chat", "hello", null);
        equal(true, first == same, "same request ID is idempotent");
        equal(1, ledger.entries("pc", "chat").size(), "same request does not duplicate bubble");
        boolean rejected = false;
        try { ledger.begin("a", "pc", "chat", "different", null); }
        catch (IllegalArgumentException expected) { rejected = true; }
        equal(true, rejected, "mismatched request ID reuse rejected");
    }

    private static List<SendLedger.SeenUser> users(String id, String text) {
        return Collections.singletonList(new SendLedger.SeenUser(id, text));
    }

    private static void equal(Object expected, Object actual, String reason) {
        assertions++;
        if (!expected.equals(actual)) throw new AssertionError(reason + ": expected " + expected + ", got " + actual);
    }
}
