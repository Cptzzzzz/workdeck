FROM scratch
COPY bin/workdeck-linux-amd64 /workdeck
COPY web/dist /web
COPY deploy/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532
EXPOSE 8090
ENTRYPOINT ["/workdeck", "hub"]
CMD ["--addr=:8090", "--public-url=https://work.example.com", "--data-dir=/data", "--assets-dir=/web", "--admin-password-file=/run/secrets/admin_password", "--trusted-proxy-cidr=172.20.0.0/16"]
