const vm = require('vm')
const v8 = require('v8')

v8.setFlagsFromString('--no-lazy')
v8.setFlagsFromString('--no-flush-bytecode')

// Compile each chunk as a CommonJS module function via vm.compileFunction (instead of
// vm.Script(module.wrap(code))). This is required on V8 14.8+ (Electron 42+): there a
// code cache is only executed when consumed through the same API with --no-lazy, and
// vm.Script no longer runs a cache when the loader supplies a placeholder source. The
// runtime loader mirrors this (same params, vm.compileFunction).
const params = ['exports', 'require', 'module', '__filename', '__dirname']

let code = ''

process.stdin.setEncoding('utf-8')

process.stdin.on('readable', () => {
  const data = process.stdin.read()
  if (data !== null) {
    code += data
  }
})

process.stdin.on('end', () => {
  try {
    if (typeof code !== 'string') {
      throw new Error(`javascript code must be string. ${typeof code} was given.`)
    }

    const fn = vm.compileFunction(code, params, { produceCachedData: true })

    process.stdout.write(fn.cachedData)
  } catch (error) {
    console.error(error)
  }
})
