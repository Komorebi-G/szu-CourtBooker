package cn.szucourt.booker;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CourtDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
