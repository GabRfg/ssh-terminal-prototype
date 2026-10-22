# SSH Terminal Prototype (Electron + Node.js + ssh2 + xterm.js)

*[Versão em português](README.md)*

A working SSH client written to understand how GUI terminal clients (PuTTY,
Bitvise, Termius) are put together internally. It implements the decoupled
architecture standard to Electron-based terminals such as the VS Code terminal,
Hyper and Tabby.

> **Status:** study prototype, not production software.
> See [Known limitations](#7-known-limitations) before pointing it at a server
> you care about.

## Why I built it

I spend much of my working day in SSH sessions against Linux servers, and I had
never stopped to think about what the terminal client itself is doing. A GUI SSH
client solves three problems at once:

1. **Speak the SSH protocol** — handshake, server identity verification,
   authentication, channel multiplexing
2. **Allocate and drive a PTY** (pseudo-terminal) on the remote host, so that
   interactive programs (`vim`, `top`, `htop`) behave as they would on a real TTY
3. **Emulate a terminal locally** — interpret ANSI escape sequences, handle
   resizing, and render a character grid fast enough to feel instant

So I rebuilt a minimal version to find out. Nothing was decompiled and no
third-party source was used: the behaviour of existing clients served as the
specification, and the implementation is my own on top of open libraries.

---

## 1. Architecture and IPC flow

Electron splits an app across two processes, and that split is the whole design
problem here: the renderer draws the terminal but must never touch Node.js, while
the SSH socket can only live in the main process.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Renderer as Renderer (index.html + xterm.js)
    participant Preload as Preload (contextBridge)
    participant Main as Main process (main.js)
    participant Service as SshService (ssh2.Client)
    participant Store as KnownHostsStore
    participant Server as Remote SSH server

    User->>Renderer: Enters credentials, clicks Connect
    Renderer->>Preload: window.terminalAPI.connect(config)
    Preload->>Main: ipcRenderer.send('ssh:connect', config)
    Main->>Service: sshService.connect(config)

    Service->>Server: SSH handshake begins (key exchange)
    Server-->>Service: Host public key
    Service->>Service: hostVerifier(key)
    Service->>Store: Look up recorded identity

    alt Unknown key
        Store-->>Service: No record
        Service-->>Renderer: host-key-prompt (type + fingerprint)
        User->>Renderer: Checks the fingerprint and decides
        Renderer->>Service: respondHostKey(accepted)
        Service->>Store: Record identity, if accepted
    else Recorded key matches
        Store-->>Service: Identical fingerprint
    else Recorded key CHANGED
        Store-->>Service: Different fingerprint
        Service-->>Renderer: host-key-changed + error
        Note over Service,Server: Connection refused. No credentials are sent.
    end

    Service->>Server: Authentication (only after the host is verified)
    Server-->>Service: Connection established (ready)
    Service->>Server: client.shell({ term: 'xterm-256color', cols, rows })
    Server-->>Service: Interactive PTY stream open
    Service-->>Main: emit('status', 'connected')
    Main-->>Preload: webContents.send('ssh:status-change')
    Preload-->>Renderer: 'connected' status callback

    loop Active session
        User->>Renderer: Types in the terminal
        Renderer->>Preload: window.terminalAPI.sendData(keystroke)
        Preload->>Main: ipcRenderer.send('ssh:data', data)
        Main->>Service: sshService.sendData(data)
        Service->>Server: stream.write(data)
        Server-->>Service: stream.on('data', chunk)
        Service-->>Main: emit('data', chunk)
        Main-->>Preload: webContents.send('ssh:incoming-data', chunk)
        Preload-->>Renderer: incoming data callback
        Renderer->>Renderer: term.write(chunk)
    end
```

---

## 2. Module structure

| File | Responsibility |
| --- | --- |
| `src/main/main.js` | Electron lifecycle, `ipcMain` handlers, forwards `SshService` events to the window |
| `src/main/ssh-service.js` | `EventEmitter` wrapper over `ssh2`: host verification, connect, authenticate, allocate PTY, resize, teardown |
| `src/main/known-hosts.js` | OpenSSH-format fingerprinting and persistence of accepted host identities. Electron-free by design, so it is testable outside the app |
| `src/main/settings-store.js` | Terminal preferences: defaults, preset palettes, validation and persistence; also translates them into `xterm.js` options |
| `src/preload/preload.js` | The security boundary — exposes only `window.terminalAPI` via `contextBridge` |
| `src/renderer/index.html` | Connection form, tabs, terminal container, preferences panel, host key confirmation dialog |
| `src/renderer/renderer.js` | xterm.js setup, `FitAddon`, input capture, status handling |
| `src/renderer/style.css` | Dark terminal styling |

---

## 3. Host identity verification

An SSH client that accepts whatever key the server presents is open to a
**man-in-the-middle** attack: anyone on the network path can impersonate the
server, collect the password and relay the session. SSH's encryption does not
prevent this on its own, because it guarantees that the channel is private, not
*who* the channel was established with.

The defence is the same one the OpenSSH client uses: compare the server's public
key against the one recorded on first connection.

### Fingerprints

A key is identified by a SHA-256 hash in base64 without padding — the format
OpenSSH has displayed since version 6.8:

```
SHA256:n0ThEr3alF1ng3rpr1ntJust4nExampl3Str1ng
```

The value is directly comparable with the output of, on the server:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

The key algorithm (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`) is read from
the blob itself: the SSH wire format (RFC 4253) begins with a 4-byte big-endian
integer giving the length of the algorithm name that follows.

### The three outcomes

Verification runs **during key exchange, before authentication**. No credentials
travel before it answers.

| Situation | Behaviour |
| --- | --- |
| Known host, key matches | Proceeds silently |
| Unknown host | Prompts the user, showing the algorithm and fingerprint (*trust on first use*) |
| Known host, key **changed** | **Refuses the connection.** Does not prompt |

The third case is deliberately inflexible. A changed key may be a legitimate
server reinstall, but it is also exactly what an attack produces, and there is no
way to tell the two apart at connection time. Offering an "accept anyway" button
would turn the protection into a warning people click through. For the legitimate
case, the recorded identity has to be removed deliberately, via
`forgetHost(host, port)`.

### Where identities live

In `known-hosts.json` inside the app's data directory
(`app.getPath('userData')`), with `0600` permissions. Writes are atomic — temp
file plus `rename` — so a failure mid-write cannot leave the store corrupted. An
unreadable JSON file does not block connecting: the store starts empty, which
makes the host unknown and requires confirmation.

### A `hostVerifier` trap worth knowing

`ssh2` calls the verifier like this:

```js
const ret = hostVerifier(key, verify);
if (ret !== undefined) verify(ret);
```

So if the function **returns** anything other than `undefined`, `ssh2` resolves
verification immediately with that value. Writing the callback as an expression
arrow would hand back the pending `Promise`, `ssh2` would call `verify(Promise)`,
and since a Promise is not `false` the host would be **accepted with no
verification at all**. The failure would be silent: no error, just the check
quietly ceasing to exist. That is why the callback uses a block body and returns
nothing.

---

## 4. Renderer isolation and CSP

Host verification guards against a fake server. This section covers the opposite
direction: keeping untrusted code from running inside the window itself.

The renderer has access to `window.terminalAPI.sendData()`. Arbitrary script
running there cannot reach Node — `contextIsolation` prevents that — but it can
reach the bridge, and therefore **type commands into the live SSH session**. The
surface that matters here is not the filesystem, it is the user's terminal.

Two measures close this off:

**Local assets, not a CDN.** `xterm.js` and `FitAddon` are loaded from
`node_modules` rather than a CDN. Fetching your own executable code over the
network with no integrity check is the same class of problem host verification
solves, just from the other side: a compromised CDN or an intercepted request
injects JavaScript straight into the renderer. As a side effect the app works
offline — which matters for an SSH client, since plenty of SSH-administered
servers sit on restricted networks.

**A restrictive Content Security Policy**, declared as a `<meta>` tag in
`index.html`:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
font-src 'self'; img-src 'self' data:
```

`default-src 'none'` denies everything by default and each directive grants the
minimum. The absence of `connect-src` is deliberate and follows directly from the
architecture: the renderer makes no network requests at all, because the SSH
socket lives in the main process.

The one loose grant is `'unsafe-inline'` in `style-src`, and it is required:
`xterm.js` creates two `<style>` elements at runtime, one for terminal dimensions
and one for the theme. Script-injected `<style>` elements are blocked by CSP
without that grant, and since the library creates them there is no way to use a
nonce. The exception permits inline CSS, not code execution — far less serious
than the equivalent in `script-src`.

> Electron logs a console warning when the renderer has no CSP. The warning notes
> that it stops appearing once the app is packaged, which is true — but it is only
> the warning that goes away, not the risk.

---

## 5. Preferences panel

The **Options** tab customizes the terminal's appearance and behaviour: colour
palette (six presets, plus all 21 colours editable individually), font family,
size, weight, line height and letter spacing, cursor style and blink, and
behaviours such as scrollback, tab width and minimum contrast.

Changes apply live, to both the main terminal and a preview, and persist to
`settings.json` in the app's data directory.

### Validation at the boundary

Preferences leave the UI, go to disk, and come back feeding `xterm.js` options
directly. That makes them untrusted input along two paths: the file can be
hand-edited or corrupted, and an invalid value reaching `xterm.js` breaks
rendering.

So all validation lives in the main process, in `sanitize()`, not in the
renderer. Numbers are range-checked, enums checked against known lists, colours
against hexadecimal, and the font family against a restricted character set — it
ends up inside CSS, so `monospace; } body { display:none } .x {` cannot get
through. Anything unrecognised falls back to the default instead of propagating.

`save` returns the already-normalised version, and the UI adopts what came back
rather than what it sent. Typing 999999999 into scrollback makes the field show
1000.

### Two xterm.js details that shaped the code

**The `theme` object is replaced, not merged.** Sending a partial theme wipes the
colours left out, so `sanitize()` always completes all 21 keys from the base
palette before handing it over.

**Changing the font does not resize by itself.** Altering size, line height or
letter spacing changes how many columns and rows fit, but `fit()` has to be
called — and the remote PTY has to be told via `resize()`, or full-screen
programs keep drawing at the old dimensions. It is the same lesson as window
resizing, arriving by a different route.

The preview is created the first time the tab is opened, and the main terminal
only refits when you return to its tab: `xterm.js` measures incorrectly inside a
hidden container.

---

## 6. Running it

Requires Node.js 18+.

```bash
git clone https://github.com/GabRfg/ssh-terminal-prototype
cd ssh-terminal-prototype
npm install
npm start
```

```bash
npm test     # host verification and preference validation
```

Fill in host, port, username and password, then click **Connect**. On the first
connection to a server, confirm the fingerprint in the dialog. Test against a
local container or a VM you own.

### If `npm start` fails with "Electron failed to install correctly"

From npm 11.20 on, install scripts are blocked by default and need per-package
approval. The `electron` npm package is only a stub — the real binary is fetched
by a `postinstall`. With that script blocked, `npm install` **succeeds**
(`exit 0`, `info ok`) without downloading anything, and the failure surfaces only
at `npm start`.

```bash
npm install-scripts approve electron
rm -rf node_modules/electron        # Windows: Remove-Item -Recurse -Force node_modules\electron
npm install
```

Removing the folder is necessary: approving does not re-run the script for an
already-installed package, because npm considers the tree satisfied and does
nothing.

The other two blocked scripts, from `ssh2` and `cpu-features`, can stay blocked.
They exist to compile `cpu-features`, which is optional.

---

## 7. Known limitations

Documented deliberately — this is a prototype, and these are the gaps between it
and a real client:

- **No passphrase support** for encrypted private keys: the `passphrase` option
  is not wired through to `ssh2` yet.
- **Credentials stay in memory** for the lifetime of the connection and are not
  zeroed after authentication.
- **`cpu-features` is not compiled.** It is an optional native dependency of
  `ssh2` and needs `node-gyp`. `ssh2` works without it, falling back to its pure
  JavaScript path.
- **No session persistence**, saved profiles, tabs, SFTP or port forwarding.
- **Partial test coverage.** `npm test` covers host identity verification and
  preference validation, both in plain Node. The UI is verified by hand.

---

## 8. Things I learned

**PTY allocation is not optional.** Without `client.shell({ term: 'xterm-256color' })`
you get a stream, but no job control, no line editing and no colours — full-screen
programs break entirely. The remote side needs to believe it is talking to a real
terminal.

**Resizing has to be propagated.** Refitting xterm.js locally is only half of it:
`stream.setWindow(rows, cols)` has to tell the remote PTY too, or `vim` keeps
drawing to the old dimensions.

**Electron's defaults are the security model.** `contextIsolation: true` and
`nodeIntegration: false` mean the renderer cannot reach `require`, the filesystem
or the network. Every capability has to be handed over deliberately through
`contextBridge`. That is restrictive on purpose, and it is why a compromised
renderer cannot read the user's SSH keys.

**Encryption is not authentication.** The host key check was the part I had always
taken for granted as an SSH *user* — that prompt on first connection is the whole
reason an encrypted session is also a session with the right machine.

---

## 9. Built with

[Electron](https://www.electronjs.org/) ·
[ssh2](https://github.com/mscdex/ssh2) ·
[xterm.js](https://xtermjs.org/)

## License

MIT
