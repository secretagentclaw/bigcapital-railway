# Bigcapital webapp for Railway: the stock image plus one fix to the compiled
# bundle (see patch-delete-dialog.js). Build context: this directory.
FROM bigcapitalhq/webapp:v0.25.44 AS upstream

FROM node:22-alpine AS patch
COPY --from=upstream /usr/share/nginx/html/assets /assets
COPY patch-delete-dialog.js /patch-delete-dialog.js
RUN node /patch-delete-dialog.js /assets \
 && for f in /assets/PrivatePages-*.js; do node --check "$f"; done

FROM upstream
COPY --from=patch /assets /usr/share/nginx/html/assets
