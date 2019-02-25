#!/usr/bin/env node

// Script for updating Kubernetes secrets.
// Tested with Node v10.

const { ArgumentParser } = require('argparse')
const { getSecret, setSecret, createSecret, runKubectlOrExit } = require('./commands')

/**
 * Subclass of ArgumentParser that uses a custom message for generic 'too few arguments' messages.
 */
class BetterCommandArgumentParser extends ArgumentParser {
  constructor (replacementMessage, options) {
    super(options)
    this.replacementMessage = replacementMessage
  }

  exit (status, message) {
    const toReplace = 'too few arguments'
    if (message && message.indexOf(toReplace) >= 0) {
      // Mimic error when the command is unknown.
      message = message.replace(toReplace, this.replacementMessage)
    }

    return super.exit(status, message)
  }
}

const parser = new BetterCommandArgumentParser(
  'Missing "command" argument, (choose from [get, set, create])',
  { description: 'A helper for managing Secrets in Kubernetes.' })

parser.addArgument(['-n', '--namespace'], {
  help: 'The Kubernetes Namespace to look for secrets in. Defaults to the current context\'s ' +
    'namespace.'
})

const subparsers = parser.addSubparsers({
  parserClass: BetterCommandArgumentParser.bind(undefined, 'Missing "name" argument'),
  title: 'Commands',
  dest: 'command'
})

const getHelp = 'Reads an existing Secret\'s value(s).'
const getParser = subparsers.addParser('get', {
  help: getHelp,
  description: getHelp + ' This can print the encoded value, or print the raw, decoded value.'
})
getParser.addArgument(['-d', '--decode'], {
  action: 'storeTrue',
  help: 'Display decoded values instead of base64-encoded values.'
})
getParser.addArgument(['-q', '--quiet'], {
  action: 'storeTrue',
  help: 'Print only newline-separated key values without any other text. Useful for redirecting ' +
    'output to files. The final value will not have a newline.'
})

const setHelp = 'Sets keys in an existing secret. This can accept raw values or decoded values.'
const setParser = subparsers.addParser('set', {
  help: setHelp,
  description: setHelp + ' Values will be read from stdin, and values for multiple keys being ' +
    'set at once are read separated by newlines. If you wish to set raw values that contain ' +
    'newlines, you can do so by piping into a single-key `set`.'
})

const createHelp = 'Creates a new secret, optionally storing key values.'
const createParser = subparsers.addParser('create', {
  title: 'createy',
  help: createHelp,
  description: createHelp + ' An empty secret can have keys added to it later using `set`. If no ' +
    'key names are provided, this will ignore all input. Note that if one of the key values is ' +
    'malformed, an empty secret will still be created.'
})

// Common argument for set & create.
Array(setParser, createParser).forEach(subparser => { // eslint-disable-line
  subparser.addArgument(['-e', '--encoded'], {
    action: 'storeTrue',
    help: 'Read keys as base64-encoded values from stdin, instead of assuming raw values.'
  })
})

// Add secret name & key arguments to all subcommands.
Array(getParser, setParser, createParser).forEach(subparser => { // eslint-disable-line
  subparser.addArgument('name', {
    nargs: 1,
    help: 'The name of the Secret to operate on.'
  })
})

getParser.addArgument('key', {
  nargs: '*',
  help: 'Zero or more keys names to look up. If omitted, all keys will be printed.'
})

setParser.addArgument('key', {
  nargs: '*',
  help: 'Zero or more keys names to set. If omitted, values for all existing keys will be read.'
})

createParser.addArgument('key', {
  nargs: '*',
  help: 'Zero or more keys names to create. If omitted, no keys will be created and input will ' +
    'be ignored.'
})

const args = parser.parseArgs()

new Promise((resolve, reject) => {
  // Validate that we can run kubectl & that the user is authenticated.
  runKubectlOrExit(['version'], '\nError validating `kubectl` credentials. See above for details.')
  resolve()
}).then(() => {
  switch (args.command) {
    case 'get':
      return getSecret(args.namespace, args.name, args.key, !!args.decode, !!args.quiet)
    case 'set':
      return setSecret(args.namespace, args.name, args.key, !!args.encoded)
    case 'create':
      return createSecret(args.namespace, args.name, args.key, !!args.encoded)
    default:
      throw new Error('programming error - unhandled command')
  }
}).catch(e => {
  if (e.exitCode !== undefined) {
    process.exit(e.exitCode)
  } else {
    // Programming error, most likely.
    throw e
  }
})
