import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import colors from 'picocolors'
import { type Plugin, type LibraryOptions, type Rolldown, normalizePath } from 'vite'
import * as babel from '@babel/core'
import MagicString from 'magic-string'
import { getElectronPath } from '../electron'
import { toRelativePath } from '../utils'

// Inspired by https://github.com/bytenode/bytenode

const _require = createRequire(import.meta.url)

function getBytecodeCompilerPath(): string {
  return path.join(path.dirname(_require.resolve('electron-vite/package.json')), 'bin', 'electron-bytecode.cjs')
}

let bytecodeId = 0

function compileToBytecode(code: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const electronPath = getElectronPath()
    const bytecodePath = getBytecodeCompilerPath()
    const id = `${process.pid}-${bytecodeId++}`
    const inFile = path.join(os.tmpdir(), `electron-vite-bytecode-${id}.in.js`)
    const outFile = path.join(os.tmpdir(), `electron-vite-bytecode-${id}.jsc`)
    fs.writeFileSync(inFile, code)

    // Compile in a real Electron MAIN process (not ELECTRON_RUN_AS_NODE) so the code
    // cache carries the same V8 snapshot/isolate checksum as the runtime main/preload
    // process. On V8 14.8+ (Electron 42+) a cache produced by a different isolate is
    // rejected, and forcing acceptance corrupts complex modules. Code in / cache out go
    // through temp files because a GUI-subsystem process doesn't pipe stdio reliably.
    const env = { ...process.env, ELECTRON_VITE_BYTECODE_IN: inFile, ELECTRON_VITE_BYTECODE_OUT: outFile }
    delete env.ELECTRON_RUN_AS_NODE

    const proc = spawn(electronPath, [bytecodePath], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    if (proc.stderr) {
      proc.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })
    }

    proc.on('error', err => reject(err))
    proc.on('exit', exitCode => {
      fs.rmSync(inFile, { force: true })
      try {
        const data = fs.readFileSync(outFile)
        fs.rmSync(outFile, { force: true })
        resolve(data)
      } catch {
        reject(new Error(`bytecode compilation failed (exit code ${exitCode})${stderr ? `:\n${stderr}` : ''}`))
      }
    })
  })
}

const bytecodeModuleLoaderCode = [
  `"use strict";`,
  `const fs = require("fs");`,
  `const path = require("path");`,
  `const vm = require("vm");`,
  `const v8 = require("v8");`,
  `const Module = require("module");`,
  `v8.setFlagsFromString("--no-lazy");`,
  `v8.setFlagsFromString("--no-flush-bytecode");`,
  `const COMPILE_PARAMS = ["exports", "require", "module", "__filename", "__dirname"];`,
  `const SOURCE_HASH_OFFSET = 8;`,
  `function sourceLength(bytecodeBuffer) {`,
  `  // The low 28 bits of the source hash hold the source length; the high bits are`,
  `  // V8 source-hash flags (e.g. the "wrapped" bit set by vm.compileFunction).`,
  `  return bytecodeBuffer.readUInt32LE(SOURCE_HASH_OFFSET) & 0x0fffffff;`,
  `};`,
  `function placeholderBody(len, filename) {`,
  `  // A same-length body so the source hash matches. Its CONTENT is ignored (V8 runs`,
  `  // the cached bytecode) but it must be UNIQUE per file, otherwise V8's in-isolate`,
  `  // compilation cache returns a previously-compiled function for the same source.`,
  `  const tag = "/*" + filename + " ";`,
  `  if (tag.length + 2 <= len) {`,
  `    return tag + " ".repeat(len - tag.length - 2) + "*/";`,
  `  }`,
  `  if (len >= 4) {`,
  `    return "/*" + (filename + " ").slice(0, len - 4).padEnd(len - 4, " ") + "*/";`,
  `  }`,
  `  return " ".repeat(len);`,
  `};`,
  `Module._extensions[".jsc"] = Module._extensions[".cjsc"] = function (module, filename) {`,
  `  const bytecodeBuffer = fs.readFileSync(filename);`,
  `  if (!Buffer.isBuffer(bytecodeBuffer)) {`,
  `    throw new Error("BytecodeBuffer must be a buffer object.");`,
  `  }`,
  `  const placeholder = placeholderBody(sourceLength(bytecodeBuffer), filename);`,
  `  const compiledWrapper = vm.compileFunction(placeholder, COMPILE_PARAMS, {`,
  `    filename: filename,`,
  `    cachedData: bytecodeBuffer`,
  `  });`,
  `  if (compiledWrapper.cachedDataRejected) {`,
  `    throw new Error("Invalid or incompatible cached data (cachedDataRejected)");`,
  `  }`,
  `  const require = function (id) {`,
  `    return module.require(id);`,
  `  };`,
  `  require.resolve = function (request, options) {`,
  `    return Module._resolveFilename(request, module, false, options);`,
  `  };`,
  `  if (process.mainModule) {`,
  `    require.main = process.mainModule;`,
  `  }`,
  `  require.extensions = Module._extensions;`,
  `  require.cache = Module._cache;`,
  `  const dirname = path.dirname(filename);`,
  `  return compiledWrapper.call(module.exports, module.exports, require, module, filename, dirname);`,
  `};`
]

const bytecodeChunkExtensionRE = /.(jsc|cjsc)$/

export interface BytecodeOptions {
  chunkAlias?: string | string[]
  transformArrowFunctions?: boolean
  removeBundleJS?: boolean
  protectedStrings?: string[]
}

/**
 * Compile source code to v8 bytecode.
 *
 * @deprecated use `build.bytecode` config option instead
 */
export function bytecodePlugin(options: BytecodeOptions = {}): Plugin | null {
  if (process.env.NODE_ENV_ELECTRON_VITE !== 'production') {
    return null
  }

  const { chunkAlias = [], transformArrowFunctions = true, removeBundleJS = true, protectedStrings = [] } = options
  const _chunkAlias = Array.isArray(chunkAlias) ? chunkAlias : [chunkAlias]

  const transformAllChunks = _chunkAlias.length === 0
  const isBytecodeChunk = (chunkName: string): boolean => {
    return transformAllChunks || _chunkAlias.some(alias => alias === chunkName)
  }

  const plugins: babel.PluginItem[] = []

  if (transformArrowFunctions) {
    plugins.push('@babel/plugin-transform-arrow-functions')
  }

  if (protectedStrings.length > 0) {
    plugins.push([protectStringsPlugin, { protectedStrings: new Set(protectedStrings) }])
  }

  const shouldTransformBytecodeChunk = plugins.length !== 0

  const _transform = (
    code: string,
    sourceMaps: boolean = false
  ): { code: string; map?: Rolldown.SourceMapInput } | null => {
    const re = babel.transform(code, { plugins, sourceMaps })
    return re ? { code: re.code || '', map: re.map } : null
  }

  const useStrict = '"use strict";'
  const bytecodeModuleLoader = 'bytecode-loader.cjs'

  let supported = false

  return {
    name: 'vite:bytecode',
    apply: 'build',
    enforce: 'post',
    configResolved(config): void {
      if (supported) {
        return
      }
      const useInRenderer = config.plugins.some(p => p.name === 'vite:electron-renderer-preset-config')
      if (useInRenderer) {
        config.logger.warn(colors.yellow('bytecodePlugin does not support renderer.'))
        return
      }
      const build = config.build
      const resolvedOutputs = resolveBuildOutputs(build.rolldownOptions.output, build.lib)
      if (resolvedOutputs) {
        const outputs = Array.isArray(resolvedOutputs) ? resolvedOutputs : [resolvedOutputs]
        const output = outputs[0]
        if (output.format === 'es') {
          config.logger.warn(
            colors.yellow(
              'bytecodePlugin does not support ES module, please remove "type": "module" ' +
                'in package.json or set build.rollupOptions.output.format (or build.rolldownOptions.output.format) to "cjs".'
            )
          )
        }
        supported = output.format === 'cjs' && !useInRenderer
      }
    },
    renderChunk(code, chunk, { sourcemap }): { code: string; map?: Rolldown.SourceMapInput } | null {
      if (supported && isBytecodeChunk(chunk.name) && shouldTransformBytecodeChunk) {
        return _transform(code, !!sourcemap)
      }
      return null
    },
    async generateBundle(_, output): Promise<void> {
      if (!supported) {
        return
      }
      const _chunks = Object.values(output)
      const chunks = _chunks.filter(
        chunk => chunk.type === 'chunk' && isBytecodeChunk(chunk.name)
      ) as Rolldown.OutputChunk[]

      if (chunks.length === 0) {
        return
      }

      const bytecodeChunks = chunks.map(chunk => chunk.fileName)
      const nonEntryChunks = chunks.filter(chunk => !chunk.isEntry).map(chunk => path.basename(chunk.fileName))

      const pattern = nonEntryChunks.map(chunk => `(${chunk})`).join('|')
      const bytecodeRE = pattern ? new RegExp(`require\\(\\S*(?=(${pattern})\\S*\\))`, 'g') : null

      const getBytecodeLoaderBlock = (chunkFileName: string): string => {
        return `require("${toRelativePath(bytecodeModuleLoader, normalizePath(chunkFileName))}");`
      }

      let bytecodeChunkCount = 0

      const bundles = Object.keys(output)

      await Promise.all(
        bundles.map(async name => {
          const chunk = output[name]
          if (chunk.type === 'chunk') {
            let _code = chunk.code
            if (bytecodeRE) {
              let match: RegExpExecArray | null
              let s: MagicString | undefined
              while ((match = bytecodeRE.exec(_code))) {
                s ||= new MagicString(_code)
                const [prefix, chunkName] = match
                const len = prefix.length + chunkName.length
                s.overwrite(match.index, match.index + len, prefix + chunkName + 'c', {
                  contentOnly: true
                })
              }
              if (s) {
                _code = s.toString()
              }
            }
            if (bytecodeChunks.includes(name)) {
              const bytecodeBuffer = await compileToBytecode(_code)
              this.emitFile({
                type: 'asset',
                fileName: name + 'c',
                source: bytecodeBuffer
              })
              if (!removeBundleJS) {
                this.emitFile({
                  type: 'asset',
                  fileName: '_' + chunk.fileName,
                  source: chunk.code
                })
              }
              if (chunk.isEntry) {
                const bytecodeLoaderBlock = getBytecodeLoaderBlock(chunk.fileName)
                const bytecodeModuleBlock = `require("./${path.basename(name) + 'c'}");`
                const code = `${useStrict}\n${bytecodeLoaderBlock}\n${bytecodeModuleBlock}\n`
                chunk.code = code
              } else {
                delete output[chunk.fileName]
              }
              bytecodeChunkCount += 1
            } else {
              if (chunk.isEntry) {
                let hasBytecodeMoudle = false
                const idsToHandle = new Set([...chunk.imports, ...chunk.dynamicImports])
                for (const moduleId of idsToHandle) {
                  if (bytecodeChunks.includes(moduleId)) {
                    hasBytecodeMoudle = true
                    break
                  }
                  const moduleInfo = this.getModuleInfo(moduleId)
                  if (moduleInfo) {
                    const { importers, dynamicImporters } = moduleInfo
                    for (const importerId of importers) idsToHandle.add(importerId)
                    for (const importerId of dynamicImporters) idsToHandle.add(importerId)
                  }
                }
                _code = hasBytecodeMoudle
                  ? _code.replace(
                      /("use strict";)|('use strict';)/,
                      `${useStrict}\n${getBytecodeLoaderBlock(chunk.fileName)}`
                    )
                  : _code
              }
              chunk.code = _code
            }
          }
        })
      )

      if (bytecodeChunkCount && !_chunks.some(ass => ass.type === 'asset' && ass.fileName === bytecodeModuleLoader)) {
        this.emitFile({
          type: 'asset',
          source: bytecodeModuleLoaderCode.join('\n') + '\n',
          name: 'Bytecode Loader File',
          fileName: bytecodeModuleLoader
        })
      }
    },
    writeBundle(_, output): void {
      if (supported) {
        const bytecodeChunkCount = Object.keys(output).filter(chunk => bytecodeChunkExtensionRE.test(chunk)).length
        this.environment.logger.info(`${colors.green(`✓`)} ${bytecodeChunkCount} chunks compiled into bytecode.`)
      }
    }
  }
}

function resolveBuildOutputs(
  outputs: Rolldown.OutputOptions | Rolldown.OutputOptions[] | undefined,
  libOptions: LibraryOptions | false
): Rolldown.OutputOptions | Rolldown.OutputOptions[] | undefined {
  if (libOptions && !Array.isArray(outputs)) {
    const libFormats = libOptions.formats || []
    return libFormats.map(format => ({ ...outputs, format }))
  }
  return outputs
}

interface ProtectStringsPluginState extends babel.PluginPass {
  opts: { protectedStrings: Set<string> }
}

function protectStringsPlugin(api: typeof babel & babel.ConfigAPI): babel.PluginObj<ProtectStringsPluginState> {
  const { types: t } = api

  function createFromCharCodeFunction(value: string): babel.types.CallExpression {
    const charCodes = Array.from(value).map(s => s.charCodeAt(0))
    const charCodeLiterals = charCodes.map(code => t.numericLiteral(code))

    // String.fromCharCode
    const memberExpression = t.memberExpression(t.identifier('String'), t.identifier('fromCharCode'))
    // String.fromCharCode(...arr)
    const callExpression = t.callExpression(memberExpression, [t.spreadElement(t.identifier('arr'))])
    // return String.fromCharCode(...arr)
    const returnStatement = t.returnStatement(callExpression)
    // function (arr) { return ... }
    const functionExpression = t.functionExpression(null, [t.identifier('arr')], t.blockStatement([returnStatement]))

    // (function(...) { ... })([x, x, x])
    return t.callExpression(functionExpression, [t.arrayExpression(charCodeLiterals)])
  }

  return {
    name: 'protect-strings-plugin',
    visitor: {
      StringLiteral(path, state) {
        // obj['property']
        if (path.parentPath.isMemberExpression({ property: path.node, computed: true })) {
          return
        }

        // { 'key': value }
        if (path.parentPath.isObjectProperty({ key: path.node, computed: false })) {
          return
        }

        // require('fs')
        if (
          path.parentPath.isCallExpression() &&
          t.isIdentifier(path.parentPath.node.callee) &&
          path.parentPath.node.callee.name === 'require' &&
          path.parentPath.node.arguments[0] === path.node
        ) {
          return
        }

        // Only CommonJS is supported, import declaration and export declaration checks are ignored

        const { value } = path.node
        if (state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value))
        }
      },
      TemplateLiteral(path, state) {
        // Must be a pure static template literal
        // expressions must be empty (no ${variables})
        // quasis must have only one element (meaning the entire string is a single static part).
        if (path.node.expressions.length > 0 || path.node.quasis.length !== 1) {
          return
        }

        // Extract the raw value of the template literal
        // path.node.quasis[0].value.raw is used to get the raw string, including escape sequences
        // path.node.quasis[0].value.cooked is used to get the processed/cooked string (with escape sequences handled)
        const value = path.node.quasis[0].value.cooked
        if (value && state.opts.protectedStrings.has(value)) {
          path.replaceWith(createFromCharCodeFunction(value))
        }
      }
    }
  }
}
