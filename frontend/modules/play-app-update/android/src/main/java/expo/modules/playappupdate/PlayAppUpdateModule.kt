package expo.modules.playappupdate

import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 앱 업데이트 안내 on Android (2026-11-13): asks Google Play itself whether it
 * offers THIS install a newer version (staged rollouts, device targeting and
 * installs not from Play are Play's own answer). Read only: it never starts an
 * update flow — the app opens the Play Store page when the member chooses
 * 업데이트하기. Play gives the new version's code, not its name, so no name
 * is reported or guessed.
 */
class PlayAppUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PlayAppUpdate")

    AsyncFunction("getUpdateInfoAsync") { promise: Promise ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AppUpdateManagerFactory.create(context).appUpdateInfo
        .addOnSuccessListener { info ->
          promise.resolve(
            mapOf(
              // UpdateAvailability: 0 unknown, 1 not available, 2 available,
              // 3 developer-triggered update in progress.
              "updateAvailability" to info.updateAvailability(),
              "availableVersionCode" to info.availableVersionCode()
            )
          )
        }
        .addOnFailureListener { error ->
          // Not installed from Play, no Play Store, offline, … : no notice.
          promise.reject("ERR_PLAY_APP_UPDATE", error.message ?: "Google Play update info is unavailable.", error)
        }
    }
  }
}
