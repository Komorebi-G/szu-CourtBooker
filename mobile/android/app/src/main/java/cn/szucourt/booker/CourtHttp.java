package cn.szucourt.booker;

import java.io.IOException;
import java.util.Set;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.TimeUnit;
import okhttp3.ConnectionPool;
import okhttp3.Headers;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.MediaType;
import okio.BufferedSink;
import okhttp3.Response;
import okhttp3.Call;

/** Bounded retries only for known read-only endpoints (including query POSTs). */
final class CourtHttp {
    private static final String ROOT = "/qljfwapp/sys/lwSzuCgyy/";
    private static final Set<String> QUERY_POSTS = new HashSet<>(Arrays.asList(
        ROOT + "sportVenue/getSportVenueData.do", ROOT + "sportVenue/getRqList.do",
        ROOT + "sportVenue/getTimeList.do", ROOT + "modules/sportVenue/getOpeningRoom.do",
        ROOT + "modules/myBooking/myBookingInfo.do"));
    private final OkHttpClient client;

    CourtHttp(OkHttpClient client) { this.client = client; }
    static boolean isQuery(Request request) {
        return request.method().equals("GET") && request.url().encodedPath().equals(ROOT + "index.do")
            || request.method().equals("POST") && QUERY_POSTS.contains(request.url().encodedPath());
    }

    static final class Result {
        final int status;
        final Headers headers;
        final String body;
        final long networkStartedAt, networkEndedAt, networkDurationMs, dispatchPreparationMs;
        Result(Response response, String body, long startedAt, long durationMs, long preparationMs) {
            this.status = response.code(); this.headers = response.headers(); this.body = body;
            this.networkStartedAt = startedAt; this.networkEndedAt = System.currentTimeMillis();
            this.networkDurationMs = durationMs; this.dispatchPreparationMs = preparationMs;
        }
    }

    Result execute(Request request, Runnable checkExecution) throws IOException {
        return execute(client, request, checkExecution, null, null, () -> {});
    }

    Result execute(Request request, Runnable checkExecution, long timeoutMs) throws IOException {
        return execute(request, checkExecution, timeoutMs, null);
    }

    Result execute(Request request, Runnable checkExecution, long timeoutMs, Long deadlineMs) throws IOException {
        return execute(request, checkExecution, timeoutMs, deadlineMs, null, () -> {});
    }

    Result execute(Request request, Runnable checkExecution, long timeoutMs, Long deadlineMs,
            CourtRequestCancellation cancellation, Runnable beforeMutation) throws IOException {
        return execute(client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build(), request, checkExecution,
            deadlineMs, cancellation, beforeMutation);
    }

    private Result execute(OkHttpClient activeClient, Request request, Runnable checkExecution, Long deadlineMs,
            CourtRequestCancellation cancellation, Runnable beforeMutation) throws IOException {
        boolean query = isQuery(request);
        if (!query) cancellation = null;
        // Preparation queries must release the connection by the deadline,
        // including their retry. Sent mutations still wait for their result.
        Long queryDeadline = query ? deadlineMs : null;
        // retryOnConnectionFailure(false) alone does not disable HTTP 503 follow-ups.
        // Mark POST bodies one-shot within each call; only our whitelist may start a new call.
        if (request.body() != null) {
            RequestBody body = request.body();
            request = request.newBuilder().method(request.method(), new RequestBody() {
                @Override public MediaType contentType() { return body.contentType(); }
                @Override public long contentLength() throws IOException { return body.contentLength(); }
                @Override public boolean isOneShot() { return true; }
                @Override public void writeTo(BufferedSink sink) throws IOException { body.writeTo(sink); }
            }).build();
        }
        try {
            return read(activeClient, request, checkExecution, queryDeadline, cancellation, beforeMutation);
        } catch (IOException first) {
            if (!query) throw first;
            if (cancellation != null) cancellation.check();
            // A private pool guarantees a fresh connection without disrupting other accounts.
            ConnectionPool pool = new ConnectionPool(0, 1, TimeUnit.SECONDS);
            OkHttpClient fresh = activeClient.newBuilder().connectionPool(pool).build();
            try {
                return read(fresh, request, checkExecution, queryDeadline, cancellation, beforeMutation);
            } catch (IOException last) {
                last.addSuppressed(first);
                throw last;
            } finally { pool.evictAll(); }
        }
    }

    private Result read(OkHttpClient http, Request request, Runnable checkExecution, Long deadlineMs,
            CourtRequestCancellation cancellation, Runnable beforeMutation) throws IOException {
        checkExecution.run();
        if (cancellation != null) cancellation.check();
        if (deadlineMs != null) {
            long remaining = deadlineMs - System.currentTimeMillis();
            if (remaining <= 0) throw new CourtExecutionGate.NotSent("准备窗口已结束，未发送查询");
            long timeout = http.callTimeoutMillis();
            http = http.newBuilder().callTimeout(timeout > 0 ? Math.min(timeout, remaining) : remaining, TimeUnit.MILLISECONDS).build();
        }
        long preparationStarted = System.nanoTime();
        if (!isQuery(request)) { beforeMutation.run(); checkExecution.run(); }
        long preparationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - preparationStarted);
        Call call = http.newCall(request);
        if (cancellation != null) cancellation.attach(call);
        long networkStartedAt = System.currentTimeMillis(), networkStarted = System.nanoTime();
        try (Response response = call.execute()) {
            // Consume the body inside the retry boundary: execute() alone only reads headers.
            String body = response.body() == null ? "" : response.body().string();
            return new Result(response, body, networkStartedAt,
                TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - networkStarted), preparationMs);
        } finally { if (cancellation != null) cancellation.detach(call); }
    }
}
