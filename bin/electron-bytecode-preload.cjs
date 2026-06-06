// Compiler preload: runs in a renderer process (sandbox:false) so the produced code
// cache matches the V8 isolate (snapshot + flag hash) of the app's runtime preload,
// which the browser/main process cache does not on Electron 42+ / V8 14.8.
const fs = require('fs')
const vm = require('vm')
const v8 = require('v8')
const { ipcRenderer } = require('electron')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

const params = ['exports', 'require', 'module', '__filename', '__dirname']

try {
  const code = fs.readFileSync(process.env.ELECTRON_VITE_BYTECODE_IN, 'utf-8')
  const fn = vm.compileFunction(code, params, { produceCachedData: true })
  fs.writeFileSync(process.env.ELECTRON_VITE_BYTECODE_OUT, fn.cachedData)
} catch (error) {
  console.error(error)
}
ipcRenderer.send('electron-vite:bytecode-done')
