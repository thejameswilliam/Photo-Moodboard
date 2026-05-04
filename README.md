# Photo Moodboard

A local-feeling mood board app with drag-and-drop image piles, saved layouts, multi-board support, magic-link login, and read-only share links.

## What This App Does

- Lets signed-in users create and edit multiple mood boards
- Supports saved `pile`, `fan`, and `grid` layouts per board
- Stores images on disk and board metadata in SQLite
- Uses passwordless email login with Mailgun
- Supports private boards plus explicit read-only share links

## Current Production Reference

These are the live values as of the current deployment:

- App URL: `https://mood.thejameswilliam.com`
- Mailgun sending domain: `mg.thejameswilliam.com`
- Mail sender: `Moodboard <mood@mg.thejameswilliam.com>`
- Server OS: `Ubuntu 24.04`
- Runtime: `Node 24`
- Process manager: `systemd`
- Reverse proxy: `nginx`
- TLS: `Let's Encrypt` via `certbot`
- Deploy user: `james`
- Service name: `moodboard`
- GitHub SSH alias on server: `github.com-moodboard`

## Production Server Paths

- App code: `/srv/moodboard/current`
- Runtime data: `/var/lib/moodboard`
- SQLite database: `/var/lib/moodboard/moodboard.sqlite`
- Uploaded images: `/var/lib/moodboard/uploads`
- Environment file: `/etc/moodboard.env`
- systemd unit: `/etc/systemd/system/moodboard.service`
- nginx site config: `/etc/nginx/sites-available/moodboard`
- SSH config for deploy key: `/home/james/.ssh/config`

## Stack

- Frontend: `React` + `Vite`
- Backend: `Express`
- Database: `SQLite` via `better-sqlite3`
- Image upload handling: `multer`
- Email delivery: `Mailgun HTTP API`
- Auth: magic links + `httpOnly` cookie sessions

## Local Development

Install dependencies:

```bash
npm install
```

Run the app locally:

```bash
npm run dev
```

Useful scripts:

- `npm run dev` starts the Vite frontend and Node backend together
- `npm run build` creates the production frontend build
- `npm start` runs the production server

## Environment Variables

Copy [.env.example](.env.example) as a starting point.

Core values:

- `APP_ORIGIN`: public URL for the app
- `PORT`: backend port behind nginx
- `DATA_DIR`: persistent runtime directory
- `SQLITE_PATH`: SQLite file path
- `SESSION_SECRET`: long random secret
- `MAGIC_LINK_TTL_MINUTES`: magic-link lifetime
- `COOKIE_SECURE`: should be `true` in production

Mailgun values:

- `MAILGUN_API_KEY`: Mailgun private API key or domain sending key
- `MAILGUN_DOMAIN`: Mailgun sending domain, currently `mg.thejameswilliam.com`
- `MAILGUN_REGION`: `us` or `eu`
- `MAIL_FROM`: verified sender, currently `Moodboard <mood@mg.thejameswilliam.com>`

Important note:

- The app uses the `Mailgun HTTP API`, not SMTP
- This is intentional because DigitalOcean blocks outbound SMTP on the standard mail ports

## Repo Map

- App server: [server/index.js](server/index.js)
- SQLite store: [server/lib/store.js](server/lib/store.js)
- Mail delivery: [server/lib/mailer.js](server/lib/mailer.js)
- Runtime config: [server/lib/config.js](server/lib/config.js)
- Frontend app shell: [src/App.jsx](src/App.jsx)
- Board layout helpers: [src/boardLayouts.js](src/boardLayouts.js)
- Deploy guide: [deploy/digitalocean-droplet.md](deploy/digitalocean-droplet.md)
- systemd template: [deploy/moodboard.service](deploy/moodboard.service)
- nginx template: [deploy/moodboard.nginx.conf](deploy/moodboard.nginx.conf)

## Normal Update Flow

From your local machine:

```bash
git add .
git commit -m "Describe the change"
git push
```

On the production server:

```bash
cd /srv/moodboard/current
git pull
npm install
npm run build
sudo systemctl restart moodboard
sudo systemctl status moodboard --no-pager
```

Notes:

- If dependencies did not change, `npm install` can usually be skipped
- If only docs changed, no restart is needed
- If `/etc/moodboard.env` changed, restart the service after saving it

## Deployment Checklist

Use this checklist for routine code deploys.

### Before deploy

- Confirm the branch being deployed is the one you want
- Confirm any required env var changes are ready
- Confirm Mailgun/domain/TLS changes are not pending

### Deploy

```bash
cd /srv/moodboard/current
git pull
npm install
npm run build
sudo systemctl restart moodboard
```

### After deploy

- Check service health:

```bash
sudo systemctl status moodboard --no-pager
curl https://mood.thejameswilliam.com/healthz
```

- Open the app in the browser
- Confirm login still works
- Confirm boards load
- Upload a test image if the release touched uploads or persistence

## Operational Commands

### App status

```bash
sudo systemctl status moodboard --no-pager
```

### Restart app

```bash
sudo systemctl restart moodboard
```

### Follow app logs

```bash
sudo journalctl -u moodboard -f
```

### Recent app logs

```bash
sudo journalctl -u moodboard -n 100 --no-pager
```

### nginx status

```bash
sudo systemctl status nginx --no-pager
```

### nginx config test

```bash
sudo nginx -t
```

### TLS renewal timer

```bash
sudo systemctl status certbot.timer --no-pager
```

## Backups and Disaster Recovery

Must-have backups:

- `/var/lib/moodboard/moodboard.sqlite`
- `/var/lib/moodboard/uploads`
- `/etc/moodboard.env`

Recommended:

- Keep DigitalOcean Droplet backups enabled
- Take a manual snapshot before large infrastructure changes
- Keep Mailgun DNS and API key information documented outside the server

If restoring to a new Droplet:

1. Recreate the server packages and Node runtime
2. Clone the repo into `/srv/moodboard/current`
3. Restore `/var/lib/moodboard`
4. Restore `/etc/moodboard.env`
5. Restore nginx and systemd configs
6. Run `npm install` and `npm run build`
7. Restart `moodboard`

If you need to re-establish GitHub access on the server, remember the production setup uses an SSH host alias so deploy-key pulls work:

```sshconfig
Host github.com-moodboard
  HostName github.com
  User git
  IdentityFile ~/.ssh/moodboard_deploy
  IdentitiesOnly yes
```

## Mailgun Notes

- Use a verified custom Mailgun domain
- Current sending domain is `mg.thejameswilliam.com`
- Current sender address is `mood@mg.thejameswilliam.com`
- Current region is `us`
- The app authenticates to Mailgun with HTTP Basic Auth:
  - username: `api`
  - password: `MAILGUN_API_KEY`

If mail stops sending:

1. Check app logs with `journalctl`
2. Check Mailgun delivery/activity logs
3. Verify `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, and `MAIL_FROM`
4. Confirm the Mailgun domain is still verified

## Troubleshooting

### The app will not start

Check:

```bash
sudo systemctl status moodboard --no-pager
sudo journalctl -u moodboard -n 100 --no-pager
```

Common causes:

- wrong `User` or `Group` in the systemd unit
- bad env values in `/etc/moodboard.env`
- missing `npm install` after dependency changes

### The site returns `502 Bad Gateway`

Usually means nginx is up but the Node app is down.

Check:

```bash
sudo systemctl status moodboard --no-pager
curl http://127.0.0.1:3001/healthz
```

### Magic links do not arrive

Check:

- Mailgun domain verification
- `MAILGUN_API_KEY`
- app logs
- Mailgun activity logs

### Login works but old boards are missing

Legacy JSON boards are claimed by the first successful login after migration. If something looks wrong:

- check `/var/lib/moodboard/moodboard.sqlite`
- inspect logs for migration/auth errors
- confirm the expected first user signed in

## Infrastructure Notes

- HTTPS is terminated at nginx
- The Node app listens on `127.0.0.1:3001`
- `trust proxy` is enabled in the app for secure cookie behavior behind nginx
- SQLite and uploads are intentionally stored outside the repo checkout

## One-Year-Later Checklist

If you come back to this repo much later, check these first:

1. Is `mood.thejameswilliam.com` still the intended production hostname?
2. Is the server still using the `james` deploy user?
3. Is `MAILGUN_API_KEY` still valid?
4. Is `mg.thejameswilliam.com` still verified in Mailgun?
5. Are DigitalOcean backups still enabled?
6. Does `certbot.timer` still renew automatically?
7. Does `sudo systemctl status moodboard` show a healthy service?
