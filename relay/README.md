# Report relay

Lets people send a device report or support request from the app **without a GitHub account**.
The app posts the report here; this Cloudflare Worker opens the issue as the project's GitHub App
(`battery-hub-relay[bot]`) and gives the app a reply key, so the same person can answer questions
from the app later. Replies are read straight from GitHub by the app (issues are public).

Nothing personal is sent: the report is the same text the app would put in a GitHub link.
Limits: 5 reports and 20 answers per network per hour, 30,000 characters per report, no @mentions.

## Setup (once)

1. **GitHub App** on the `battery-hub` organization (Settings → Developer settings → GitHub Apps → New):
   - name `battery-hub-relay`, homepage the project site, webhook **off**
   - permissions: **Issues: Read and write**, nothing else
   - install it on `battery-hub/battery-hub` only
   - note the **App ID** and the **installation id** (the number at the end of the installation's URL)
   - generate a **private key**. GitHub gives PKCS#1; Workers need PKCS#8:
     `node -e "process.stdout.write(require('crypto').createPrivateKey(require('fs').readFileSync(process.argv[1])).export({type:'pkcs8',format:'pem'}))" key.pem > key-pkcs8.pem`
2. **Cloudflare** (free plan), in this folder:
   ```
   npx wrangler login
   npx wrangler kv namespace create RELAY        # put the id in wrangler.toml
   npx wrangler secret put APP_ID
   npx wrangler secret put INSTALLATION_ID
   npx wrangler secret put APP_PRIVATE_KEY      # paste key-pkcs8.pem
   npx wrangler deploy
   ```
3. Put the Worker's URL in `RELAY_URL` in `src/main/relay.js`. Until then the app hides the option.

## API

- `POST /report` `{ template: "device-support" | "works" | "support-request", fields }` → `{ number, url, key }`
- `POST /comment` `{ number, key, text }` → `{ ok: true }`
