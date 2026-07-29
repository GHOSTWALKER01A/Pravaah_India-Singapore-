/**
 * Pins the Android NDK to a version that is actually installed.
 *
 * Expo SDK 54 defaults to NDK 27.1.12297006 (see `ExpoRootProjectPlugin.kt` ->
 * `defineDefaultProperties`), and AGP will try to auto-download it. If that
 * download is interrupted it leaves behind a directory containing nothing but a
 * `.installer` stub. Gradle then sees the directory, concludes the NDK is
 * installed, and fails configuration with a spectacularly unhelpful error:
 *
 *   [CXX1101] NDK at ...\ndk\27.1.12297006 did not have a source.properties file
 *
 * That error is NOT about this app's code — it is a corrupt SDK download, and
 * deleting the stub directory is the other half of the fix.
 *
 * `defineDefaultProperties` uses `extra.setIfNotExist(...)`, so setting
 * `ext.ndkVersion` on the root project BEFORE `apply plugin: "expo-root-project"`
 * takes precedence. `android/app/build.gradle` then reads it back as
 * `ndkVersion rootProject.ext.ndkVersion`.
 *
 * 27.0.12077973 is the same NDK major release (r27) as Expo's default, so
 * react-native-reanimated / react-native-worklets / expo-modules all compile
 * against it unchanged — it just saves a ~2.5GB download.
 *
 * This lives in a config plugin rather than being hand-edited into
 * `android/build.gradle` because that file is regenerated from scratch by every
 * `expo prebuild`, which would silently drop a manual edit.
 */

const { withProjectBuildGradle } = require('@expo/config-plugins');

/** Must match a directory under $ANDROID_HOME/ndk that has a source.properties. */
const NDK_VERSION = '27.0.12077973';

const ANCHOR = 'apply plugin: "expo-root-project"';

module.exports = function withAndroidNdkVersion(config) {
  return withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error(
        `with-android-ndk-version expects a Groovy android/build.gradle, got "${cfg.modResults.language}".`
      );
    }

    // Idempotent: prebuild may run this against already-patched contents.
    if (cfg.modResults.contents.includes('ndkVersion')) return cfg;

    if (!cfg.modResults.contents.includes(ANCHOR)) {
      throw new Error(
        `with-android-ndk-version could not find '${ANCHOR}' in android/build.gradle. ` +
          `The Expo template changed — re-check where ext.ndkVersion must be set.`
      );
    }

    cfg.modResults.contents = cfg.modResults.contents.replace(
      ANCHOR,
      `// Pinned by plugins/with-android-ndk-version.js — must precede expo-root-project,\n` +
        `// which only fills in a default when ext.ndkVersion is absent.\n` +
        `ext {\n  ndkVersion = "${NDK_VERSION}"\n}\n\n${ANCHOR}`
    );

    return cfg;
  });
};
