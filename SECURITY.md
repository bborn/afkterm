# Security policy

afkterm can type into your terminals, so security bugs matter a lot here.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub's [private vulnerability reporting](https://github.com/bborn/afkterm/security/advisories/new). Include what an attacker needs (for example: another device on the tailnet, a website the user visits, or content in a terminal) and how to reproduce it.

You'll get an answer within a few days. Fixes are released as soon as they're ready, and reporters are credited unless they'd rather not be.

## What's in scope

- Getting afkterm to accept a request from anyone other than an allowed Tailscale login
- Cross-site attacks from web pages the user visits on their phone
- Script injection through terminal output, Claude transcripts, file names or skill files
- Reading or writing files outside what afkterm is meant to access
- Anything that exposes afkterm beyond the tailnet

The design and its assumptions are described under **Security** in the [README](README.md#security).

## Known limitations

- Every paired device shares one secret. To revoke a lost device, run `afkterm pair --reset`, which signs out all devices; then pair the ones you still use.
- afkterm listens on a loopback TCP port. If afkterm is stopped, another account on the same Mac could start something on that port and receive requests meant for afkterm. On a Mac with other users you don't trust, keep afkterm running or uninstall it.
