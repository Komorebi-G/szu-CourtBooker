package cn.szucourt.booker;

import org.junit.Test;
import static org.junit.Assert.*;

public class CourtExecutionGateTest {
    @Test public void stoppedTokenCannotBeReenabledByLateStartup() {
        CourtExecutionGate gate = new CourtExecutionGate();
        gate.disable("old");
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.enable("old"));
        gate.enable("new"); gate.check("new", null, 0);
    }
    @Test public void pauseAndResumeCannotReviveOldExecution() {
        CourtExecutionGate gate = new CourtExecutionGate(); gate.enable("old");
        gate.pause(); gate.resume();
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.enable("old"));
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.check("old", null, 0));
        gate.enable("new"); gate.check("new", null, 0);
    }
    @Test public void staleCleanupDoesNotStopNewExecution() {
        CourtExecutionGate gate = new CourtExecutionGate(); gate.enable("old"); gate.disable("old");
        gate.enable("new"); gate.disable("old"); gate.check("new", null, 0);
        assertTrue(gate.active());
    }
    @Test public void queuedRequestCannotStartAfterDeadline() {
        CourtExecutionGate gate = new CourtExecutionGate(); gate.enable("token");
        gate.check("token", 100L, 99);
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.check("token", 100L, 100));
    }
    @Test public void backgroundAndSecondExecutionAreRejected() {
        CourtExecutionGate gate = new CourtExecutionGate(); gate.enable("one");
        assertFalse(gate.canLogin());
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.enable("two"));
        gate.pause(); assertFalse(gate.canLogin());
        assertThrows(CourtExecutionGate.NotSent.class, () -> gate.enable("two"));
        gate.resume(); assertTrue(gate.canLogin()); gate.enable("two");
    }
}
