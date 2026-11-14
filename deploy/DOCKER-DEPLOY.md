# DOMA TECH — Docker deployment guide

This guide deploys the separate Node.js/SQLite server scaffold. It does not change or power the static GitHub Pages demo.

## Prerequisites

- A supported Linux host with Docker Engine and the Docker Compose plugin.
- A trusted reverse proxy with TLS if the service must be reachable from the internet.
- A protected method to store and back up the environment file and persistent data.
- A dedicated host account/operator with permission to manage the deployment.

## 1. Prepare the deployment

Clone the repository and enter its directory. Create the environment file:

~~~bash
cp .env.example .env
~~~

Edit `.env` and set at least:

- `NODE_ENV=production`
- `SESSION_SECRET`: a cryptographically random secret of at least 32 characters.
- `ADMIN_USERNAME`: a non-default administrator name.
- `ADMIN_PASSWORD`: a unique, strong password.

Generate a secret locally with:

~~~bash
openssl rand -hex 32
~~~

Do not commit `.env`, paste secrets into support tickets, or put credentials in shell history. Restrict its permissions:

~~~bash
chmod 600 .env
~~~

The application creates its first administrator from these credentials only when that username does not already exist. Changing `ADMIN_PASSWORD` later does not automatically change an existing account's password hash; use a separately reviewed password-rotation procedure.

## 2. Prepare persistent directories

The image runs as the non-root `node` user (normally UID/GID 1000). Bind-mounted host directories must be writable by that identity:

~~~bash
mkdir -p data uploads
sudo chown -R 1000:1000 data uploads
chmod 700 data uploads
~~~

If the image UID/GID changes, inspect it with `docker run --rm doma-tech:local id` and adjust ownership deliberately. Do not solve permission errors by making these directories world-writable.

## 3. Build and start

~~~bash
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 doma-tech
~~~

The Compose file binds port 3000 to `127.0.0.1` only. This is intentional: configure a reverse proxy on the same host to forward HTTPS traffic to `http://127.0.0.1:3000`. Do not expose port 3000 directly to the public internet. Configure TLS, request-size limits, security headers, and proxy timeouts at the reverse proxy, then test the forwarded health endpoint.

Check the local health endpoint:

~~~bash
curl --fail http://127.0.0.1:3000/api/health
~~~

Expected response includes `"ok":true`. Also inspect container health:

~~~bash
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q doma-tech)"
~~~

## 4. Updates and rollback

Before an update, create and verify a database backup using the documented backup process. Keep a separate copy of `uploads/` and the protected `.env`; SQLite backups do not contain uploaded images or deployment secrets.

~~~bash
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 doma-tech
~~~

If an update fails, stop the container and roll back to the previously verified image/revision and matching data backup. Do not replace a live SQLite file while the application is running.

## 5. Operations and security checks

- Confirm the container runs as a non-root user.
- Confirm port 3000 is listening only on loopback.
- Confirm the reverse proxy enforces HTTPS and forwards only expected traffic.
- Confirm `.env` and data directories are not readable by unrelated host users.
- Verify backups, offsite copies, and restore drills independently.
- Monitor container health and logs; configure external monitoring for host outages.
- Review privacy, retention, legal notices, and operational controls before accepting real customer data.

## Important limitations

- The public GitHub Pages site remains a static prototype; Docker does not deploy or connect it to this server.
- The protected admin interface is served at `/admin`; it supports login, product CRUD, image uploads, and order status updates. Verify it on a private staging deployment before accepting real customer data.
- Real production deployment, TLS reverse proxy, firewall, credentials, cloud backup, monitoring, and legal compliance are not configured by committing this guide.
- Run this first on a disposable staging host. Do not accept live customer data until the complete application and security review are finished.
