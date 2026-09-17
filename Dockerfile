# Bigcapital API server for Railway.
#
# Upstream publishes a ready-to-run image; this layer exists for three boot-time
# concerns that no environment variable can express:
#
#  1. multer-s3 is configured with a hardcoded `public-read` ACL. Railway's managed
#     object storage rejects `x-amz-acl` outright (400 InvalidArgument), so every
#     attachment upload would fail. The ACL is dropped here.
#  2. Express is never told to trust a proxy, so @nestjs/throttler keys every
#     request on the gateway's container address and the per-IP login throttle
#     stops bucketing. Railway's edge ranges are trusted here instead.
#  3. The system migrations have to run before the API serves, from the package
#     directory (knex resolves their path relative to the working directory).
#
# Each patch is asserted in the build, so an upstream rename fails the build
# rather than the deployment.
FROM bigcapitalhq/server:v0.25.41

USER root
WORKDIR /app/packages/server

# 1. Drop the hardcoded object ACL — Railway's bucket rejects the header.
RUN sed -i "s/'public-read'/undefined/g" dist/modules/Attachments/Attachment.module.js \
 && ! grep -q "public-read" dist/modules/Attachments/Attachment.module.js \
 && grep -q "const aclValue = true ? undefined" dist/modules/Attachments/Attachment.module.js

# 2. Trust Railway's edge and the in-project gateway so req.ip is the real client.
RUN sed -i "s|app.set('query parser', 'extended');|app.set('query parser', 'extended'); app.set('trust proxy', ['loopback','linklocal','uniquelocal','100.64.0.0/10','fd00::/8','152.233.0.0/17']);|" dist/main.js \
 && grep -q "trust proxy" dist/main.js

COPY entrypoint.sh /usr/local/bin/bigcapital-entrypoint.sh
RUN chmod 0755 /usr/local/bin/bigcapital-entrypoint.sh \
 && sh -n /usr/local/bin/bigcapital-entrypoint.sh

USER nodejs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/bigcapital-entrypoint.sh"]
