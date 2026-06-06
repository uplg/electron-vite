const { app } = require('electron')
const vm = require('vm')
const v8 = require('v8')
const fs = require('fs')
const path = require('path')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

// Compile a chunk to a V8 code cache in the SAME process type that will consume it.
// On Electron 42+/V8 14.8 the cache is bound to a per-process-type snapshot AND flag
// hash, so a cache built in the wrong process type is rejected (and forcing acceptance
// corrupts execution). Spawned WITHOUT ELECTRON_RUN_AS_NODE (whose isolate matches
// neither). Code in / cache out go through ELECTRON_VITE_BYTECODE_IN / _OUT temp files.
//   - main chunks    -> compiled here, in the browser (main) process.
//   - preload chunks -> ELECTRON_VITE_BYTECODE_RENDERER=1: a hidden window whose
//                       sandbox:false preload compiles it in a renderer isolate.
app.disableHardwareAcceleration()

const params = ['exports', 'require', 'module', '__filename', '__dirname']
const inFile = process.env.ELECTRON_VITE_BYTECODE_IN
const outFile = process.env.ELECTRON_VITE_BYTECODE_OUT

if (process.env.ELECTRON_VITE_BYTECODE_RENDERER) {
  const { BrowserWindow, ipcMain } = require('electron')
  app.whenReady().then(() => {
    ipcMain.once('electron-vite:bytecode-done', () => app.quit())
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'electron-bytecode-preload.cjs'),
        sandbox: false,
        contextIsolation: true
      }
    })
    win.loadURL('data:text/html,<!doctype html><html></html>')
  })
} else {
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
}
