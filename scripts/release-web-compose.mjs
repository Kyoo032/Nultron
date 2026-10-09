/**
 * The released compose file (the bundle's compose.yml) as text. Split out of release-web.mjs, which re-exports
 * it as composeFile(tag). Pure: the four image references are arguments.
 *
 * It carries the same services as webapp-deploy/compose.yml with the hardening kept in step
 * (scripts/pilot-deploy.test.mjs compares them service by service), images pinned to the release tag and
 * nothing built on the server. The comments live in the source file; this one is generated.
 */
export function composeFileText({ tag, app, portal, proxy, database }) {
  return `# Nultron Enterprise ${tag}. Run it with DEPLOY.md. Generated per release; do not edit here.
# One of each service, on purpose: the app's and the portal's limiters and refresh lock live in
# process memory, so a second replica of either would double every ceiling.
name: nultron-ent

services:
  app:
    image: ${app}
    # .env is the APP's. The portal's secrets are in portal.env, which only the portal side loads.
    env_file:
      - path: .env
        required: true
    environment:
      NODE_ENV: production
      PORT: "3000"
      AGENTFORGE_SERVER: "1"
      AGENTFORGE_DATA_DIR: /data
      AGENTFORGE_COMPONENTS_DIR: /opt/agentforge/components
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
      NPM_CONFIG_CACHE: /tmp/.npm
      AGENTFORGE_SECRETS_KEY: \${AGENTFORGE_SECRETS_KEY:-}
    # The app reaches the portal over https, through the proxy that shares this network namespace: the
    # portal's public name resolves to this container's own loopback, where the proxy listens on 443.
    extra_hosts:
      - "\${PORTAL_DOMAIN:?set it in .env}:127.0.0.1"
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=512m,nosuid,nodev,noexec
    volumes:
      - nultron-data:/data
      - nultron-components:/opt/agentforge/components
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 512
    mem_limit: 6g
    mem_reservation: 1g
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    # The app binds loopback; the proxy shares this network namespace, so the ports live here. The
    # explicit 0.0.0.0 keeps Docker from also binding [::] on a box with a public IPv6 address.
    ports:
      - "0.0.0.0:80:80"
      - "0.0.0.0:443:443"
      - "0.0.0.0:443:443/udp"
    restart: unless-stopped

  proxy:
    image: ${proxy}
    network_mode: "service:app"
    depends_on:
      - app
    # The entrypoint switches the optional company sites on or off before Caddy starts: a site runs only when
    # its domain variable is set, and with both unset only Nultron's two names are served.
    entrypoint:
      - sh
      - /etc/caddy/sites/enable-sites.sh
    command:
      - caddy
      - run
      - --config
      - /etc/caddy/Caddyfile
      - --adapter
      - caddyfile
    # The Caddyfile and the site files read these four names and nothing else, so the secrets in .env stay
    # with the app. The two company names are optional: empty means that site is not served.
    environment:
      NULTRON_DOMAIN: \${NULTRON_DOMAIN:?set it in .env}
      PORTAL_DOMAIN: \${PORTAL_DOMAIN:?set it in .env}
      DPS_DOMAIN: \${DPS_DOMAIN:-}
      TOKOTOKEN_DOMAIN: \${TOKOTOKEN_DOMAIN:-}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./sites:/etc/caddy/sites:ro
      - \${DPS_WEB_ROOT:-./sites/dpscloud}:/srv/dpscloud:ro
      - \${TOKOTOKEN_WEB_ROOT:-./sites/tokotoken}:/srv/tokotoken:ro
      - caddy-data:/data
      - caddy-config:/config
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=64m,nosuid,nodev,noexec
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    init: true
    pids_limit: 128
    mem_limit: 512m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

  portal-db:
    image: ${database}
    user: "999:999"
    env_file:
      - path: portal.env
        required: true
    environment:
      POSTGRES_USER: portal
      POSTGRES_DB: tokotoken_portal
      POSTGRES_INITDB_ARGS: "--encoding=UTF8 --locale=C"
      PGDATA: /var/lib/postgresql/data/pgdata
    entrypoint:
      - sh
      - -c
      - exec env -u PORTAL_SIGNING_KEY -u PORTAL_SMTP_USER -u PORTAL_SMTP_PASS -u PORTAL_APP_DB_PASSWORD POSTGRES_PASSWORD="$$PORTAL_POSTGRES_PASSWORD" docker-entrypoint.sh postgres
    volumes:
      - portal-pgdata:/var/lib/postgresql/data
    read_only: true
    tmpfs:
      - /var/run/postgresql:mode=0755,uid=999,gid=999
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
    networks:
      - portal-db
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U portal -d tokotoken_portal"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 200
    mem_limit: 1g
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

  portal-prepare:
    image: ${portal}
    env_file:
      - path: portal.env
        required: true
    environment:
      NODE_ENV: production
      PORTAL_DATA_DIR: /portal-data
      PORTAL_PUBLIC_URL: https://\${PORTAL_DOMAIN:?set it in .env}
      PORTAL_TRUST_PROXY: "1"
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
    entrypoint:
      - sh
      - /app/webapp-deploy/portal-entry.sh
    command:
      - node
      - /app/webapp-deploy/k8s/base/scripts/prepare-db.mjs
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
      - /portal-data:mode=0700,size=16m,uid=1000,gid=1000
    networks:
      - portal-db
    depends_on:
      portal-db:
        condition: service_healthy
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 128
    mem_limit: 768m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: "no"

  portal:
    image: ${portal}
    env_file:
      - path: portal.env
        required: true
    environment:
      NODE_ENV: production
      PORTAL_HOST: 0.0.0.0
      PORTAL_PORT: "4000"
      PORTAL_DATA_DIR: /portal-data
      PORTAL_PUBLIC_URL: https://\${PORTAL_DOMAIN:?set it in .env}
      PORTAL_TRUST_PROXY: "1"
      TMPDIR: /tmp
      XDG_CACHE_HOME: /tmp/.cache
    entrypoint:
      - sh
      - /app/webapp-deploy/portal-entry.sh
    command:
      - ./node_modules/.bin/tsx
      - src/main.ts
    depends_on:
      portal-prepare:
        condition: service_completed_successfully
    read_only: true
    tmpfs:
      - /tmp:mode=1777,size=128m,nosuid,nodev,noexec
      - /portal-data:mode=0700,size=16m,uid=1000,gid=1000
    networks:
      - default
      - portal-db
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:'+(process.env.PORTAL_PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 60s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    init: true
    pids_limit: 256
    mem_limit: 768m
    mem_reservation: 128m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    restart: unless-stopped

networks:
  portal-db:
    internal: true

volumes:
  nultron-data:
  nultron-components:
  caddy-data:
  caddy-config:
  portal-pgdata:
`;
}
