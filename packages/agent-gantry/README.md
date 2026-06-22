# @cawstudios/agent-gantry

Stable Gantry SDK facade for product-specific agent packages.

## Install

```bash
npm install @cawstudios/agent-gantry
```

Configure GitHub Packages in the consuming project:

```ini
@cawstudios:registry=https://npm.pkg.github.com
```

Authentication belongs in a user-level npm config or CI secret. Do not commit
tokens.

## Runtime Model

This package is an SDK facade. It does not embed or start Gantry runtime. The
application deployment must run Gantry runtime/control API and provide its base
URL and secrets to the consuming package.

## Public API

The facade owns Gantry HTTP paths, headers, signing, verification, and error
normalization. Product packages should call `createGantryClient(config)` and use
the returned notification and Teams clients rather than importing Gantry
runtime internals directly.
