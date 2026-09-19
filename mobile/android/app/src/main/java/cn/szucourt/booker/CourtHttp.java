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

/** Bounded retries only for known read-only endpoints (including query POSTs). */
final class CourtHttp {
    private static final String ROOT = "/qljfwapp/sys/lwSzuCgyy/";
    private static final Set<String> QUERY_POSTS = new HashSet<>(Arrays.asList(
        ROOT + "sportVenue/getSportVenueData.do", ROOT + "sportVenue/getRqList.do",
        ROOT + "sportVenue/getTimeList.do", ROOT + "modules/sportVenue/getOpeningRoom.do",
        ROOT + "modules/myBooking/myBookingInfo.do"));
    private final OkHttpClient client;

    CourtHttp(OkHttpClient client) { this.client = client; }

    static final class Result {
        final int status;
        final Headers headers;
        final String body;
        Result(Response response, String body) {
            this.status = response.code(); this.headers = response.headers(); this.body = body;
        }
    }

    Result execute(Request request, Runnable checkExecution) throws IOException {
        boolean query = request.method().equals("GET") && request.url().encodedPath().equals(ROOT + "index.do")
            || request.method().equals("POST") && QUERY_POSTS.contains(request.url().encodedPath());
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
            return read(client, request, checkExecution);
        } catch (IOException first) {
            if (!query) throw first;
            // A private pool guarantees a fresh connection without disrupting other accounts.
            ConnectionPool pool = new ConnectionPool(0, 1, TimeUnit.SECONDS);
            OkHttpClient fresh = client.newBuilder().connectionPool(pool).build();
            try {
                return read(fresh, request, checkExecution);
            } catch (IOException last) {
                last.addSuppressed(first);
                throw last;
            } finally { pool.evictAll(); }
        }
    }

    private Result read(OkHttpClient http, Request request, Runnable checkExecution) throws IOException {
        checkExecution.run();
        try (Response response = http.newCall(request).execute()) {
            // Consume the body inside the retry boundary: execute() alone only reads headers.
            return new Result(response, response.body() == null ? "" : response.body().string());
        }
    }
}
