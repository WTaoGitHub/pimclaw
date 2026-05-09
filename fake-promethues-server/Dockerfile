# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS builder
WORKDIR /src

COPY go.mod ./
COPY main.go ./
RUN go build -trimpath -ldflags="-s -w" -o /out/fake-prometheus ./main.go

FROM alpine:3.21
RUN adduser -D -u 65532 nonroot
WORKDIR /app
COPY --from=builder /out/fake-prometheus /app/fake-prometheus
USER nonroot

EXPOSE 9090
ENV PORT=9090

ENTRYPOINT ["/app/fake-prometheus"]
