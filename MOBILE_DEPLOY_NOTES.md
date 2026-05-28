# Mobile deploy notes — `experiment/mobile`

What this branch ships and how to get it onto a phone for testing the new
direct-tools / Tailscale-relay flow.

## What changed

- `mobile/lib/relay-config.ts` (new) — `DEFAULT_REALTIME_SERVER_URL`,
  pulled from `EXPO_PUBLIC_REALTIME_SERVER_URL` and defaulting to
  `ws://100.82.61.115:8080/ws` (the development tailnet IP of the desktop
  running the relay).
- `mobile/app/(tabs)/settings.tsx`, `mobile/app/(tabs)/index.tsx`,
  `mobile/lib/title.ts` — replace `ws://localhost:8080/ws` literal with the
  new default. Settings still wins when populated, so localhost dev keeps
  working as soon as a user types it.
- `mobile/lib/use-realtime.ts` — adds a `tool.cancelled` case + an
  `onToolCancelled(callIds: string[])` callback. Mirrors the desktop
  handler so cancelled server-side tool calls clear their spinners on
  mobile too.
- `mobile/app/(tabs)/index.tsx` — wires `onToolCancelled` to flip
  matching `ToolCallItem`s from `in-progress` → `cancelled` and record a
  duration, so `ToolCallRow` renders a final "—" status icon instead of
  spinning forever.

The relay event protocol matches the desktop side:
`tool.call` (start), `tool.progress`, `tool_call.completed`,
`tool_call.failed`, `tool.cancelled`. Mobile now parses all five.

## Talking to the desktop relay over Tailscale

The desktop machine running `cd relay-server && yarn dev` listens on
port 8080. Its Tailscale IP is **100.82.61.115**; over MagicDNS the same
host is reachable as the machine name (faster than typing the IP, and
it auto-renews on tailnet rebind). Either form works:

```
ws://100.82.61.115:8080/ws
ws://<machine-name>:8080/ws
```

For local dev (relay and simulator on the same Mac), set in `mobile/.env`:

```
EXPO_PUBLIC_REALTIME_SERVER_URL=ws://localhost:8080/ws
```

iOS-specific gotchas (see `mobile/CLAUDE.md` "Relay connectivity on iOS"
for the full version):

- iCloud Private Relay does **not** intercept `ws://`, so the in-app
  "Test connection" probe just opens a WebSocket. If you ever switch to
  `https://` from the phone, disable Private Relay or use a MagicDNS host.
- First connect prompts for **Local Network** permission — user must tap
  Allow once per install, or all 100.64/10 traffic is dropped silently.
- `NSAllowsArbitraryLoads: true` and `NSLocalNetworkUsageDescription` are
  already set in `app.config.ts`.

## Deploying to the connected iPhone

A device is paired: **Michael Yagudaev's iPhone** (iPhone 12 Pro, iOS 26.5,
identifier `00008101-000D69900150001E` /
`56C80741-243D-5A87-91B2-6412AB6C2C72`).

### What was attempted

From this branch I ran:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  APP_VARIANT=development npx expo prebuild --clean --platform ios
```

Result: `mobile/ios/` was generated (project, Podfile, VoiceClaw.xcodeproj,
LocalPackages all created), but `pod install` failed at the very end:

```
/opt/homebrew/Cellar/ruby/4.0.5/lib/ruby/4.0.0/unicode_normalize/normalize.rb:153:
'UnicodeNormalize.normalize': Unicode Normalization not appropriate for
ASCII-8BIT (Encoding::CompatibilityError)
  from .../cocoapods-1.16.2/lib/cocoapods/config.rb:167:'String#unicode_normalize'
  from .../cocoapods-1.16.2/lib/cocoapods/config.rb:227:'Pod::Config#podfile_path'
```

CocoaPods 1.16.2 doesn't tolerate the Homebrew Ruby 4.0.5 currently on
PATH — that ruby returns an `ASCII-8BIT` path from
`String#unicode_normalize` and CocoaPods' `Pod::Config#installation_root`
crashes immediately. The fix is **not** in code; it's a toolchain swap.
Pick one:

```bash
# Option A: pin CocoaPods to system Ruby (2.7-line, ships with macOS)
arch -arm64 sudo gem install cocoapods
# then ensure /usr/bin/ruby comes before /opt/homebrew/bin/ruby on PATH
# for this shell, or run pod through:
arch -arm64 /usr/local/bin/pod install --project-directory=mobile/ios

# Option B: downgrade brew ruby (3.3 line works fine with CocoaPods 1.16)
brew unlink ruby && brew install ruby@3.3 && brew link --force ruby@3.3

# Option C: upgrade cocoapods to a Ruby 4-compatible build (if/when released)
brew upgrade cocoapods
```

After CocoaPods can run again, the rest of the local dev flow should
work. Re-run prebuild (`npx expo prebuild --clean`) so Pods is generated
under the fixed toolchain, then `expo run:ios --device "<UDID>"`.

### Blocker — Xcode is not selected

`xcode-select -p` resolves to `/Library/Developer/CommandLineTools`, which
does not ship `xcodebuild`, `xctrace`, or `devicectl`. Every iOS build
command fails until you point xcode-select at the full Xcode app:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
# verify
xcode-select -p   # should print /Applications/Xcode.app/Contents/Developer
xcrun --find xcodebuild
```

While this is unresolved, the workaround in any single shell is to export
`DEVELOPER_DIR` for that command, e.g.:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  APP_VARIANT=development npx expo run:ios --device "00008101-000D69900150001E"
```

(This is what was used to confirm the device is visible to xctrace.)

### Local dev build via `expo run:ios`

After the xcode-select fix, from `mobile/`:

```bash
# First time or after any change to app.config.ts (Info.plist etc.)
APP_VARIANT=development npx expo prebuild --clean

# Install + launch on the paired iPhone
APP_VARIANT=development npx expo run:ios \
  --device "00008101-000D69900150001E"
```

What may still trip you up:

1. **Signing team**: `app.config.ts` does not set a `DEVELOPMENT_TEAM` for
   debug builds (only the release scripts pin `HN6T5KD4ND`). On first
   build Xcode needs to be opened (`open mobile/ios/VoiceClaw.xcworkspace`),
   the VoiceClaw target selected, and Signing & Capabilities → Team set to
   the Apple Developer account that the device is registered against.
2. **Trust device**: iPhone must be unlocked, "Trust this computer" tapped,
   and the developer-mode toggle on (Settings → Privacy & Security →
   Developer Mode). Otherwise install fails with `Unable to install
   "VoiceClaw (Dev)"`.
3. **NSLocalNetworkUsageDescription prompt**: appears on first WebSocket
   open. Tap Allow or the relay connection silently fails.

### TestFlight / EAS path (other machine, no Xcode needed at the user's end)

For wider distribution, use the existing scripts (`mobile/CLAUDE.md`
covers the full sequence). The minimum:

```bash
# from mobile/, on main (the release script enforces clean + main + synced)
yarn release:ios:staging
# or for App Store / TestFlight prod
yarn release:ios:production
```

The lower-level entry points:

```bash
# Build only (no submit, ad-hoc IPAs allowed):
yarn build:ios:staging        # → build/export/*.ipa, with altool validate

# Submit a built IPA to ASC:
yarn submit:ios:staging       # uses eas.json submit.staging
```

Credentials the user needs:

- `~/.appstore/AuthKey_SG645CPQP8.p8` — App Store Connect API key
  (already referenced by `eas.json`).
- `eas login` against the `yagudaev` Expo account (matches
  `app.config.ts` → `owner: 'yagudaev'`). Required for `eas submit`.
- Apple Developer account with access to bundle ID
  `com.yagudaev.voiceclaw.dev` / `.staging` / production.
- Team ID `HN6T5KD4ND` is hard-coded into the release script's signing
  flags.

`eas build --profile staging --platform ios` runs the same build on
Expo's cloud builders instead of locally; on cold cache it takes
~15–20 min and produces an IPA you can `eas submit` afterward. This is
the path to use if the user is on a different machine without
`/Applications/Xcode.app`.

## Verifying the new Tailscale default end-to-end

1. Confirm the desktop relay is up: `curl http://100.82.61.115:8080/health`
   (from any tailnet device) or open `ws://100.82.61.115:8080/ws` in any
   WebSocket client.
2. Wipe the persisted setting on the phone (Settings → "Brain Gateway
   URL" → clear) so the default kicks in.
3. Start a call from the chat tab. The console should log
   `[useRealtime] Connecting to ws://100.82.61.115:8080/ws`.
4. Ask the agent something tool-bound ("read package.json"). A
   `ToolCallRow` should render, switch from spinner → ✓, and show
   args/result/duration.
