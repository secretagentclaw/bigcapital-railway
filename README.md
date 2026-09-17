# bigcapital-railway

Deployment image for the [Bigcapital](https://github.com/bigcapitalhq/bigcapital)
API server on [Railway](https://railway.com).

Bigcapital publishes a ready-to-run server image. This repository adds one layer on
top of it for three boot-time concerns that no environment variable can express.

## What the layer does

**Drops the hardcoded object ACL.** The upload pipeline configures `multer-s3` with
a hardcoded `public-read` ACL. Railway's managed object storage rejects the
`x-amz-acl` header outright with `400 InvalidArgument`, so every attachment upload
would fail against an otherwise healthy deployment. The build removes the ACL, and
asserts it is gone — an upstream rename fails the build rather than the deployment.

**Trusts the platform's proxies.** The server never calls `app.set('trust proxy')`,
so `@nestjs/throttler` keys every request on the gateway's container address and the
per-IP throttle on the login route stops bucketing. The build teaches Express about
Railway's edge ranges so `req.ip` is the real caller.

**Applies the system migrations before serving.** Upstream ships these in a separate
one-shot container. Railway has no service ordering, so the entrypoint runs them
itself, retrying until the database is reachable, and only then starts the API.

The entrypoint also defaults the private hostnames of its peers. A
`${{service.RAILWAY_PRIVATE_DOMAIN}}` reference is an empty string until that service
owns a deployment, which is exactly the case when a template brings every service up
at once.

## Configuration

Everything else is upstream's own configuration — see
[`.env.example`](https://github.com/bigcapitalhq/bigcapital/blob/develop/.env.example).
The variables this image reads beyond that list are the ones Railway injects itself
(`PORT`, `RAILWAY_PRIVATE_DOMAIN`).

## Version

The base image tag is pinned in the `Dockerfile` and is bumped together with the
`bigcapitalhq/webapp` tag on the companion service — the SPA and the API are built
from one monorepo and are expected to move in lockstep.

## Licence

Bigcapital is AGPL-3.0. This repository only carries deployment glue.
