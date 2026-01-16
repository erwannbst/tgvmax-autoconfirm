# TGV Max Auto-Confirm

Automatically confirm your TGV Max reservations before the 17h deadline.

## Features

- **Secure 2FA handling** via Google Apps Script webhook (no email password needed!)
- Automatic SNCF authentication with session persistence
- Scrapes pending reservations from MAX JEUNE espace
- Confirms reservations within the 48h window
- Real-time Telegram notifications
- **Dokploy-ready** - easy deployment with built-in scheduling

## Prerequisites

### 1. Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Message [@userinfobot](https://t.me/userinfobot) to get your chat ID
5. Start a conversation with your new bot (send any message)

### 2. Google Apps Script Webhook (for 2FA)

This secure method reads 2FA codes from your Gmail without storing your email password.

**Setup:**

1. Go to [Google Apps Script](https://script.google.com)
2. Click "New project"
3. Delete the default code and paste the contents of `google-apps-script/Code.gs`
4. Click "Project Settings" (gear icon) → "Script Properties" → "Add script property"
   - Property name: `SECRET_KEY`
   - Value: Generate a random secret (e.g., `openssl rand -hex 32`)
5. Click "Deploy" → "New deployment"
   - Type: "Web app"
   - Execute as: "Me"
   - Who has access: "Anyone"
6. Click "Deploy" and authorize when prompted
7. Copy the deployment URL (looks like `https://script.google.com/macros/s/.../exec`)

## Deployment with Dokploy

### 1. Create New Application

1. In Dokploy, click "Create Application"
2. Choose "Docker Compose" or "Git" deployment
3. Connect your repository or upload files

### 2. Configure Environment Variables

Add these in Dokploy's Environment Variables section:

| Variable | Value | Required |
|----------|-------|----------|
| `SNCF_EMAIL` | your.email@gmail.com | Yes |
| `SNCF_PASSWORD` | your SNCF password | Yes |
| `WEBHOOK_URL` | Google Apps Script URL | Yes |
| `WEBHOOK_SECRET` | Your webhook secret | Yes |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes |
| `TELEGRAM_CHAT_ID` | Your Telegram ID | Yes |
| `HEADLESS` | true | No (default: true) |
| `SCREENSHOT_ON_ERROR` | true | No (default: true) |

### 3. Configure Volume Mount

In Dokploy, add a volume mount:
- **Host Path**: `/opt/dokploy/data/tgvmax-autoconfirm`
- **Container Path**: `/app/data`

This persists session cookies between runs.

### 4. Set Up Scheduling

In Dokploy's "Advanced" or "Scheduling" section:

**Option A: Using Dokploy's built-in scheduling**
- Create a scheduled task
- Schedule: `0 8,16 * * *` (runs at 8:00 AM and 4:00 PM)
- Command: Leave default (runs the container)

**Option B: Using external cron on VPS**
```bash
# Edit crontab
crontab -e

# Add these lines (replace with your Dokploy project/app names)
0 8 * * * docker restart dokploy-tgvmax-autoconfirm
0 16 * * * docker restart dokploy-tgvmax-autoconfirm
```

### 5. Deploy

Click "Deploy" in Dokploy. The app will:
1. Build the Docker image
2. Run once and exit
3. Wait for next scheduled run

## Manual Testing

Test the deployment before scheduling:

```bash
# Via Dokploy UI
Click "Restart" or "Run" button

# Via Docker CLI on VPS
docker restart dokploy-tgvmax-autoconfirm

# Check logs
docker logs dokploy-tgvmax-autoconfirm -f
```

## Local Development

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
nano .env  # Fill in your credentials

# Build
npm run build

# Test (check only, no confirmation)
npm start -- --check

# Run confirmation
npm start
```

## Docker Compose (without Dokploy)

```bash
# Copy environment file
cp .env.example .env
nano .env

# Build and run
docker compose up --build

# Run in background
docker compose up -d

# Check logs
docker compose logs -f
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        Dokploy VPS                              │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │  Dokploy    │───▶│  Docker      │───▶│  SNCF Website    │   │
│  │  Schedule   │    │  Container   │    │  (confirmation)  │   │
│  └─────────────┘    └──────┬───────┘    └──────────────────┘   │
│                            │                                    │
│                     2FA Required?                               │
│                            │                                    │
│                            ▼                                    │
│                   ┌────────────────┐                           │
│                   │ Google Apps    │◀──── SNCF sends email     │
│                   │ Script Webhook │      to your Gmail        │
│                   └────────────────┘                           │
│                            │                                    │
│                            ▼                                    │
│                   ┌────────────────┐                           │
│                   │   Telegram     │                           │
│                   │   Bot          │                           │
│                   └────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

**Flow:**

1. **Scheduled trigger**: Dokploy runs the container at configured times
2. **Authentication**: Logs into SNCF MAX JEUNE espace (reuses session if valid)
3. **2FA handling**: If verification code required, fetches from Google Apps Script
4. **Scraping**: Finds pending reservations needing confirmation
5. **Confirmation**: Clicks confirm for reservations within 48h window
6. **Notifications**: Sends Telegram messages with results
7. **Exit**: Container stops until next scheduled run

## Troubleshooting

### Check Container Logs

In Dokploy:
```
Application → Logs → View Real-time Logs
```

Or via SSH:
```bash
docker logs dokploy-tgvmax-autoconfirm -f
```

### Session Expired

The script automatically re-authenticates. If issues persist:
```bash
# Remove session file (in volume)
docker exec dokploy-tgvmax-autoconfirm rm -f /app/data/session.json
```

### 2FA Code Not Found

- Verify Google Apps Script is deployed correctly
- Test the webhook:
  ```bash
  curl "YOUR_WEBHOOK_URL?secret=YOUR_SECRET"
  ```
- Check SNCF emails aren't filtered to spam

### Error Screenshots

Screenshots saved in the mounted volume at `/opt/dokploy/data/tgvmax-autoconfirm/screenshots/`

### Container Won't Start

Check environment variables in Dokploy:
```bash
docker exec dokploy-tgvmax-autoconfirm env | grep SNCF
```

### Rebuild from Scratch

In Dokploy:
1. Stop the application
2. Delete the application
3. Delete the volume data if needed
4. Recreate following the deployment steps above

## Environment Variables Reference

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SNCF_EMAIL` | Your SNCF account email | `user@gmail.com` |
| `SNCF_PASSWORD` | Your SNCF account password | `MyPassword123` |
| `WEBHOOK_URL` | Google Apps Script webhook URL | `https://script.google.com/macros/s/...` |
| `WEBHOOK_SECRET` | Secret key for webhook authentication | `abc123xyz789` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | Your Telegram user ID | `123456789` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `HEADLESS` | `true` | Run browser in headless mode |
| `SCREENSHOT_ON_ERROR` | `true` | Save screenshots when errors occur |
| `SESSION_PATH` | `/app/data/session.json` | Path to session file |

## Monitoring

### Telegram Notifications

You'll receive notifications for:
- ✅ Successful confirmations
- ❌ Failed confirmations
- 🔐 Authentication events
- ⚠️ Errors

### Dokploy Dashboard

Monitor:
- Last run time
- Exit code (0 = success)
- Resource usage
- Logs

## Security Notes

- ✅ **No email password stored** - uses Google Apps Script webhook
- ✅ **Runs in your own Google account** - full control
- ✅ **Environment variables** encrypted by Dokploy
- ✅ **Session cookies** stored in private volume
- ✅ **Runs as non-root** user in container

## Backup & Restore

### Backup Session Data

```bash
# On VPS
cd /opt/dokploy/data/tgvmax-autoconfirm
tar -czf backup-$(date +%Y%m%d).tar.gz session.json
```

### Restore

```bash
cd /opt/dokploy/data/tgvmax-autoconfirm
tar -xzf backup-YYYYMMDD.tar.gz
```

## Uninstall

In Dokploy:
1. Stop the application
2. Delete the application
3. Optionally delete volume data:
   ```bash
   sudo rm -rf /opt/dokploy/data/tgvmax-autoconfirm
   ```

## Disclaimer

This tool automates actions you would normally do manually on the SNCF website. It is for personal use only. Use at your own risk. Automated access may violate SNCF's terms of service.

## License

MIT
