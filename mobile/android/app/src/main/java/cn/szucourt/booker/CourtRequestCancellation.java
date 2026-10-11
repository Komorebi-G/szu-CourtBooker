package cn.szucourt.booker;

import okhttp3.Call;

/** Only attached to whitelisted read-only requests; never hides a booking result. */
final class CourtRequestCancellation {
    private boolean cancelled;
    private Call active;
    synchronized void cancel() { cancelled = true; if (active != null) active.cancel(); }
    synchronized void check() {
        if (cancelled) throw new CourtExecutionGate.NotSent("准备请求已取消，未发送后续查询");
    }
    synchronized void attach(Call call) { check(); active = call; }
    synchronized void detach(Call call) { if (active == call) active = null; }
}
