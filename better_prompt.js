const readline = require('readline')

/**
 * Helper for readline which handles multi-line and non-interactive input much more gracefully.
 * Readline doesn't deal well with large chunks of input, since it will emit multiple 'line' events
 * in quick succession, often dropping user input when pasting (or when reading from a
 * noninteractive stream). This wraps a `readline.Interface` in a buffer to hold lines as they come
 * in.
 */
class BetterPrompt {
  /**
   * Create a new instance, ready for reading lines. This MUST have a `close()` called on it in
   * order to ensure all listeners are deregistered.
   * @param instream {io.Stream} - The stream to read input from.
   * @param outstream {io.Stream} - The stream to write prompts to and echo user input on. Ignored
   *     if `instream` is not a TTY.
   */
  constructor (instream, outstream) {
    // Omit prompt and suppress output when we're noninteractive.
    const readlineOutput = instream.isTTY ? outstream : undefined
    this.readlineInterface = readline.createInterface({ input: instream, output: readlineOutput })
    this.readlineInterface.on('line', this.handleLine.bind(this))
    // Front-reading (push-unshift) queue to hold lines as they come in.
    this.linesQueue = []
    // Registered listener for the next line.
    this.resolve = undefined
  }

  /**
   * Handles 'line' events from readline. This will fire any listener, if set; else, it queues up a
   * line for later requests.
   * @param line {string} - The line read.
   */
  handleLine (line) {
    if (this.resolve) {
      const toResolve = this.resolve
      this.resolve = undefined
      toResolve(line)
    } else {
      this.linesQueue.push(line)
    }
  }

  /**
   * Returns a promise holding the next line of input. The promise will be rejected if another
   * listener is already registered.
   * @param prompt {string} - The prompt to display to the user. Ignored if the input is
   *     noninteractive.
   */
  getNextLine (prompt) {
    return new Promise((resolve, reject) => {
      if (this.listenerResolve) {
        reject(new Error('getNextLine called without waiting for result from previous call'))
      } else {
        // Ensure we display a prompt even if the user has pasted in a few lines of input.
        this.readlineInterface.setPrompt(prompt)
        this.readlineInterface.prompt(true)
        if (this.linesQueue.length > 0) {
          // We have a line queued, resolve with it.
          resolve(this.linesQueue.shift())
        } else {
          // Wait for the next line.
          resolve(new Promise(listenerResolve => {
            this.resolve = listenerResolve
          }))
        }
      }
    })
  }

  /**
   * Closes the underlying readline instance. This should be done when input reading has finished -
   * else, interactive users will need to EOT (CTRL-D) the stream themselves.
   */
  close () {
    this.readlineInterface.close()
  }
}

module.exports = { BetterPrompt }
