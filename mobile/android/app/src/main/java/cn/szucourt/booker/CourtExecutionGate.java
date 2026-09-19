package cn.szucourt.booker;

/** State shared by the UI lifecycle and network worker threads. */
final class CourtExecutionGate {
    static final class NotSent extends IllegalStateException {
        NotSent(String message) { super(message); }
    }
    private boolean foreground = true;
    private String activeToken;
    private String invalidatedToken;

    synchronized boolean canLogin() { return foreground && activeToken == null; }
    synchronized void enable(String token) {
        if (!foreground || token == null || token.equals(invalidatedToken)
            || (activeToken != null && !activeToken.equals(token))) {
            throw new NotSent("本次执行已中断或已有任务，请重新执行");
        }
        activeToken = token;
    }
    synchronized void disable(String token) {
        // A late stop/finally from an older run must never disarm a newer run.
        if (token != null && (activeToken == null || token.equals(activeToken))) {
            invalidatedToken = token; activeToken = null;
        }
    }
    synchronized boolean active() { return activeToken != null; }
    synchronized void pause() {
        foreground = false;
        if (activeToken != null) invalidatedToken = activeToken;
        activeToken = null;
    }
    synchronized void resume() { foreground = true; }
    synchronized void check(String token, Long deadlineMs, long nowMs) {
        if (token != null && (!foreground || !token.equals(activeToken)))
            throw new NotSent("本次执行已中断，未发送请求");
        if (deadlineMs != null && nowMs >= deadlineMs)
            throw new NotSent("执行窗口已结束，未发送请求");
    }
}
