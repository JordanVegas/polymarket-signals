# Polysignals Deploy To Split Droplets

- App path: `/opt/polymarket-signals`
- App execution port: `3001`
- Market intelligence port: `3002`
- Public URL: `https://polysignals.tuf.to`
- Process manager: systemd
- Reverse proxy: nginx on the app-execution droplet

## Env files

Create these files on the target droplets:

- market-intelligence droplet: `/opt/polymarket-signals/.env.market-intelligence`
- app-execution droplet: `/opt/polymarket-signals/.env.app-execution`

`MONGO_URI` is required because the app stores signal history, processed trades, and active aggregation windows in MongoDB.

## MongoDB remote access and auth

The current Mongo setup is local-only and unauthenticated. For the split deployment, the app-execution droplet must be able to reach Mongo on the market-intelligence droplet, and Mongo should require authentication.

### Recommended network policy

Do not expose MongoDB to the whole internet.

Allow TCP `27017` only from:

- `127.0.0.1`
- the market-intelligence droplet itself
- `10.122.0.4` for the app-execution droplet

This deployment uses private networking:

- market-intelligence droplet private IP: `10.122.0.3`
- app-execution droplet private IP: `10.122.0.4`

Example firewall rule on the Mongo host:

```bash
ufw allow from 10.122.0.4 to any port 27017 proto tcp
```

### Update `mongod.conf`

On the Mongo host (`10.122.0.3`), bind MongoDB to localhost plus the private interface IP:

```yaml
net:
  port: 27017
  bindIp: 127.0.0.1,10.122.0.3

security:
  authorization: enabled
```

Then restart MongoDB:

```bash
sudo systemctl restart mongod
sudo systemctl status mongod --no-pager
```

### Create Mongo users

Because this app uses two databases:

- `polymarket_signals`
- `authentication`

the clean setup is:

1. an admin user in `admin`
2. one app user with `readWrite` on both databases

If auth is not enabled yet, create the users before turning on `authorization`.

Example in `mongosh`:

```javascript
use admin
db.createUser({
  user: "mongoAdmin",
  pwd: "CHANGE_THIS_ADMIN_PASSWORD",
  roles: [
    { role: "userAdminAnyDatabase", db: "admin" },
    { role: "readWriteAnyDatabase", db: "admin" }
  ]
})

use admin
db.createUser({
  user: "polysignals",
  pwd: "CHANGE_THIS_APP_PASSWORD",
  roles: [
    { role: "readWrite", db: "polymarket_signals" },
    { role: "readWrite", db: "authentication" }
  ]
})
```

### Env updates after auth is enabled

On the market-intelligence droplet, set:

```env
MONGO_URI=mongodb://polysignals:CHANGE_THIS_APP_PASSWORD@10.122.0.3:27017/polymarket_signals?authSource=admin
```

On the app-execution droplet, set:

```env
MONGO_URI=mongodb://polysignals:CHANGE_THIS_APP_PASSWORD@10.122.0.3:27017/polymarket_signals?authSource=admin
AUTH_MONGO_URI=mongodb://polysignals:CHANGE_THIS_APP_PASSWORD@10.122.0.3:27017/authentication?authSource=admin
```

Notes:

- `10.122.0.3` is the Mongo host on the private network.
- `authSource=admin` assumes you created the `polysignals` user in the `admin` database.
- Keep `AUTH_MONGO_URI` only on the app-execution droplet.

## Update flow

```bash
cd /opt/polymarket-signals
git pull
npm ci
npm run build
sudo systemctl restart market-intelligence
sudo systemctl restart app-execution
```

## GitHub auto deploy

This repo can auto-deploy on every push to `main` using
[`.github/workflows/deploy-droplet.yml`](C:/Users/Jordan/Documents/polymarket-signals/.github/workflows/deploy-droplet.yml).

Set these GitHub Actions secrets:

- `DROPLET_USER=root`
- `DROPLET_PORT=22`
- `DROPLET_SSH_KEY`
- `DROPLET_SSH_PASSPHRASE` if your key uses one
- `DROPLET_APP_DIR=/opt/polymarket-signals`

The workflow deploys:

- `market-intelligence` to `139.59.0.218`
- `app-execution` to `64.227.130.117`
