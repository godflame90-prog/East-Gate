import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the East Gate mobile app.
 *
 * The packaged app is a thin native shell around the site in `www/`, which
 * `scripts/build-web.mjs` fills from the project's static files. Everything the
 * app itself owns — pages, styles, scripts, images — travels inside the APK, so
 * the shell opens instantly and works with no network at all. Only the API and
 * the dealer-uploaded galleries are fetched, from the origin configured in
 * `js/config.js`.
 *
 * `androidScheme: 'https'` gives the WebView an `https://localhost` origin, which
 * is a secure context and matches the TLS API in `PACKAGED_API`. The API must
 * list that origin in `ALLOWED_ORIGINS` (the Render environment does).
 *
 * To point the app at a development server on the LAN instead, set
 * `androidScheme: 'http'`, add `cleartext: true`, and change `PACKAGED_API` in
 * `js/config.js` to the machine's LAN address. Plain HTTP is development-only;
 * keep this file on the HTTPS defaults for release builds.
 */
const config: CapacitorConfig = {
  appId: 'ng.eastgate.app',
  appName: 'East Gate',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  }
};

export default config;
