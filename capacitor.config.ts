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
 * `androidScheme: 'http'` keeps the app's own origin on the same scheme as a
 * development API reached over the LAN (`http://192.168.x.x:3000`). An
 * `https://localhost` origin would make every one of those calls mixed content,
 * which the WebView blocks unless `allowMixedContent` is switched on — a
 * development-only escape hatch that is better left off. It also stays correct
 * after the API moves to HTTPS: an HTTP origin calling an HTTPS API is allowed.
 * `localhost` is still treated as a secure context by the WebView, so APIs that
 * require one (geolocation, camera) keep working.
 *
 * `cleartext: true` is what lets the WebView make plain-HTTP requests at all;
 * Android forbids cleartext traffic by default.
 *
 * Both of these exist because the backend is currently the dev machine on the
 * LAN. Once the API is deployed behind TLS, they can go back to the defaults
 * (`androidScheme: 'https'`, `cleartext` unset) and `PACKAGED_API` in
 * `js/config.js` should point at the public origin.
 */
const config: CapacitorConfig = {
  appId: 'ng.eastgate.app',
  appName: 'East Gate',
  webDir: 'www',
  server: {
    androidScheme: 'http',
    cleartext: true
  }
};

export default config;
