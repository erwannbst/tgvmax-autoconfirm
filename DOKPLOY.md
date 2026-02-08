# Quick Dokploy Deployment Guide

## 1. Prerequisites Setup

### Google Apps Script (5 minutes)
1. Go to https://script.google.com
2. New project → Paste `google-apps-script/Code.gs`
3. Project Settings → Script Properties → Add:
   - Name: `SECRET_KEY`
   - Value: `openssl rand -hex 32` (run this locally)
4. Deploy → New deployment → Web app:
   - Execute as: Me
   - Access: Anyone
5. Copy deployment URL

### Telegram Bot (2 minutes)
1. Message @BotFather → `/newbot` → Copy token
2. Message @userinfobot → Copy chat ID

## 2. Dokploy Configuration

### Create Application
1. Dokploy → "Create Application"
2. Name: `tgvmax-autoconfirm`
3. Source: GitHub/Git repository or Docker Compose

### Environment Variables
```env
SNCF_EMAIL=your.email@gmail.com
SNCF_PASSWORD=your_sncf_password
TELEGRAM_BOT_TOKEN=123456789:ABC...
TELEGRAM_CHAT_ID=123456789
HEADLESS=true
SCREENSHOT_ON_ERROR=true
```

### Volume Mount
- **Host**: `/opt/dokploy/data/tgvmax-autoconfirm`
- **Container**: `/app/data`
- **Purpose**: Persists session between runs

### Scheduling

#### Option A: Dokploy Built-in (Recommended)
If Dokploy has a scheduling feature:
- Schedule: `0 8,16 * * *` (8 AM and 4 PM)
- Action: Restart container

#### Option B: System Cron
SSH to VPS:
```bash
crontab -e

# Add (adjust container name if needed):
0 8 * * * docker restart <dokploy-container-name>
0 16 * * * docker restart <dokploy-container-name>
```

Find container name:
```bash
docker ps | grep tgvmax
```

## 3. Deploy & Test

### Deploy
Click "Deploy" in Dokploy

### Manual Test
```bash
# Via Dokploy UI
Application → Restart

# Or via CLI
docker restart <container-name>
docker logs <container-name> -f
```

### Check Success
Look for in logs:
```
✅ Successfully authenticated to SNCF Connect
✅ No reservations requiring confirmation
```

Or if you have bookings:
```
🔍 Found X reservation(s) to confirm
✅ Reservation confirmed!
```

## 4. Monitoring

### Telegram
You'll receive real-time notifications for:
- Authentication status
- Reservations found
- Confirmation results
- Any errors

### Dokploy Dashboard
- View logs
- Check exit codes (0 = success)
- Monitor resource usage

## Quick Reference

| Action | Command |
|--------|---------|
| View logs | `docker logs <name> -f` |
| Restart | `docker restart <name>` |
| Clear session | `docker exec <name> rm /app/data/session.json` |
| Test webhook | `curl "WEBHOOK_URL?secret=SECRET"` |

## Troubleshooting

### Container exits immediately
- Check environment variables are set
- View logs for error details

### 2FA fails
- Test webhook endpoint
- Check Google Apps Script is deployed
- Verify SNCF emails not in spam

### Session issues
```bash
docker exec <name> rm /app/data/session.json
docker restart <name>
```

## Rebuild Instructions

If you need to start fresh:

1. Stop application in Dokploy
2. Delete application
3. Optional: Delete volume data
   ```bash
   sudo rm -rf /opt/dokploy/data/tgvmax-autoconfirm
   ```
4. Follow deployment steps again

Everything will rebuild from scratch!
