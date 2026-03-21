# Live Trading Credentials Audit

Date: 2026-03-21

Context:

- `app-execution` was moved to a new droplet.
- existing encrypted trading credentials were checked using the current `TRADING_ENCRYPTION_SECRET`.

Result:

- users with encrypted trading credentials found: `3`
- users whose encrypted credentials decrypted successfully: `0`
- users whose encrypted credentials failed to decrypt: `3`

Affected users:

- `tuf`
  - wallet: `0x56bF1FBa664c4e685f1E877EC234439b848E5C19`
  - live flags: `liveTradeEnabled=false`, `edgeSwingLiveTradingEnabled=true`
- `gapy`
  - wallet: `0x4bbac6bd8d1ef0b9b5817ac4b9122a0480a46800`
  - live flags: `liveTradeEnabled=true`, `edgeSwingLiveTradingEnabled=false`
- `idani`
  - wallet: `0x63f3c6a277b498803865bd9430fA5c8e5764C278`
  - live flags: `liveTradeEnabled=false`, `edgeSwingLiveTradingEnabled=true`

Meaning:

- these users have saved encrypted trading credentials in Mongo
- those credential blobs do not decrypt with the current app-execution encryption secret
- those users need to re-save their trading credentials in the app before live trading can work

Audit script:

- [scripts/audit-live-trading-credentials.mjs](/Users/Jordan/Documents/polymarket-signals/scripts/audit-live-trading-credentials.mjs)

Usage:

```bash
set -a
. ./.env.app-execution
set +a
node scripts/audit-live-trading-credentials.mjs
```

Optional cleanup:

```bash
set -a
. ./.env.app-execution
set +a
node scripts/audit-live-trading-credentials.mjs --disable-live-flags
```

The cleanup mode only disables the live-trading flags for users with broken encrypted credentials. It does not delete the stored encrypted blobs.
