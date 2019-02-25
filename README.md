# `sekr8s`: A Kubernetes Secrets CLI

This package provides a CLI for interacting with a Kubernetes server to create, read, and update
Secrets on the server.

This depends on having `kubectl` installed on your path, and will not function otherwise. It also
depends on having `node` + `npm` installed.

## Installation

Install `kubectl` and [`node`](https://nodejs.org/en/download/), then run:

```
npm install -g sekr8s
```

or with `yarn`:

```
yarn global add sekr8s
```

## Usage

Run `sekr8s -h` for help, and `sekr8s {cmd} -h` for command-specific help.

### Read a Secret

```
# Read all keys from a secret, printing them in base64.
$ sekr8s get my-secret
All keys from my-secret -
bar: YmFyaw==
foo: Zm9vZA==
# Read all keys, printing them decoded. Note that this will be annoying for
# binary values.
$ sekr8s get -d my-secret
All keys from my-secret -
bar: bark
foo: food
# Read a single key.
$ sekr8s get -d my-secret foo
Selected keys from my-secret -
foo: food
# Read a single key, and pipe the output to a file. This is especially good for
# binary data.
$ sekr8s get -d -q my-secret foo > foo.txt
$ cat foo.txt
food⏎
```

### Set values in a Secret

```
# Set a list of keys, typing in raw values.
$ sekr8s set my-secret foo bar
New unencoded value for foo: fool
New unencoded value for bar: bard
my-secret updated.
# Set a single value, piped in from file.
$ cat foo.txt | sekr8s set my-secret foo
my-secret updated.
# Set a base64-encoded value. This is useful for keys with newlines.
$ echo -n -e 'foodie\nfool' | base64 | sekr8s set --encoded my-secret foo
my-secret updated.
```

### Create a Secret

```
# Create with keys `foo` and `bar`.
$ sekr8s create my-secret foo bar
New unencoded value for foo: food
New unencoded value for bar: bark
my-secret updated.
```
