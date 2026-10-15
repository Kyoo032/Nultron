/**
 * DEPLOY.md for the Enterprise release bundle (Kyoo032/Nultron-Releases), as text. Split out of release-web.mjs so
 * that file stays a release script and not a manual. Pure: no I/O, and nothing here reads the repo.
 *
 * Everything in it is published, so it passes the same mark check as the rest of the bundle
 * (scripts/release-marks.mjs): no tool or assistant names, and the word "agent" only inside the product's own
 * name. The doc names the people-facing facts (DNS, mail, the move to a bigger server); the reasons behind them
 * are in webapp-deploy/README.md and docs/internal/security-register.md, which are not published.
 */

/** The headings scripts/release-web.test.mjs and scripts/multisite-edge.test.mjs look for. */
export const DEPLOY_DOC_SECTIONS = Object.freeze({
  sites: "## Hosting the company sites on the same server",
  mail: "## Sign-in mail: Tencent Cloud SES, and only that",
  move: "## After the 1-month test: move to Tencent CVM",
});

/** Everything that is not the numbered first deploy: the company sites, the sign-in mail, the move to a CVM. */
function extraSections() {
  return `${DEPLOY_DOC_SECTIONS.sites}

The same Caddy that fronts Nultron can also serve two static company websites. They are optional and off by
default: with the two variables below unset, the proxy serves exactly Nultron's two names, as in every earlier
release. Each site is its own file in \`sites/\`, serves its own read-only web root, sends its own security
headers and writes its own access log (\`logger\` = \`dpscloud\` or \`tokotoken\`), and cannot reach the app or the
portal.

| Set in \`.env\` | What it serves | A records that point at this server |
|---|---|---|
| \`NULTRON_DOMAIN\`, \`PORTAL_DOMAIN\` | Nultron and its sign-in (always on) | \`nultron-ai.xyz\`, \`portal.nultron-ai.xyz\` |
| \`DPS_DOMAIN=dpscloud.co.id\` | the DPS Cloud website | \`dpscloud.co.id\`, \`www.dpscloud.co.id\` |
| \`TOKOTOKEN_DOMAIN=tokotokenai.com\` | the Toko Token website | \`tokotokenai.com\`, \`www.tokotokenai.com\` |

1. **DNS first.** Add an A record (IPv4, no AAAA record) for every name in the table to this server's public
   address, and keep TCP 80 and 443 and UDP 443 open. Caddy asks Let's Encrypt for a certificate for each name the
   moment it starts, and Let's Encrypt can only validate a name that already resolves here, over port 80.
2. Only then set \`DPS_DOMAIN\` and/or \`TOKOTOKEN_DOMAIN\` in \`.env\` and run \`docker compose up -d\` (this
   recreates the proxy, so every site on the server is unreachable for a few seconds).
3. Check: \`docker compose logs proxy | grep enable-sites\` says \`dpscloud is on\` / \`tokotoken is on\`, and
   \`curl -sI https://<the domain>\` shows \`Strict-Transport-Security\`, \`Content-Security-Policy\` and no \`Server\`
   header.
4. The pages in \`sites/dpscloud/\` and \`sites/tokotoken/\` are **placeholders**. To serve the real website, put its
   files in a folder outside this one, set \`DPS_WEB_ROOT=/srv/sites/dpscloud\` (or \`TOKOTOKEN_WEB_ROOT\`) in
   \`.env\` and run \`docker compose up -d\`. Files in a web root are read from disk on every request, so editing
   them later needs no restart. The root is mounted read-only. Keep the real site's files out of this folder: it
   is replaced on every release.

**\`api.tokotokenai.com\` is not served from here, and its DNS record must be left exactly as it is.** It is the live
model gateway and is hosted elsewhere. This deployment has no wildcard (\`*.tokotokenai.com\`) and no catch-all
site, the Toko Token block names \`tokotokenai.com\` and \`www.tokotokenai.com\` only, and the proxy refuses to start
if any of the four domain variables is \`api.tokotokenai.com\` or a name under it. Change only the A records for the
names in the table above. Do not point a wildcard record at this server.

**This server runs no mail.** No mailbox, no inbound mail and no MX record points here. The company's MX records
(and the SPF that goes with them) stay at the mailbox provider; adding the A records above does not touch them.

${DEPLOY_DOC_SECTIONS.mail}

**Only needed if you set \`PORTAL_SIGNIN_MODE=code\`.** With the bundle's default (\`password\`) Nultron sends no e-mail
and you can skip this whole section. In \`code\` mode Nultron sends e-mail for one reason: the one-time code on the
sign-in screen. It goes through Tencent Cloud SES
(the International site, Singapore) over SMTP, and through nothing else. The DPS Cloud and Toko Token websites send
no e-mail.

Set these in \`portal.env\` (the template already carries the first three and the sender):

| Variable | Value |
|---|---|
| \`PORTAL_SMTP_HOST\` | \`sg-smtp.qcloudmail.com\` |
| \`PORTAL_SMTP_PORT\` | \`465\` |
| \`PORTAL_SMTP_SECURE\` | \`1\`: TLS from the first byte, which is what port 465 speaks |
| \`PORTAL_SMTP_USER\` | the sender address, in full: \`no-reply@mail.dpscloud.co.id\` |
| \`PORTAL_SMTP_PASS\` | the SMTP password you set for that address in the SES console (not the Tencent Cloud login, not an API key) |
| \`PORTAL_SMTP_FROM\` | \`Nultron <no-reply@mail.dpscloud.co.id>\`: the display name people see and the sender address. The address must be the verified sender |

The sender domain is \`mail.dpscloud.co.id\`. In the SES console add it as a sender domain, create the sender address
\`no-reply@mail.dpscloud.co.id\` on it, set its SMTP password, and publish the DNS records the console shows. They are
TXT records on that subdomain, at these names; copy the values from the console exactly:

| Record | Name | Value |
|---|---|---|
| SPF (TXT) | \`mail.dpscloud.co.id\` | the SPF value SES shows |
| DKIM (TXT) | the selector SES shows, then \`._domainkey.mail.dpscloud.co.id\` | the DKIM key SES shows |
| DMARC (TXT) | \`_dmarc.mail.dpscloud.co.id\` | start with \`v=DMARC1; p=none\`, and tighten it once codes arrive reliably |

These records live on a subdomain, so the main domain's mail records are untouched. If the console also asks for an MX
record on the sender subdomain, it points at Tencent's own host, never at this server. SES allows one sender about 10
e-mails an hour to the same recipient, and SMTP sending needs an enterprise (business) verified Tencent Cloud
account: new accounts under individual real-name verification can no longer send over SMTP. Send a test code to each provider your
users have before you rely on it.

${DEPLOY_DOC_SECTIONS.move}

The pilot runs on one Tencent Cloud Lighthouse instance in Jakarta. When the one-month test is over and it needs more
CPU or memory, move the whole stack to a bigger Tencent Cloud CVM in the same region. Tencent can share a Lighthouse
custom image to CVM when both are in the same region under the same account
(https://www.tencentcloud.com/document/product/1103/46403; Ubuntu 16.04 and later is on its list of supported
systems), so the new server starts as a copy of this one: images, volumes, \`.env\`, \`portal.env\` and the
certificates Caddy already holds.

1. **A day before:** lower the TTL of every A record in the tables above (six names) to 300 seconds, or the lowest
   your DNS host allows. Leave the \`api.tokotokenai.com\` record out of this: it is not yours to move.
2. **Back up, encrypted.** Copy the source repository's \`webapp-deploy/scripts/\` folder next to \`compose.yml\` and run
   \`BACKUP_KEY=<passphrase> sh scripts/backup.sh\`. It writes one encrypted archive of the app's data and one of the
   portal's database, and checks that each decrypts. Keep both somewhere that is not this server.
3. **Stop the stack:** \`docker compose stop\`. From here until step 8 the site is down, and nothing can be written, so
   the image taken next cannot miss data. (To keep serving during the move instead, leave the stack running, and
   before step 8 stop it, take a second backup, and restore that backup on the CVM with the scripts' \`restore.sh\`
   and \`restore-portal.sh\`.)
4. **Create a Lighthouse custom image** of the instance in the Lighthouse console and wait until it is available.
   Then share it to CVM: Images, Custom image, More, Share/Unshare.
5. **Launch a bigger CVM in the same region** from that image. Give it the same firewall: TCP 80 and 443, UDP 443
   from IPv4 anywhere, TCP 22 from your own address only, and no IPv6.
6. **Start the stack on the CVM** (\`docker compose up -d\`) and check it before any DNS change: \`docker compose ps\`
   shows \`app\` and \`portal\` healthy, and from your own machine
   \`curl --resolve nultron-ai.xyz:443:<CVM address> https://nultron-ai.xyz/healthz\` answers 200. Sign in once with
   a real account (a real code, if you run \`code\` mode). Do the same \`--resolve\` check for each company site you serve.
7. **Restore anything written since the image**, if you took the second backup in step 3.
8. **Switch the A records** of all three domains (the six names) to the CVM's address. Watch \`docker compose logs
   proxy\` on the CVM while traffic moves, and check each name from outside.
9. **Keep the Lighthouse instance, stopped, for seven days** as the fallback: to go back, start its stack and point the
   A records back. Never run both stacks at the same time (each keeps its own database, and the app and the portal
   are one process each). After seven days release the instance and delete the custom image.

The alternative is a fresh install: a new CVM, this bundle, and a restore of the two encrypted backups. It is slower,
and it starts from a clean operating system with nothing carried over. One machine is as far as this bundle goes: the
\`webapp-deploy/k8s/\` manifests in the source repository are the later step beyond one server.
`;
}

/** DEPLOY.md for one release. `app` and `portal` are the two pinned image references. */
export function deployDocText(tag, app, portal) {
  return `# Deploy Nultron Enterprise ${tag}

This folder runs one release of the hosted app on one server: the app image \`${app}\`, the portal
image \`${portal}\` (where people sign in) with its own Postgres, and a Caddy proxy in front of
both. Nothing is built on the server. One of each service: do not scale any of them.

1. \`docker login ghcr.io\` with a GitHub token that can read packages. Both images are private.
2. \`cp .env.example .env\` and \`cp portal.env.example portal.env\`, fill in every name in both (except the
   \`PORTAL_SMTP_*\` ones, which password sign-in does not use), and keep both off git (\`chmod 600\`). Generate \`AGENTFORGE_SECRETS_KEY\` and \`PORTAL_SIGNING_KEY\` once and keep them: a
   new wrap key cannot read the old data, and a new signing key signs everyone out.
3. Point two DNS A records, \`NULTRON_DOMAIN\` and \`PORTAL_DOMAIN\`, at this server (no AAAA record) and open
   TCP 80 and 443 and UDP 443, inbound, IPv4 only.
4. Start the portal first, because the app will not boot without the client secret it prints:
   \`docker compose pull && docker compose up -d portal\` (this starts its database and migrations too).
5. Seed the first tenant and user. The secret is shown once:
   \`docker compose exec -T portal sh /app/webapp-deploy/portal-entry.sh ./node_modules/.bin/tsx scripts/seed.ts --email <you> --redirect https://<NULTRON_DOMAIN>/auth/callback\`
   Put the client secret it prints in \`.env\` as \`AGENTFORGE_PORTAL_CLIENT_SECRET\`.
6. \`docker compose up -d\`, then \`docker compose ps\` until \`app\` and \`portal\` are \`healthy\`.
7. Create the first owner account, **before anyone can sign in**. This bundle signs people in with a username and a
   password (\`PORTAL_SIGNIN_MODE=password\` in \`portal.env\`), and the seed made the owner without one. Give that person
   a password with the portal's account command, using the same address you gave the seed:
   \`docker compose exec -T portal sh /app/webapp-deploy/portal-entry.sh ./node_modules/.bin/tsx scripts/account.ts create --username <name> --email <you> --role owner\`
   It prints a generated initial password **once**: hand it to the person, who must choose their own at first
   sign-in. Add everyone else the same way (\`--role admin\` or \`member\`, up to the seat cap); \`account.ts\` also has
   \`list\`, \`reset-password\`, \`disable\`, \`enable\` and \`set-role\`. There is no self-sign-up, no self-service
   password reset (a forgotten password is \`reset-password\`) and no second factor yet (SR-165 in the source
   repository's security register records what that leaves open). Then open \`https://<NULTRON_DOMAIN>\` and sign in.

**No mail sender is needed in this mode.** In password mode no e-mail is sent, so the \`PORTAL_SMTP_*\` settings
in \`portal.env\` may stay blank and the SES setup in the "Sign-in mail" section below can be skipped. To sign
people in with an e-mailed one-time code instead, set \`PORTAL_SIGNIN_MODE=code\` in \`portal.env\`, fill in every
\`PORTAL_SMTP_*\` value (a portal in \`code\` mode refuses to boot in production without a real mail host), recreate the
portal, and create people with the portal's \`invite\` script instead of \`account\`. The two values are exactly
\`password\` and \`code\`; anything else stops the portal at boot.

**Already running in \`code\` mode?** An update never touches your \`portal.env\`, so the mode stays as you set it. If
you choose to switch to \`password\`, create an account for everyone first (\`account.ts create\`): a person who was only
invited, or seeded under \`code\` mode, has no password and cannot sign in until one exists, and \`create\` refuses a
person still in \`invited\` status, so finish their invite first.

Back up the \`nultron-data\` and \`portal-pgdata\` volumes before an upgrade: the databases migrate forward only. To
roll back, check out the previous release tag of this repo and repeat step 6 (the accounts from step 7 already exist,
and \`account create\` refuses to run twice for the same person).

${extraSections()}`;
}
