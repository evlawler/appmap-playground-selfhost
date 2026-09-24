# One image: the AppMap CLI, every report published under reports/ indexed at build time, and a
# small Node server that renders the reports and fronts one query UI per entry. No login, no AI,
# no outbound calls at runtime. Runs as an arbitrary non-root user (OpenShift restricted SCC).
#
#   docker build -t appmap-reports -f app/Dockerfile .
#   docker run -p 8080:8080 appmap-reports
#
FROM node:22-slim

ARG APPMAP_CLI_VERSION=3.204.0
ARG MARKED_VERSION=15.0.12
RUN npm install -g @appland/appmap@${APPMAP_CLI_VERSION} marked@${MARKED_VERSION} && npm cache clean --force

WORKDIR /srv
COPY app/build.js app/server.js app/bar.js app/review.html app/scan.html ./
COPY reports ./reports

# Per entry: one trace directory holding the recordings (a PR review: both sides of the change,
# each stamped base|head so the query UI can compare them; a scan: the default branch), indexed
# at build time, plus the report rendered to HTML and entries.json for the server.
# The CLI keeps each trace directory's query DB under $HOME/.appmap, so HOME is fixed to a
# path inside the image that stays group-writable for whatever UID runs the container.
ENV HOME=/srv/home
RUN mkdir -p /srv/home && node build.js reports build && rm -rf reports \
 && chgrp -R 0 /srv && chmod -R g=u /srv

ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
