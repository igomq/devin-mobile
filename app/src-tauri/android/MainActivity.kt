package me.gomq.uniharn

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

// Replaces the MainActivity that `tauri android init` generates (see .github/workflows/mobile.yml).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge stops the system from resizing the WebView, so keep it clear of the
    // system bars and the on-screen keyboard ourselves.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    val bars = Bars()
    webView.addJavascriptInterface(bars, "UniharnAndroid")
    // Legacy compatibility alias for older frontend builds.
    webView.addJavascriptInterface(bars, "DevinMobileAndroid")
  }

  inner class Bars {
    // Called by the page whenever its theme changes: paint behind the system bars in the
    // page background and pick readable bar icons.
    @JavascriptInterface
    fun setBars(color: String, dark: Boolean) {
      val parsed = try { Color.parseColor(color) } catch (e: IllegalArgumentException) { return }
      runOnUiThread {
        window.decorView.setBackgroundColor(parsed)
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = !dark
          isAppearanceLightNavigationBars = !dark
        }
      }
    }
  }
}
