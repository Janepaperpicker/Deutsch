# Optional German voice

This separately licensed GPL-3.0-or-later component synthesizes short German words and phrases on the device. The MIT app loads it in a same-origin frame, outside its JavaScript bundle. Human recordings and device voices remain separate options. Nothing downloads until the learner explicitly chooses Download.

The checked-in release enables an explicit opt-in preview for physical-device testing. The source-built candidate passes desktop Chrome installation, playback, warm reuse, cached-app offline reload, cancellation and removal checks. Physical iOS and Android testing is outstanding. A stable release requires reviewed corresponding source, notices, build recipe, cold-start offline behavior and both phone checks. An explicit preview opt-in can bypass only the phone checks; it must keep their flags false and display its preview status. The product owner approved this preview; promotion to stable still requires actual phone evidence.

## Installation and playback

The Thorsten medium candidate installs about 77 MB, including its 63 MB model, single-threaded ONNX Runtime Web 1.18.0, independently compiled phonemizer and offline setup page. Source and build recipe are separate downloads. See [NOTICE](NOTICE) for pinned sources, model provenance and license boundaries.

Installation requires HTTPS or localhost, WebAssembly SIMD, Worker, AudioContext, CacheStorage, SubtleCrypto, Web Locks, service workers and abortable downloads. Capability checks do not establish sufficient memory or acceptable speed on a particular phone. Browser storage can be evicted.

Downloads run sequentially with byte limits, SHA-256 verification, cancellation and a two-minute per-asset deadline. Incomplete installations roll back. A separate service worker serves only completed voice installations; the generic app shell never caches voice assets. Code, model and runtime are read from verified storage without a speech-service fallback. Study text stays on the device. The disposable worker reuses its session while active, releases it after inactivity, and stops when the app is hidden. Stop cancels synthesis and playback.

Learn and revealed/submitted review cards offer **Offline voice** for setup, then **Listen offline** after installation. Source attribution distinguishes synthesized speech from human recordings. Removal affects only this component's caches. No Wikimedia recording is downloaded or cached by this package.

## Building a release

`rebuild.sh /absolute/build-directory` builds the phonemizer from pinned eSpeak and Piper sources using Emscripten 3.1.47. The source archive includes the exact compatibility patch, full phonemizer sources and build recipe. Build prerequisites include Git, CMake, Python, a native compiler and network access for pinned tools. Byte-identical builds across host toolchains are not claimed.

`node package-release.mjs /prepared/build-directory /output-directory` assembles runtime files, model/configuration, upstream notices, model card and corresponding source. The prepared directory also needs the pinned model artifacts, model repository README, ONNX runtime/license files and `model-revision.txt`, as documented by the script's input checks and NOTICE. Packaging creates a disabled manifest; review flags require actual evidence before activation.

The server exposes an allowlisted, integrity-checked GitHub release through immutable same-origin paths under `/optional-voice/releases/<version>/`. `DEUTSCH_VOICE_ASSETS_DIR` selects a local staging directory for development. Binaries and weights are release artifacts, never committed into the application. The full release, including optional source, is bounded to 200 MiB.

Run `node --test tests/optionalVoice*.test.mjs` from the project root. These tests cover installation integrity, rollback, preview gates, offline navigation, runtime cancellation and server asset verification. They do not replace physical phone testing.
