FROM node:24-alpine AS ui-build
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM golang:1.24-alpine AS go-build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/retro .

FROM scratch
WORKDIR /app
COPY --from=go-build /out/retro /app/retro
COPY --from=ui-build /src/ui/build /app/ui
ENV ADDR=:4120 STATIC_DIR=/app/ui
USER 65532:65532
EXPOSE 4120
ENTRYPOINT ["/app/retro"]
