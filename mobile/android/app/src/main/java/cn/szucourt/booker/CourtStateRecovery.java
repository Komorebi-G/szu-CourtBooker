package cn.szucourt.booker;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

final class CourtStateRecovery {
    interface Reader { byte[] read() throws IOException; }

    static String read(File base, Reader reader) throws IOException {
        try {
            // AtomicFile must get a chance to restore its legacy .bak before
            // deciding that this is an installation with no saved state.
            return new String(reader.read(), StandardCharsets.UTF_8);
        } catch (FileNotFoundException error) {
            if (base.exists() || new File(base + ".bak").exists() || new File(base + ".new").exists()) throw error;
            return null;
        }
    }
}
