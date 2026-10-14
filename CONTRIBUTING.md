# Contributing

## Development checks

Run these from the repository root:

```sh
bun run typecheck
bun test
```

## Conventions

- Use only the test TIN `123-456-788-00000` in tests and demos.
- Never set `process.env.BIR_SFTP_LIVE` in tests. Pass configuration through
  `loadSftpConfig`'s environment argument instead.
- Keep live SFTP disabled by default.
