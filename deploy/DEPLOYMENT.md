# BOARDLINK — Deployment Guide

For the CSPC MICT Center. Deploys BOARDLINK on a CSPC-managed
server, reachable from outside the campus, with all records and
all AI processing staying on that machine.

---

## 1. Before anything else

Confirm with MICT:

- [ ] A subdomain, e.g. `boardlink.cspc.edu.ph`, pointing at this server
- [ ] Inbound ports **80** and **443** open to it
- [ ] Whether the campus has a **public IP** or is behind **CGNAT**
      (if CGNAT, port forwarding cannot work — use a tunnel instead)

## 2. Server requirements

Ollama running Llama 3.1 8B needs roughly 6 GB resident on its own.

| | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 16 GB | 16 GB+ |
| Disk | 256 GB SSD | 512 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

8 GB is **not** sufficient with the AI services running.

## 3. Install

```bash
sudo adduser --system --group --home /opt/boardlink boardlink
sudo apt update && sudo apt install -y nodejs npm mysql-server caddy

sudo -u boardlink git clone <repo> /opt/boardlink   # or copy the files
cd /opt/boardlink
sudo -u boardlink npm ci --omit=dev

sudo mkdir -p uploads backups logs
sudo chown -R boardlink:boardlink /opt/boardlink
```

### Database

```bash
sudo mysql -e "CREATE DATABASE boardlink CHARACTER SET utf8mb4;"
sudo mysql -e "CREATE USER 'boardlink'@'localhost' IDENTIFIED BY 'STRONG-PASSWORD-HERE';"
sudo mysql -e "GRANT ALL ON boardlink.* TO 'boardlink'@'localhost';"
sudo mysql boardlink < sql/schema.sql
```

The `user_sessions` table is created automatically on first run.

### Configuration

```bash
cp .env.example .env
# Generate a real session secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then edit `.env` and set at minimum:

```
NODE_ENV=production
SESSION_SECRET=<the value generated above>
DB_USER=boardlink
DB_PASSWORD=<the password set above>
TRUST_PROXY=1
```

**The application refuses to start in production while
`SESSION_SECRET` is still the default.** That is deliberate — the
default is published in this repository, so anyone could forge a
session cookie.

```bash
chmod 600 .env      # contains database and session credentials
```

### AI services

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
# whisper.cpp and Meilisearch as per Chapter 3 Sec. 3.6
```

OCR needs no installation or internet: `tessdata/eng.traineddata`
ships with the application.

### Editing an agenda document's words in Word

The Board Secretary can send an agenda item's PDF out as a Word file,
correct the wording in Microsoft Word, and send it back; BOARDLINK
turns it into a PDF again and moves members' comments onto their
words. Two programs make that possible:

**On the Ubuntu server** (where BOARDLINK runs — not on anyone's own
computer):

```bash
sudo apt install -y libreoffice-writer python3-pip
sudo pip3 install pdf2docx --break-system-packages
```

**On a Windows laptop** (for a demo or defence, where BOARDLINK runs
with XAMPP), install the same two things the Windows way, on the laptop
that runs `npm start`:

1. LibreOffice — <https://www.libreoffice.org/download/> — the normal
   installer, default location.
2. Python — <https://www.python.org/downloads/> — and tick
   **“Add python.exe to PATH”** on the first screen of the installer.
3. Then, in Command Prompt:

   ```
   pip install pdf2docx
   ```

Nothing needs to be added to `.env`: BOARDLINK looks for `python` and
for `C:\Program Files\LibreOffice\program\soffice.exe` by itself. If
either was installed somewhere unusual, set `PDF2WORD_PYTHON` and
`SOFFICE_BIN` in `.env` to their full paths. Restart BOARDLINK after
installing, because it remembers what it found at start-up.

The Secretary edits the Word file on her own computer, in her own copy
of Microsoft Word. Only the computer that **runs** BOARDLINK needs
these two programs.

* `pdf2docx` turns the PDF into Word. LibreOffice's own PDF import is
  **not** used: it puts every line of the page in its own fixed-size
  box, so a word made longer is silently cut off. `pdf2docx` produces
  ordinary Word paragraphs that re-flow as they are edited.
* `libreoffice-writer` turns the edited Word file back into a PDF.

Neither needs the internet after installation. Until they are
installed the feature simply says so on the page and nothing else is
affected — every other part of BOARDLINK works without them. If they
live somewhere unusual, point `PDF2WORD_PYTHON` and `SOFFICE_BIN` at
them in `.env`.

A **scanned** document (a picture of printed paper) has no words to
edit, so BOARDLINK refuses it and says why. Those documents can still
have their pages reordered, turned, removed or added to.

## 4. Run as a service

```bash
sudo cp deploy/boardlink.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now boardlink
systemctl status boardlink
```

## 5. HTTPS

Edit `deploy/Caddyfile` so the hostname matches the subdomain MICT
issued, then:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the certificate automatically.

## 6. Backups

```bash
sudo cp deploy/boardlink-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now boardlink-backup.timer
sudo /opt/boardlink/scripts/backup.sh     # test it once now
```

**Copy `backups/` to storage on another machine.** A backup on the
same disk does not survive a disk failure, theft or fire. The
scanned resolutions go back to 1985 and cannot be recreated.

## 7. Verify

- [ ] `https://boardlink.cspc.edu.ph` loads with a valid certificate
- [ ] Sign-in works and survives `sudo systemctl restart boardlink`
      (this is what the MySQL session store is for)
- [ ] Upload a scanned resolution — fields autofill
- [ ] **Unplug the internet and repeat the upload.** OCR,
      transcription, summarisation and search must all still work.
      This is the "Local AI Processing Verification" acceptance test.
- [ ] Reboot the server; everything comes back unattended

## 8. Routine care

| Task | Frequency |
|---|---|
| Confirm backups ran (`systemctl list-timers`) | Weekly |
| Restore a backup to a test machine | Once a term |
| `sudo apt update && sudo apt upgrade` | Monthly |
| Review `journalctl -u boardlink \| grep rate-limit` | Monthly |

## Troubleshooting

**Nobody can sign in after enabling HTTPS** — `TRUST_PROXY` is not
set. Express sees proxied requests as insecure and refuses to send
the secure cookie.

**Everyone signed out after a restart** — the MySQL session store
could not be reached and fell back to memory. Check the log for
"Using in-memory sessions".

**"Too many sign-in attempts for this account"** — ten failed
attempts on one Gmail address within 15 minutes. It clears itself after
15 minutes. Note this is keyed per account, not per address, so it
never locks out an office sharing one connection.

**OCR asks for the details manually** — check that
`tessdata/eng.traineddata` exists and is readable by the
`boardlink` user.
