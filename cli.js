#!/usr/bin/env node

// Script for updating Kubernetes secrets.
// Tested with Node v10.

const { ArgumentParser } = require('argparse')

const child_process = require('child_process') // eslint-disable-line
const { BetterPrompt } = require('./better_prompt')

/** Custom error containing an exit code. */
class ExitError extends Error {
  constructor (exitCode) {
    super()
    this.exitCode = exitCode
  }
}

/**
 * Helper to run kubectl synchronously. On failure, this prints stderr + an optional error message,
 * then exits.
 * @param args {string[]} - The arguments for kubectl.
 * @param errorMessage {string|undefined} - The message to display on error, printed after stderr.
 * @return {string} The stdout stream, if the command was successful.
 * @throws {ExitError} If kubectl fails.
 */
const runKubectlOrExit = (args, errorMessage) => {
  const binary = 'kubectl'
  const spawnResult = child_process.spawnSync(binary, args)
  // True if the process ran successfully.
  let isOk = false
  // The error message to display on error. Unset if isOk is true.
  let commandError
  if (spawnResult.error) {
    if (spawnResult.error.code === 'ENOENT') {
      commandError = `Could not find \`${binary}\`. Is this installed?\n`
    } else {
      commandError = `Unknown error executing \`${binary}\`: ${spawnResult.error}\n`
    }
  } else if (spawnResult.status !== 0) {
    commandError = spawnResult.stderr.toString()
  } else {
    isOk = true
  }
  if (isOk) {
    return spawnResult.stdout.toString()
  } else {
    // Stderr typically has newlines; don't add one.
    process.stderr.write(commandError)
    if (errorMessage) {
      console.error(errorMessage)
    }
    throw new ExitError(1)
  }
}

/**
 * Displays the given secret, optionally filtering to the given keys.
 * @param namespace {string|undefined} - If set, the namespace to search in.
 * @param secretName {string} - The secret to render.
 * @param keys {string[]|undefined} - If set, the keys to display. If unset, display all keys.
 * @param shouldDecode {boolean} - If true, base64-decode the values before displaying.
 * @throws {ExitError} If the provided secret doesn't exist.
 */
const getSecret = (namespace, secretName, keys, shouldDecode) => {
  // Format will print every colon-separate key-value pair in the secret, with each pair separated
  // by a newline. Colons are not allowed in secret keys, and newlines are not allowed in values,
  // so this is safe.
  // TODO(jkinkead): Allow multiple output formats.
  const format = 'go-template={{range $key, $value := .data}}{{$key}}:{{$value}}\n{{end}}'
  const namespaceArgs = namespace ? ['-n', namespace] : []
  const argsList = namespaceArgs.concat(['get', 'secret', secretName, '-o', format])
  const getSecretsResult = runKubectlOrExit(argsList)
  const rawLines = getSecretsResult.split('\n')
  // The final item will be an empty string due to split; strip it.
  const allLines = rawLines.slice(0, rawLines.length - 1)
  // Gather all display values by key.
  const valuesByKey = new Map(allLines.map(line => {
    const colonIndex = line.indexOf(':')
    const key = line.substring(0, colonIndex)
    const encodedValue = line.substring(colonIndex + 1)
    const displayValue =
      shouldDecode ? Buffer.from(encodedValue, 'base64').toString('utf-8') : encodedValue
    return [key, displayValue]
  }))
  let displayValues
  if (keys) {
    // Validate that all requested keys exist.
    displayValues = new Map(keys.map(key => {
      const value = valuesByKey.get(key)
      if (!value) {
        console.error(`Error: Key "${key}" not found in secret "${secretName}".`)
        throw new ExitError(1)
      }
      return [key, value]
    }))
  } else {
    displayValues = valuesByKey
  }

  // TODO(jkinkead): Add a quiet mode that only prints raw values.
  if (keys) {
    console.log(`Selected keys from ${secretName} -`)
  } else {
    console.log(`All keys from ${secretName} -`)
  }
  Array.from(displayValues.keys()).sort().forEach(key => {
    console.log(`${key}: ${displayValues.get(key)}`)
  })
}

/**
 * Sets value(s) in an existing secret.
 * @param namespace {string|undefined} - If set, the namespace to search in.
 * @param secretName {string} - The secret to update.
 * @param keys {string[]|undefined} - If set, the keys to update. If unset, update all keys.
 * @param encodeValues {boolean} - If true, base64-encode the user-provided values before saving.
 * @throws {ExitError} If the provided secret doesn't exist.
 */
const setSecret = (namespace, secretName, keys, encodeValues) => {
  const namespaceArgs = namespace ? ['-n', namespace] : []
  if (!keys) {
    const format = 'go-template={{range $key, $ignored := .data}}{{$key}}\n{{end}}'
    const argsList = namespaceArgs.concat(['get', 'secret', secretName, '-o', format])
    const getSecretsResult = runKubectlOrExit(argsList)
    keys = getSecretsResult.split('\n')
    keys = keys.slice(0, keys.length - 1)
  }
  const prompt = new BetterPrompt(process.stdin, process.stdout)

  // Read new values for all keys requested.
  return keys.reduce((prev, key) => {
    return prev.then(pairs => {
      return prompt.getNextLine(`New unencoded value for ${key}: `).then(value => {
        pairs.push([key, value])
        return pairs
      })
    })
  }, Promise.resolve([])).then(pairs => {
    // Create a JSON blob to patch the secret with.
    const secret = { data: {} }
    pairs.forEach(([key, value]) => {
      if (encodeValues) {
        value = Buffer.from(value, 'utf-8').toString('base64')
      } else {
        // TODO(jkinkead): Validate base64 encoding?
      }
      secret.data[key] = value
    })

    // Run the patch command.
    runKubectlOrExit(
      namespaceArgs.concat(['patch', 'secret', secretName, '-p', JSON.stringify(secret)]))
    console.log(`${secretName} updated.`)
  }).finally(() => {
    prompt.close()
  })
}

/**
 * Creates value(s) in a new secret.
 * @param namespace {string|undefined} - If set, the namespace to search in.
 * @param secretName {string} - The secret to update.
 * @param keys {string[]|undefined} - If set, the keys to create. If unset, create no keys.
 * @param encodeValues {boolean} - If true, base64-encode the user-provided values before saving.
 */
const createSecret = (namespace, secretName, keys, encodeValues) => {
  // Create an empty secret, then ask for the keys the user wanted to create.
  const namespaceArgs = namespace ? ['-n', namespace] : []
  runKubectlOrExit(
    namespaceArgs.concat(['create', 'secret', secretName]))
  // Now, set the keys!
  if (keys.length > 0) {
    return setSecret(namespace, secretName, keys, encodeValues)
  } else {
    return Promise.resolve()
  }
}

const parser = new ArgumentParser({
  description: 'sekr8s manages secret keys and values for you in Kubernetes.'
})

// Subcommands require ordering between the flags and the command, so be more flexible.
parser.addArgument('command', {
  choices: ['get', 'set', 'create'],
  help: 'What operation to perform with the secret.'
})

// Monkey-patch in a custom exit message for missing arguments.
const baseExit = parser.exit
parser.exit = (status, message) => {
  const toReplace = 'too few arguments'
  if (message && message.indexOf(toReplace) >= 0) {
    // Mimic error when the command is unknown.
    message = message.replace(toReplace,
      'Missing "command" argument, (choose from [get, set, create])')
  }

  return baseExit.call(parser, status, message)
}

parser.addArgument(['-n', '--namespace'], {
  help: 'The Kubernetes Namespace to look for secrets in. Defaults to the current context\'s ' +
    'namespace.'
})

parser.addArgument(['-s', '--secret'], {
  help: 'The name of the Kubernetes Secret to look up or modify.',
  required: true
})

parser.addArgument(['-k', '--key'], {
  action: 'append',
  help: 'The key of the Kubernetes Secret to look up or modify. May be repeated for multiple ' +
    'keys. If unset, this will use all keys. Ignored for create.'
})

parser.addArgument(['-d', '--decode'], {
  action: 'storeTrue',
  help: 'Decode base64 values when printing secrets, and accept base64-encoded values when setting.'
})

const args = parser.parseArgs()

try {
  // Validate that we can run kubectl & that the user is authenticated.
  runKubectlOrExit(['version'], '\nError validating `kubectl` credentials. See above for details.')

  switch (args.command) {
    case 'get':
      getSecret(args.namespace, args.secret, args.key, !!args.decode)
      break
    case 'set':
      setSecret(args.namespace, args.secret, args.key, !args.decode).catch(e => {
        console.error(e)
      })
      break
    case 'create':
      createSecret(args.namespace, args.secret, args.key, !args.decode).catch(e => {
        console.error(e)
      })
      break
    default:
      throw new Error('programming error - unhandled command')
  }
} catch (e) {
  if (e.exitCode !== undefined) {
    process.exit(e.exitCode)
  } else {
    // Programming error, most likely.
    throw e
  }
}
