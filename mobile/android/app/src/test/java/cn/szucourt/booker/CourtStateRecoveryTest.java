package cn.szucourt.booker;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class CourtStateRecoveryTest {
    @Rule public TemporaryFolder files = new TemporaryFolder();

    @Test public void backupOnlyStateInvokesAtomicRecovery() throws Exception {
        File base = new File(files.getRoot(), "state.json");
        File backup = new File(base + ".bak");
        Files.write(backup.toPath(), "{\"inFlight\":true}".getBytes(StandardCharsets.UTF_8));
        assertEquals("{\"inFlight\":true}", CourtStateRecovery.read(base, () -> {
            Files.move(backup.toPath(), base.toPath());
            return Files.readAllBytes(base.toPath());
        }));
        assertTrue(base.exists());
    }

    @Test public void trulyMissingStateIsFresh() throws Exception {
        File base = new File(files.getRoot(), "missing.json");
        assertNull(CourtStateRecovery.read(base, () -> { throw new FileNotFoundException(); }));
    }

    @Test public void unreadableBackupMustNotBeTreatedAsFresh() throws Exception {
        File base = new File(files.getRoot(), "state.json");
        assertTrue(new File(base + ".bak").createNewFile());
        assertThrows(FileNotFoundException.class, () -> CourtStateRecovery.read(base, () -> { throw new FileNotFoundException("unreadable"); }));
    }
}
