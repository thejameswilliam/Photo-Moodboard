# DigitalOcean Droplet Setup

## Recommended shape

- Ubuntu 24.04 droplet
- Current Node LTS
- Nginx reverse proxy
- `systemd` for process management
- SQLite plus uploads stored in `/var/lib/moodboard`

## 1. Create a deploy user and folders

```bash
sudo adduser --system --group --home /srv/moodboard moodboard
sudo mkdir -p /srv/moodboard/current
sudo mkdir -p /var/lib/moodboard
sudo chown -R moodboard:www-data /srv/moodboard /var/lib/moodboard
```

## 2. Install Node and Nginx

This app uses `better-sqlite3`, so install the usual native build tooling alongside Node.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx build-essential python3 make g++
node -v
npm -v
```

## 3. Deploy the app

```bash
cd /srv/moodboard/current
git clone <your-repo-url> .
npm install
npm run build
```

## 4. Configure environment

Copy [.env.example](/Users/thejameswilliam/Documents/Sites/Moodboard/.env.example) into `/etc/moodboard.env` and set real values:

- `APP_ORIGIN=https://your-domain.com`
- `PORT=3001`
- `DATA_DIR=/var/lib/moodboard`
- `SQLITE_PATH=/var/lib/moodboard/moodboard.sqlite`
- `SESSION_SECRET=<long random secret>`
- SMTP credentials for your mail provider

## 5. Install the systemd unit

```bash
sudo cp deploy/moodboard.service /etc/systemd/system/moodboard.service
sudo systemctl daemon-reload
sudo systemctl enable moodboard
sudo systemctl start moodboard
sudo systemctl status moodboard
```

## 6. Configure Nginx

```bash
sudo cp deploy/moodboard.nginx.conf /etc/nginx/sites-available/moodboard
sudo ln -s /etc/nginx/sites-available/moodboard /etc/nginx/sites-enabled/moodboard
sudo nginx -t
sudo systemctl reload nginx
```

Edit `server_name` in the config first, then point your domain's `A` record at the droplet IP.

## 7. Enable HTTPS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 8. Verify runtime behavior

- Open `https://your-domain.com`
- Request a magic link and confirm email delivery
- Sign in and confirm your first real login claims the legacy boards
- Create a share link and open it in a private window
- Upload a test image and confirm `/var/lib/moodboard` contains the SQLite file and uploads

## 9. Backups

Enable droplet backups or snapshot the droplet regularly. The critical runtime data is:

- `/var/lib/moodboard/moodboard.sqlite`
- `/var/lib/moodboard/uploads`
