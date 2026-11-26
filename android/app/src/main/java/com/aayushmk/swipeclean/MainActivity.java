package com.aayushmk.swipeclean;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PhotoLibraryPlugin.class);
        super.onCreate(savedInstanceState);
        useLightBarIcons();

        // Back: let the app close its swipe view / viewer / settings first.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge == null || bridge.getWebView() == null) { moveTaskToBack(true); return; }
                bridge.getWebView().evaluateJavascript(
                    "(window.swipeCleanBack && window.swipeCleanBack()) ? 'yes' : 'no'",
                    (result) -> { if (!"\"yes\"".equals(result)) moveTaskToBack(true); }
                );
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        useLightBarIcons();
    }

    // The app is dark, so the clock/battery/nav icons must be light.
    private void useLightBarIcons() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setAppearanceLightStatusBars(false);
        c.setAppearanceLightNavigationBars(false);
    }
}
