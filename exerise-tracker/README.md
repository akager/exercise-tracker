# Rep Ledger

Workout logger. A static site plus one small API, hosted on Cloudflare Pages. Your data lives in a separate private GitHub repo as markdown and CSV files.

```
public/                 the site (no build step)
  index.html            the app
  format.js             file formats, shared with the API
functions/api/[[path]].js   API: reads and writes the data repo with a GitHub token kept on Cloudflare
```

## Setup (about 20 minutes)

### 1. Two private GitHub repos
- **rep-ledger**: upload everything in this folder.
- **rep-ledger-data**: upload the contents of the `rep-ledger-data` folder (`exercises/`, `log/`, `README.md`). The repo needs at least one commit on `main`.

### 2. GitHub token
GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
- Expiration: **No expiration**
- Repository access: **Only select repositories** → `rep-ledger-data`
- Permissions → Repository permissions → **Contents: Read and write** (Metadata: read-only gets added automatically)

Copy the token. You'll paste it into Cloudflare in step 4.

### 3. Cloudflare Pages project
Cloudflare dashboard → Workers & Pages → Create → **Pages** → Connect to Git → pick `rep-ledger`
- Framework preset: None
- Build command: *(leave empty)*
- Build output directory: `public`

Deploy. The site is at `https://<project>.pages.dev`. Until step 5 is done, the site loads but the API refuses every request.

### 4. Settings
Pages project → Settings → **Variables and Secrets** (Production):

| Name | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | the token from step 2 | **Secret** |
| `DATA_REPO` | `your-github-username/rep-ledger-data` | Text |

### 5. Lock it down with Cloudflare Access
Cloudflare dashboard → **Zero Trust** (pick the free plan if asked and choose a team name) → Access → Applications → **Add an application → Self-hosted**
- Application domain: `<project>.pages.dev`. Add a second one for `*.<project>.pages.dev` so preview deployments are covered too.
- Session duration: 1 month, so you rarely sign in at the gym
- Policy: **Allow**, Include → **Emails** → your email
- Login method: One-time PIN is fine (emails you a code). You can add GitHub or Google sign-in later.

Then copy two values into the Pages variables from step 4:

| Name | Where to find it |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Zero Trust → Settings → Custom Pages (or Team domain), e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | The Access application you just made → Overview → **Application Audience (AUD) Tag** |

### 6. Redeploy and install
Pages project → Deployments → latest → **Retry deployment**, so the new variables take effect.
On your phone, open the site, sign in, then Share → **Add to Home Screen**.

## How it saves
- Changes queue on the device and go to GitHub as **one commit** a second or two later. Finishing a workout is a single commit.
- A workout in progress stays on that device until you finish it, so a dead signal mid-set loses nothing.
- If you're offline, the header shows how many changes are waiting, and they're sent when you reconnect.
- If two devices save at the same moment, the API retries on top of the newer commit.
- Editing files in Obsidian or on GitHub is fine. The app picks up changes the next time you open it.

## Troubleshooting
- **"Signed out? Tap to reload"**: your Access session expired. Reloading shows the sign-in page.
- **"Couldn't load your data from GitHub"**: the message says what's wrong. Usually it's a typo in `DATA_REPO`, a token without access to the data repo, or a variable added without redeploying.
- **Token leaked?** Revoke it on GitHub, make a new one, and update `GITHUB_TOKEN` in Cloudflare.
