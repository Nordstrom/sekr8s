// Command implementation for the CLI.

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
 * @param quiet {boolean} - If true, print only the key value.
 * @throws {ExitError} If there is a problem fetching the secret, or if one of the requested keys
 *   doesn't exist.
 */
const getSecret = (namespace, secretName, keys, shouldDecode, quiet) => {
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
  // Keys in their display order. This is the order the user specified, or else the order k8s
  // returned them in.
  let orderedKeys = keys
  const keysProvided = keys.length > 0
  // Gather all display values by key.
  const valuesByKey = new Map(allLines.map(line => {
    const colonIndex = line.indexOf(':')
    const key = line.substring(0, colonIndex)
    if (!keysProvided) {
      orderedKeys.push(key)
    }
    const encodedValue = line.substring(colonIndex + 1)
    const displayValue =
      shouldDecode ? Buffer.from(encodedValue, 'base64') : encodedValue
    return [key, displayValue]
  }))
  // Create a mapping of key to display value.
  let displayValues
  if (keys.length > 0) {
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

  if (keysProvided) {
    if (!quiet) {
      console.log(`Selected keys from ${secretName} -`)
    }
  } else {
    if (!quiet) {
      console.log(`All keys from ${secretName} -`)
    }
  }
  orderedKeys.forEach((key, i) => {
    if (quiet) {
      process.stdout.write(displayValues.get(key))
      if (i < orderedKeys.length - 1) {
        process.stdout.write('\n')
      }
    } else {
      process.stdout.write(`${key}: `)
      process.stdout.write(displayValues.get(key))
      process.stdout.write('\n')
    }
  })
  return Promise.resolve()
}

/**
 * Sets value(s) in an existing secret.
 * @param namespace {string|undefined} - If set, the namespace to search in.
 * @param secretName {string} - The secret to update.
 * @param keys {string[]|undefined} - If set, the keys to update. If unset, update all keys.
 * @param skipEncode {boolean} - If true, skip base64-encoding the user-provided values before
 *   saving.
 * @return {Promise} A promise resolved when the set operation has completed.
 * @throws {ExitError} If there is a problem setting the secret.
 */
const setSecret = (namespace, secretName, keys, skipEncode) => {
  const namespaceArgs = namespace ? ['-n', namespace] : []
  if (keys.length === 0) {
    const format = 'go-template={{range $key, $ignored := .data}}{{$key}}\n{{end}}'
    const argsList = namespaceArgs.concat(['get', 'secret', secretName, '-o', format])
    const getSecretsResult = runKubectlOrExit(argsList)
    keys = getSecretsResult.split('\n')
    keys = keys.slice(0, keys.length - 1)
  }
  const prompt = new BetterPrompt(process.stdin, process.stdout)

  // Read new values for all keys requested.
  return keys.reduce((prev, key) => {
    const query = skipEncode ? `New encoded value for ${key}: ` : `New unencoded value for ${key}: `
    return prev.then(pairs => {
      return prompt.getNextLine(query).then(value => {
        pairs.push([key, value])
        return pairs
      })
    })
  }, Promise.resolve([])).then(pairs => {
    // Create a JSON blob to patch the secret with.
    const secret = { data: {} }
    pairs.forEach(([key, value]) => {
      if (!skipEncode) {
        value = Buffer.from(value, 'utf-8').toString('base64')
      } else {
        // TODO(jkinkead): Validate base64 encoding? Node's Buffer class will happily decode bad
        // base64, so we'd need to do something manual. Fortunately, Kubernetes will emit a friendly
        // error when the string is bad, which is some consolation.
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
 * @return {Promise} A promise resolved when the set operation has completed.
 * @throws {ExitError} If there is a problem create the secret or setting its keys.
 */
const createSecret = (namespace, secretName, keys, encodeValues) => {
  // Create an empty secret, then ask for the keys the user wanted to create.
  const namespaceArgs = namespace ? ['-n', namespace] : []
  runKubectlOrExit(
    namespaceArgs.concat(['create', 'secret', 'generic', secretName]))
  // Now, set the keys!
  if (keys.length > 0) {
    return setSecret(namespace, secretName, keys, encodeValues)
  } else {
    return Promise.resolve()
  }
}

module.exports = { getSecret, setSecret, createSecret, runKubectlOrExit }
