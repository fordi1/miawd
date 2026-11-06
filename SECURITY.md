# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.
Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**.
Include what you found, the steps to reproduce it, and the version or commit.

You can expect an acknowledgement and a fix plan; there is no bug bounty.

## Supported versions

Only the latest commit on `main` is supported.

## For anyone deploying this project

- Generate every secret yourself (`openssl rand -hex 32`); never reuse example values.
- Keep `.env` and `.env.production` out of version control and out of backups that others can read.
- Serve the panels and the API over HTTPS and set `COOKIE_SECURE=true`.
- Never enable `WEBHOOKS_ALLOW_LOCAL` in production.
- If a secret, API key or password was ever exposed, rotate it immediately.
