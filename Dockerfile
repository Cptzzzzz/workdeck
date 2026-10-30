FROM golang:1.25-alpine AS backend
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
ARG WORKDECK_VERSION=dev
RUN --mount=type=cache,target=/root/.cache/go-build mkdir -p /out/downloads /out/data && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -X main.version=${WORKDECK_VERSION}" -o /out/downloads/workdeck-linux-amd64 ./cmd/workdeck && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w -X main.version=${WORKDECK_VERSION}" -o /out/downloads/workdeck-linux-arm64 ./cmd/workdeck && \
    case "$(uname -m)" in x86_64) cp /out/downloads/workdeck-linux-amd64 /out/workdeck ;; aarch64) cp /out/downloads/workdeck-linux-arm64 /out/workdeck ;; *) exit 1 ;; esac && \
    cd /out/downloads && sha256sum workdeck-linux-* > SHA256SUMS

FROM node:22-alpine AS frontend
WORKDIR /src
COPY web/package.json web/package-lock.json web/
COPY scripts/patch-xterm-dom.mjs scripts/
RUN npm ci --prefix web
COPY web/ web/
COPY scripts/install-agent.sh web/public/install-agent.sh
COPY --from=backend /out/downloads/ web/public/downloads/
RUN npm run build --prefix web

FROM scratch
COPY --from=backend /out/workdeck /workdeck
COPY --from=backend --chown=65532:65532 /out/data/ /data/
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=frontend /src/web/dist/ /web/
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY third_party/ /licenses/third_party/
USER 65532:65532
EXPOSE 8090
ENTRYPOINT ["/workdeck", "hub"]
CMD ["--addr=:8090", "--data-dir=/data", "--assets-dir=/web", "--admin-password-file=/run/secrets/admin_password"]
