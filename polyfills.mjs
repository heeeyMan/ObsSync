// Node globals that isomorphic-git (via readable-stream / sha.js) expects but
// that do NOT exist in Obsidian's mobile WebView. On desktop these come from
// Electron's Node integration; on Android/iOS they are absent, so loading the
// plugin throws a ReferenceError ("failed to load plugin") without this shim.
//
// esbuild's `inject` rewrites bare references to the `Buffer` / `process`
// globals into imports from this module. The `buffer` / `process` packages are
// the browser polyfills already pulled in transitively by isomorphic-git.
import { Buffer } from "buffer";
import process from "process";

export { Buffer, process };
