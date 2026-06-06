const { app } = require('electron')
const vm = require('vm')
const v8 = require('v8')
const fs = require('fs')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

// Run as a real Electron MAIN process (spawned WITHOUT ELECTRON_RUN_AS_NODE) so the
// produced code cache carries the same V8 snapshot/isolate checksum as the runtime
// main/preload process. On V8 14.8+ (Electron 42+) a cache produced by a different
// isolate (e.g. electron-as-node) is rejected, and forcing acceptance corrupts complex
// modules. Code in / cache out go through temp files (env vars), since a GUI-subsystem
// process doesn't read large stdin / write clean stdout reliably across platforms.
app.disableHardwareAcceleration()

const params = ['exports', 'require', 'module', '__filename', '__dirname']
const inFile = process.env.ELECTRON_VITE_BYTECODE_IN
const outFile = process.env.ELECTRON_VITE_BYTECODE_OUT

app.whenReady().then(() => {
  try {
    const code = fs.readFileSync(inFile, 'utf-8')
    const fn = vm.compileFunction(code, params, { produceCachedData: true })
    fs.writeFileSync(outFile, fn.cachedData)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
  app.quit()
})
