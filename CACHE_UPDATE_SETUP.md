# Automated Cache Update Setup

This guide explains how to automatically update the dining and shows cache files from your Mac.

---

## Option 1: Manual Update (Simplest)

Run this whenever you want to update the cache:

```bash
cd ~/projects/ride-monitor-backend
node updateCache.js
```

This will:
1. Scrape dining data
2. Scrape shows data
3. Commit changes to git
4. Push to GitHub (Heroku auto-deploys)

---

## Option 2: Automated Daily Updates (Mac launchd)

### Step 1: Find Your Node Path

```bash
which node
```

Copy the path (e.g., `/usr/local/bin/node` or `/opt/homebrew/bin/node`)

### Step 2: Edit the plist File

Open `com.tourguide.updatecache.plist` and update:

```xml
<string>/usr/local/bin/node</string>  <!-- Change to your node path -->
<string>/Users/jameslaurie/projects/ride-monitor-backend/updateCache.js</string>  <!-- Verify path -->
```

### Step 3: Install the Launch Agent

```bash
# Copy to LaunchAgents folder
cp com.tourguide.updatecache.plist ~/Library/LaunchAgents/

# Load it
launchctl load ~/Library/LaunchAgents/com.tourguide.updatecache.plist

# Verify it's loaded
launchctl list | grep tourguide
```

### Step 4: Test It

```bash
# Run it manually to test
launchctl start com.tourguide.updatecache

# Check the logs
tail -f cache-update.log
tail -f cache-update-error.log
```

### Configuration

The plist is configured to run daily at 2:00 AM. To change:

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key>
    <integer>14</integer>  <!-- Change to your preferred hour (24-hour format) -->
    <key>Minute</key>
    <integer>30</integer>  <!-- Change to your preferred minute -->
</dict>
```

### Uninstall (if needed)

```bash
launchctl unload ~/Library/LaunchAgents/com.tourguide.updatecache.plist
rm ~/Library/LaunchAgents/com.tourguide.updatecache.plist
```

---

## Option 3: Weekly Manual Update

Set a calendar reminder for yourself:
- Every Sunday at 9 AM
- Run: `cd ~/projects/ride-monitor-backend && node updateCache.js`

---

## Logs

Check logs to verify updates:

```bash
# View update log
cat cache-update.log

# View errors
cat cache-update-error.log

# Watch in real-time
tail -f cache-update.log
```

---

## How It Works

```
Your Mac (2 AM daily)
    ↓
  Runs updateCache.js
    ↓
  Scrapes Disney.com with Puppeteer
    ↓
  Updates cache files
    ↓
  Git commit & push to GitHub
    ↓
  Heroku auto-deploys from GitHub
    ↓
  Updated data live on server!
```

---

## Troubleshooting

### "Permission denied" error
```bash
chmod +x updateCache.js
```

### "Git push failed"
Make sure you have SSH keys set up for GitHub:
```bash
ssh -T git@github.com
```

### "Node not found"
Update the node path in the plist file with the correct path from `which node`

### Mac is asleep at 2 AM
Your Mac needs to be awake (or use `pmset` to wake for network access):
```bash
sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00
```

Or change the schedule to a time when your Mac is typically on (like 2 PM instead of 2 AM).

---

## Best Practice

**Recommended: Option 1 (Manual) + Calendar Reminder**

- Most reliable
- You see when it runs
- Can verify results immediately
- No dependencies on Mac being awake

Just run `node updateCache.js` once a week!
