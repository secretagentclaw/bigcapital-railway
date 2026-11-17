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
FROM bigcapitalhq/server:v0.25.44

USER root
WORKDIR /app/packages/server

# 1. Drop the hardcoded object ACL — Railway's bucket rejects the header.
RUN sed -i "s/'public-read'/undefined/g" dist/modules/Attachments/Attachment.module.js \
 && ! grep -q "public-read" dist/modules/Attachments/Attachment.module.js \
 && grep -q "const aclValue = true ? undefined" dist/modules/Attachments/Attachment.module.js

# 2. Trust Railway's edge and the in-project gateway so req.ip is the real client.
RUN sed -i "s|app.set('query parser', 'extended');|app.set('query parser', 'extended'); app.set('trust proxy', ['loopback','linklocal','uniquelocal','100.64.0.0/10','fd00::/8','152.233.0.0/17']);|" dist/main.js \
 && grep -q "trust proxy" dist/main.js

# 3. Workspace delete: remove the tenant's FK children and row before dropping
#    its database, all-or-nothing (upstream drops the data first, then fails on
#    api_keys' FK and leaves a stuck "deleting" workspace with no data). The
#    replaced file is pinned by hash so an upstream change fails the build.
COPY patches/server/DeleteWorkspace.service.js /tmp/DeleteWorkspace.service.js
RUN f=dist/modules/ee/Workspaces/commands/DeleteWorkspace.service.js \
 && echo "a39c9090612b469688582e2d59ba6f3ea6218d2190551c98b36a1e2c5f2779c2  $f" | sha256sum -c - \
 && mv /tmp/DeleteWorkspace.service.js "$f" \
 && node --check "$f" \
 && grep -q "TENANT_CHILD_TABLES" "$f"

# 4. Give the delete pre-checks readable messages (upstream sends null, so the
#    UI can only say "Cannot delete workspace").
RUN f=dist/modules/ee/Workspaces/commands/DeleteWorkspaceJob.service.js \
 && sed -i \
      -e "s/WorkspacesError.WORKSPACE_NOT_FOUND)/WorkspacesError.WORKSPACE_NOT_FOUND, 'Workspace not found')/" \
      -e "s/WorkspacesError.NOT_WORKSPACE_OWNER)/WorkspacesError.NOT_WORKSPACE_OWNER, 'Only the workspace owner can delete it')/" \
      -e "s/WorkspacesError.WORKSPACE_DELETING)/WorkspacesError.WORKSPACE_DELETING, 'This workspace is already being deleted')/" \
      "$f" \
 && grep -q "'Workspace not found'" "$f" \
 && grep -q "'Only the workspace owner can delete it'" "$f" \
 && grep -q "'This workspace is already being deleted'" "$f"

COPY entrypoint.sh /usr/local/bin/bigcapital-entrypoint.sh
RUN chmod 0755 /usr/local/bin/bigcapital-entrypoint.sh \
 && sh -n /usr/local/bin/bigcapital-entrypoint.sh

USER nodejs
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/bigcapital-entrypoint.sh"]
