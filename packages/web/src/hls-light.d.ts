// hls.js publishes types for its full build only; the light build (no subtitles, DRM or alternate
// audio, which Reddit's videos don't use) has the same API.
declare module "hls.js/light" {
  export { default } from "hls.js";
}
