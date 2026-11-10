package com.nanghwa.tradingclass

import android.os.Build
import android.os.Bundle
import androidx.activity.OnBackPressedCallback

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class df : ReactActivity() {
  /**
   * Hands every Back (button or gesture) to JavaScript, which closes a sheet,
   * pops a screen, returns to the previous tab or asks before leaving.
   *
   * Android 16 no longer calls onBackPressed() for apps targeting SDK 36, so
   * React Native 0.83 registers a callback like this one. Its
   * invokeDefaultOnBackPressed() switches that callback off for the system
   * default and never switches it on again: after one Back that left the app
   * (the task only moves to the background, this activity lives on), every
   * later Back skipped JavaScript and left the app from any screen. This
   * callback is off only while the system default runs.
   */
  private val backToJavaScript = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      isEnabled = false
      try {
        this@MainActivity.onBackPressed()
      } finally {
        isEnabled = true
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    // Added after React Native's own callback, so the dispatcher asks it first.
    onBackPressedDispatcher.addCallback(this, backToJavaScript)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R && moveTaskToBack(false)) {
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact
      // (and to finish non-root activities). It must not reach JavaScript
      // again; the next Back does.
      backToJavaScript.isEnabled = false
      try {
          super.invokeDefaultOnBackPressed()
      } finally {
          backToJavaScript.isEnabled = true
      }
  }
}
