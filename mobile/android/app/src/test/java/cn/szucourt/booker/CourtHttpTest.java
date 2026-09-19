package cn.szucourt.booker;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.*;
import okhttp3.mockwebserver.*;
import org.junit.*;
import static org.junit.Assert.*;

public class CourtHttpTest {
    private MockWebServer server;
    private OkHttpClient client;
    private CourtHttp http;
    @Before public void setup() throws IOException {
        server = new MockWebServer(); server.start();
        client = new OkHttpClient.Builder().retryOnConnectionFailure(false)
            .followRedirects(false).callTimeout(1, TimeUnit.SECONDS).build();
        http = new CourtHttp(client);
    }
    @After public void close() throws IOException {
        client.connectionPool().evictAll(); server.shutdown();
    }
    private String productionPath(String path) {
        // Read the JS source of truth, not a second copy of the native allowlist.
        java.nio.file.Path root = java.nio.file.Paths.get("").toAbsolutePath();
        while (root != null && !java.nio.file.Files.exists(root.resolve("shared/constants.js"))) root = root.getParent();
        assertNotNull("Cannot locate shared/constants.js", root);
        try {
            String source = new String(java.nio.file.Files.readAllBytes(root.resolve("shared/constants.js")), java.nio.charset.StandardCharsets.UTF_8);
            java.util.regex.Matcher base = java.util.regex.Pattern.compile("BASE_URL = '([^']+)'").matcher(source);
            assertTrue(base.find());
            return HttpUrl.get(base.group(1)).encodedPath() + path;
        } catch (IOException error) { throw new AssertionError(error); }
    }
    private Request request(String path, boolean post) {
        Request.Builder b = new Request.Builder().url(server.url(productionPath(path)))
            .header("Cookie", "account=A");
        if (post) b.post(RequestBody.create("a=1", MediaType.get("application/x-www-form-urlencoded")));
        return b.build();
    }
    private MockResponse broken() {
        return new MockResponse().setBody("a response that is cut short")
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY);
    }
    @Test public void queryPostRetriesTruncatedBodyOnFreshConnection() throws Exception {
        server.enqueue(broken());
        server.enqueue(new MockResponse().setBody("complete").addHeader("Set-Cookie", "one=1").addHeader("Set-Cookie", "two=2"));
        CourtHttp.Result result = http.execute(request("sportVenue/getRqList.do", true), () -> {});
        assertEquals("complete", result.body); assertEquals(2, result.headers.values("Set-Cookie").size());
        RecordedRequest first = server.takeRequest(), second = server.takeRequest();
        assertEquals(0, second.getSequenceNumber());
        assertEquals(first.getBody().readUtf8(), second.getBody().readUtf8());
        assertEquals("account=A", second.getHeader("Cookie"));
    }
    @Test public void identityRetriesMissingHeaders() throws Exception {
        server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
        server.enqueue(new MockResponse().setBody("identity"));
        assertEquals("identity", http.execute(request("index.do", false), () -> {}).body);
        assertEquals(2, server.getRequestCount());
    }
    @Test public void brokenReusedConnectionRecovers() throws Exception {
        server.enqueue(new MockResponse().setBody("warm"));
        server.enqueue(new MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST));
        server.enqueue(new MockResponse().setBody("recovered"));
        Request request = request("index.do", false);
        http.execute(request, () -> {});
        assertEquals("recovered", http.execute(request, () -> {}).body);
        assertEquals(0, server.takeRequest().getSequenceNumber());
        assertEquals(1, server.takeRequest().getSequenceNumber());
        assertEquals(0, server.takeRequest().getSequenceNumber());
    }
    @Test public void retryIsBounded() {
        server.enqueue(broken()); server.enqueue(broken());
        assertThrows(IOException.class, () -> http.execute(request("sportVenue/getRqList.do", true), () -> {}));
        assertEquals(2, server.getRequestCount());
    }
    @Test public void mutationsAndUnknownEndpointsNeverRetry() {
        for (String path : new String[]{"sportVenue/insertVenueBookingInfo.do", "sportVenue/cancelSelectBookingInfo.do", "unknown.do"}) {
            int before = server.getRequestCount(); server.enqueue(broken());
            assertThrows(IOException.class, () -> http.execute(request(path, true), () -> {}));
            assertEquals(before + 1, server.getRequestCount());
        }
    }
    @Test public void backgroundBeforeRetryPreventsDispatch() {
        server.enqueue(broken()); AtomicInteger checks = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> http.execute(request("index.do", false), () -> {
            if (checks.incrementAndGet() > 1) throw new IllegalStateException("background");
        }));
        assertEquals(1, server.getRequestCount());
    }
    @Test public void serviceUnavailableCannotReplayBooking() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(503).addHeader("Retry-After", "0"));
        server.enqueue(new MockResponse().setBody("must not submit twice"));
        assertEquals(503, http.execute(request("sportVenue/insertVenueBookingInfo.do", true), () -> {}).status);
        assertEquals(1, server.getRequestCount());
    }
    @Test public void httpErrorsAreNotRetried() throws Exception {
        server.enqueue(new MockResponse().setResponseCode(503).setBody("busy"));
        assertEquals(503, http.execute(request("index.do", false), () -> {}).status);
        assertEquals(1, server.getRequestCount());
    }
}
